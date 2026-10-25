import assert from 'node:assert/strict';
import test from 'node:test';
import { attachDockLayout, computeDockMetrics, dockWidthRange, parseNativeTracks, readDockWidth, DOCK_WIDTH_KEY } from '../src/dock-layout.mjs';

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

function fixture({ frameWidth = 1440, sidebarWidth = 280, tracks = '280px minmax(0, 1fr) 0px', display = 'grid', storage } = {}) {
  const mutations = [], resizes = [];
  const animationFrames = new Map();
  let nextFrame = 1;
  function observer(list) {
    return class {
      constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; list.push(this); }
      observe(target, options) { this.targets.push({ target, options }); }
      disconnect() { this.disconnected = true; }
      fire() { this.callback([]); }
    };
  }
  const view = { getComputedStyle: () => ({ display }), MutationObserver: observer(mutations), ResizeObserver: observer(resizes), localStorage: storage,
    requestAnimationFrame(callback) { const id = nextFrame++; animationFrames.set(id, callback); return id; },
    cancelAnimationFrame(id) { animationFrames.delete(id); },
  };
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
  return { frame, sidebar, center, details, shell, overlay, mutations, resizes, view, animationFrames,
    flushFrames() { const pending = [...animationFrames.values()]; animationFrames.clear(); for (const callback of pending) callback(); },
  };
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

function memoryStorage(initial) {
  const values = new Map(initial === undefined ? [] : [[DOCK_WIDTH_KEY, String(initial)]]);
  const writes = [];
  return { values, writes, getItem: key => values.get(key) ?? null, setItem(key, value) { writes.push([key, value]); values.set(key, value); } };
}

test('saved preferences survive a temporary narrow window and automatic clamps do not overwrite storage', () => {
  const storage = memoryStorage(700);
  const f = fixture({ frameWidth: 1000, storage });
  const dock = attachDockLayout(f.overlay); dock.update({ visible: true });
  assert.equal(dock.getSnapshot().panelWidth, 400);
  assert.equal(dock.getSnapshot().preferredWidth, 700);
  f.frame.width = 1600; f.resizes[0].fire();
  assert.equal(dock.getSnapshot().panelWidth, 700);
  assert.equal(f.center.style.getPropertyValue('--dsh-sc-reserved-width'), '700px');
  assert.deepEqual(storage.writes, []);
  assert.deepEqual(dockWidthRange({ frameWidth: 2200, sidebarWidth: 280 }), { minWidth: 320, maxWidth: 960 });
  dock.dispose();
});

test('pointer resizing uses the rendered clamp, coalesces moves and commits only the final width', () => {
  const storage = memoryStorage(700);
  const f = fixture({ frameWidth: 1000, storage });
  const dock = attachDockLayout(f.overlay); dock.update({ visible: true });
  assert(dock.startResize(4, 600, 400));
  assert.equal(f.frame.getAttribute('data-dsh-sc-resizing'), '');
  assert.equal(dock.startResize(5, 600, 400), false);
  dock.moveResize(5, 700);
  assert.equal(f.animationFrames.size, 0, 'another touch must not resize this drag');
  dock.moveResize(4, 620); dock.moveResize(4, 650);
  assert.equal(f.animationFrames.size, 1);
  assert.equal(dock.getSnapshot().panelWidth, 400, 'wait for one animation frame');
  f.flushFrames();
  assert.equal(dock.getSnapshot().panelWidth, 350, 'movement starts from visible 400px rather than saved 700px');
  assert.equal(f.center.style.getPropertyValue('--dsh-sc-reserved-width'), '350px');
  assert.deepEqual(storage.writes, []);
  dock.moveResize(4, 660);
  dock.endResize(4, 670);
  assert.equal(dock.getSnapshot().panelWidth, 330, 'pointerup flushes its newest coordinate');
  assert.equal(f.animationFrames.size, 0);
  assert.equal(dock.getSnapshot().resizing, false);
  assert.equal(f.frame.getAttribute('data-dsh-sc-resizing'), null);
  assert.deepEqual(storage.writes, [[DOCK_WIDTH_KEY, '330']]);
  dock.dispose();
});

test('cancel, close and dispose retract pending drags without saving or leaking callbacks', () => {
  for (const ending of ['cancel', 'close', 'dispose']) {
    const storage = memoryStorage(600);
    const f = fixture({ storage });
    const dock = attachDockLayout(f.overlay); dock.update({ visible: true });
    let notices = 0; dock.subscribe(() => notices++);
    dock.startResize(3, 900, 600); dock.moveResize(3, 850); f.flushFrames();
    assert.equal(dock.getSnapshot().panelWidth, 650);
    dock.moveResize(3, 800);
    const pending = [...f.animationFrames.values()];
    if (ending === 'cancel') dock.endResize(3, undefined, true);
    if (ending === 'close') dock.update({ visible: false });
    if (ending === 'dispose') dock.dispose();
    assert.equal(f.animationFrames.size, 0);
    assert.equal(f.frame.getAttribute('data-dsh-sc-resizing'), null);
    assert.deepEqual(storage.writes, []);
    const before = notices;
    for (const callback of pending) callback();
    assert.equal(notices, before, 'cancelled frame callbacks may not resume the drag');
    if (ending !== 'dispose') assert.equal(dock.getSnapshot().preferredWidth, 600);
    dock.dispose();
  }
});

test('keyboard resizing follows the right-side boundary, applies runtime limits, and persists choices', () => {
  const storage = memoryStorage(); const f = fixture({ storage });
  const dock = attachDockLayout(f.overlay); dock.update({ visible: true });
  assert(dock.resizeByKey('ArrowLeft')); assert.equal(dock.getSnapshot().panelWidth, 436);
  assert(dock.resizeByKey('ArrowRight', true)); assert.equal(dock.getSnapshot().panelWidth, 388);
  assert(dock.resizeByKey('Home')); assert.equal(dock.getSnapshot().panelWidth, 320);
  assert(dock.resizeByKey('End')); assert.equal(dock.getSnapshot().panelWidth, 840);
  assert.equal(storage.values.get(DOCK_WIDTH_KEY), '840');
  assert.equal(dock.resizeByKey('ArrowUp'), false);
  dock.startResize(1, 600, 840); dock.moveResize(1, 650); f.flushFrames();
  assert(dock.resizeByKey('Escape')); assert.equal(dock.getSnapshot().panelWidth, 840);
  dock.resetWidth(); assert.equal(dock.getSnapshot().panelWidth, 420);
  assert.equal(storage.values.get(DOCK_WIDTH_KEY), '420');
  dock.update({ visible: false }); assert.equal(dock.resizeByKey('ArrowLeft'), false);
  dock.dispose();
});

test('native details limits avoid a blank gap, and focus clicks do not overwrite a clamped preference', () => {
  const storage = memoryStorage(700); const f = fixture({ frameWidth: 1000, storage });
  const dock = attachDockLayout(f.overlay); dock.update({ visible: true });
  dock.startResize(1, 400, 400); dock.endResize(1, 400);
  assert.equal(dock.getSnapshot().preferredWidth, 700);
  assert.deepEqual(storage.writes, []);
  f.frame.width = 1600; f.frame.style.gridTemplateColumns = '280px minmax(0px, 1fr) 520px'; f.mutations[0].fire();
  assert(dock.resizeByKey('Home'));
  assert.equal(dock.getSnapshot().panelWidth, 520);
  assert.equal(f.center.style.getPropertyValue('--dsh-sc-reserved-width'), '0px');
  dock.resetWidth(); assert.equal(dock.getSnapshot().panelWidth, 520);
  assert.equal(storage.values.get(DOCK_WIDTH_KEY), '420', 'reset saves the default preference even when native details temporarily require more room');
  dock.dispose();
});

test('invalid or blocked local storage falls back safely and cannot prevent resize operations', () => {
  for (const value of [null, '', '0', '-1', 'NaN', 'Infinity', '{}', '1e9']) assert.equal(readDockWidth({ getItem: () => value }), 420);
  assert.equal(readDockWidth({ getItem: () => '480' }), 480);
  assert.equal(readDockWidth({ getItem: () => '99999' }), 960);
  assert.equal(readDockWidth({ getItem() { throw new Error('blocked'); } }), 420);
  const f = fixture({ storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); } } });
  const dock = attachDockLayout(f.overlay); dock.update({ visible: true });
  assert.doesNotThrow(() => dock.resizeByKey('ArrowLeft'));
  assert.equal(dock.getSnapshot().panelWidth, 436);
  dock.dispose();
  const second = fixture(); Object.defineProperty(second.view, 'localStorage', { get() { throw new Error('denied'); } });
  assert.doesNotThrow(() => attachDockLayout(second.overlay).dispose());
});
