import assert from 'node:assert/strict';
import test from 'node:test';
import { attachDockLayout, computeDockMetrics, parseNativeTracks } from '../src/dock-layout.mjs';

test('blank home reserves the full dock, while native conversation tracks supply their share', () => {
  assert.deepEqual(computeDockMetrics({ frameWidth: 1440, sidebarWidth: 280, visible: true }), { panelWidth: 420, reservedWidth: 420 });
  assert.deepEqual(computeDockMetrics({ frameWidth: 1440, sidebarWidth: 280, detailsWidth: 360, visible: true }), { panelWidth: 420, reservedWidth: 60 });
  assert.deepEqual(computeDockMetrics({ frameWidth: 1440, sidebarWidth: 280, detailsWidth: 520, visible: true }), { panelWidth: 520, reservedWidth: 0 });
  assert.deepEqual(computeDockMetrics({ frameWidth: 1440, sidebarWidth: 280, visible: false }), { panelWidth: 420, reservedWidth: 0 });
});

test('responsive reservation keeps navigation uncovered and useful main width whenever feasible', () => {
  for (const frameWidth of [300, 500, 700, 800, 1000, 1440]) {
    for (const sidebarWidth of [56, 280, 420]) {
      const { panelWidth, reservedWidth } = computeDockMetrics({ frameWidth, sidebarWidth, visible: true });
      const available = Math.max(0, frameWidth - sidebarWidth);
      assert(panelWidth >= 0 && panelWidth <= available);
      assert.equal(panelWidth, reservedWidth);
      const mainMinimum = frameWidth <= 700 ? 240 : 320;
      if (available >= mainMinimum) assert(available - panelWidth >= mainMinimum);
      if (available >= mainMinimum + 280) assert(panelWidth >= 280);
    }
  }
  assert.deepEqual(computeDockMetrics({ frameWidth: 500, sidebarWidth: 56, visible: true }), { panelWidth: 204, reservedWidth: 204 });
});

test('native track parsing rejects unknown layout structures instead of guessing columns', () => {
  assert.deepEqual(parseNativeTracks('280px minmax(0, 1fr) 360px'), { sidebar: 280, details: 360 });
  assert.deepEqual(parseNativeTracks('56.5px minmax(0px,1fr) 0px'), { sidebar: 56.5, details: 0 });
  for (const value of ['1fr 1fr', '280px 1fr 360px', '280px minmax(100px,1fr) 360px', 'var(--sidebar) minmax(0,1fr) 360px', 'none']) assert.equal(parseNativeTracks(value), undefined);
});

function fixture({ frameWidth = 1440, sidebarWidth = 280, tracks = '280px minmax(0, 1fr) 0px', display = 'grid' } = {}) {
  const mutations = [], resizes = [];
  function observer(list) {
    return class {
      constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; list.push(this); }
      observe(target, options) { this.targets.push({ target, options }); }
      disconnect() { this.disconnected = true; }
      fire() { this.callback([]); }
    };
  }
  const view = { getComputedStyle: () => ({ display }), MutationObserver: observer(mutations), ResizeObserver: observer(resizes) };
  function element(width = 0) {
    const attributes = new Map();
    const properties = new Map();
    return {
      ownerDocument: { defaultView: view }, parentElement: null, previousElementSibling: null,
      width, style: {
        gridTemplateColumns: '',
        getPropertyValue: key => properties.get(key)?.value || '',
        getPropertyPriority: key => properties.get(key)?.priority || '',
        setProperty: (key, value, priority = '') => properties.set(key, { value, priority }),
        removeProperty: key => properties.delete(key),
      },
      getAttribute: key => attributes.has(key) ? attributes.get(key) : null,
      setAttribute: (key, value) => attributes.set(key, String(value)),
      removeAttribute: key => attributes.delete(key),
      getBoundingClientRect() { return { width: this.width }; },
    };
  }
  const frame = element(frameWidth), sidebar = element(sidebarWidth), center = element(), details = element(), shell = element(), overlay = element();
  frame.style.gridTemplateColumns = tracks;
  for (const node of [sidebar, center, details, shell]) node.parentElement = frame;
  center.previousElementSibling = sidebar; details.previousElementSibling = center; shell.previousElementSibling = details;
  overlay.parentElement = shell;
  shell.contains = node => node === shell || node === overlay;
  overlay.closest = selector => selector === '[data-shell-overlay]' ? shell : null;
  return { frame, sidebar, center, details, shell, overlay, mutations, resizes };
}

test('adapter follows native target tracks and resize without writing DSH tracks or observing itself', () => {
  const f = fixture();
  const dock = attachDockLayout(f.overlay);
  dock.update({ visible: true });
  assert.equal(f.center.style.getPropertyValue('--dsh-sc-reserved-width'), '420px');
  assert.equal(f.overlay.style.getPropertyValue('--dsh-sc-panel-width'), '420px');
  assert.equal(f.frame.getAttribute('data-dsh-sc-docked'), '');
  assert.deepEqual(f.mutations[0].targets[0].options, { attributes: true, attributeFilter: ['style'] });
  assert.equal(f.mutations[0].targets[0].target, f.frame);

  f.frame.style.gridTemplateColumns = '280px minmax(0, 1fr) 360px';
  f.mutations[0].fire();
  assert.equal(f.center.style.getPropertyValue('--dsh-sc-reserved-width'), '60px');
  assert.equal(f.frame.style.gridTemplateColumns, '280px minmax(0, 1fr) 360px');

  f.frame.width = 1000; f.frame.style.gridTemplateColumns = '280px minmax(0, 1fr) 0px';
  f.resizes[0].fire();
  assert.equal(f.overlay.style.getPropertyValue('--dsh-sc-panel-width'), '400px');
  assert.equal(f.center.style.getPropertyValue('--dsh-sc-reserved-width'), '400px');
  dock.update({ visible: false });
  assert.equal(f.center.style.getPropertyValue('--dsh-sc-reserved-width'), '0px');
  assert.equal(f.frame.getAttribute('data-dsh-sc-docked'), null);
  // Keep the center marker at zero so CSS can animate the closing reservation.
  assert.equal(f.center.getAttribute('data-dsh-sc-center'), '');
  dock.dispose();
});

test('sidebar animation is measured conservatively and changing its box releases available width', () => {
  const f = fixture({ frameWidth: 900 });
  const dock = attachDockLayout(f.overlay); dock.update({ visible: true });
  assert.equal(f.overlay.style.getPropertyValue('--dsh-sc-panel-width'), '300px');
  f.frame.style.gridTemplateColumns = '56px minmax(0, 1fr) 0px';
  f.mutations[0].fire();
  assert.equal(f.overlay.style.getPropertyValue('--dsh-sc-panel-width'), '300px', 'target alone must not cover still-expanded navigation');
  f.sidebar.width = 56; f.resizes[0].fire();
  assert.equal(f.overlay.style.getPropertyValue('--dsh-sc-panel-width'), '420px');
  dock.dispose();
});

test('dispose restores only owned attributes and variables, disconnects observers, and is idempotent', () => {
  const f = fixture();
  f.center.setAttribute('data-dsh-sc-center', 'existing-center');
  f.frame.setAttribute('data-dsh-sc-docked', 'existing-frame');
  f.center.style.setProperty('--dsh-sc-reserved-width', '7px', 'important');
  f.center.style.setProperty('background', 'red');
  const dock = attachDockLayout(f.overlay); dock.update({ visible: true }); dock.dispose(); dock.dispose();
  assert.equal(f.center.getAttribute('data-dsh-sc-center'), 'existing-center');
  assert.equal(f.frame.getAttribute('data-dsh-sc-docked'), 'existing-frame');
  assert.equal(f.center.style.getPropertyValue('--dsh-sc-reserved-width'), '7px');
  assert.equal(f.center.style.getPropertyPriority('--dsh-sc-reserved-width'), 'important');
  assert.equal(f.overlay.style.getPropertyValue('--dsh-sc-panel-width'), '');
  assert.equal(f.center.style.getPropertyValue('background'), 'red');
  assert(f.mutations[0].disconnected && f.resizes[0].disconnected);
  dock.update({ visible: true }); f.mutations[0].fire(); f.resizes[0].fire();
  assert.equal(f.center.style.getPropertyValue('--dsh-sc-reserved-width'), '7px', 'late callbacks must not leak mutations');
});

test('unknown or changed shell structure is not mutated and active reservations are retracted', () => {
  for (const options of [{ display: 'flex' }, { tracks: '1fr 1fr' }]) {
    const f = fixture(options); const dock = attachDockLayout(f.overlay); dock.update({ visible: true });
    assert.equal(f.center.getAttribute('data-dsh-sc-center'), null);
    assert.equal(f.mutations.length, 0);
  }
  const f = fixture(); const dock = attachDockLayout(f.overlay); dock.update({ visible: true });
  f.center.parentElement = null; f.resizes[0].fire();
  assert.equal(f.center.style.getPropertyValue('--dsh-sc-reserved-width'), '');
  assert.equal(f.frame.getAttribute('data-dsh-sc-docked'), null);
  assert(f.mutations[0].disconnected && f.resizes[0].disconnected);
});
