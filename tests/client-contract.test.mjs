import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Exercise the real integration, replacing only the independently tested Panel.
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/client.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'browser', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'native-contract-stubs', setup(builder) {
    builder.onResolve({ filter: /\.\/Panel\.jsx$/ }, () => ({ path: 'Panel', namespace: 'test-panel' }));
    builder.onLoad({ filter: /.*/, namespace: 'test-panel' }, () => ({ loader: 'js', contents: 'export default function Panel(){return null}' }));
    builder.onLoad({ filter: /\.css$/ }, () => ({ loader: 'js', contents: '' }));
  } }],
});

function harness({ current = 'main', blank = false, noCurrent = false, items, connect, deferredNotifications = false } = {}) {
  const module = { exports: {} };
  const jsx = (type, props, key) => ({ type, props, key });
  vm.runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, queueMicrotask,
    require: specifier => {
      assert(['react', 'react/jsx-runtime'].includes(specifier));
      return { jsx, jsxs: jsx };
    },
  });
  let sessions = { phase: 'ready', current: noCurrent ? undefined : current, byId: { main: { id: 'main', blank, updatedAt: 10 } } };
  let workspaces = { phase: 'ready', items: items ?? [{ workspaceId: 'project', path: 'C:/project', sessionIds: ['main'], createdAt: '2026-01-01' }] };
  const subscribers = new Set();
  const originalDetails = { options: { name: 'details', priority: 0 }, component: () => null };
  const entries = new Set([originalDetails]);
  const cleanups = [], calls = [], selected = [], connected = [];
  let opened = 0, closed = 0;
  let response = { ok: true, value: { accepted: true } };
  const notify = () => { for (const listener of subscribers) listener(); };
  const ctx = {
    slots: {
      inject: (_key, install) => install(),
      register(options, component) {
        const entry = { options, component }; entries.add(entry);
        return () => entries.delete(entry);
      },
    },
    sessions: {
      list: { getSnapshot: () => sessions, subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn); } },
      open(id) { selected.push(id); sessions = { ...sessions, current: id }; if (!deferredNotifications) notify(); },
    },
    workspaces: { list: { getSnapshot: () => workspaces } },
    uiWorkspace: { async connectWorkspace(id) {
      connected.push(id);
      const result = await (connect?.(id) ?? 'empty-project');
      sessions = { ...sessions, byId: { ...sessions.byId, [result]: { id: result, blank: true } } };
      return result;
    } },
    layout: { openDetails: () => opened++, closeDetails: () => closed++ },
    connection: { rpc: { call: async (...args) => { calls.push(args); return response; } } },
    effect: body => cleanups.push(body()),
  };
  module.exports.apply(ctx);
  const overlay = [...entries].find(entry => entry.options.id === 'dsh-sidecar-overlay');
  const header = [...entries].find(entry => entry.options.id === 'dsh-sidecar-toolbar');
  assert(overlay && header);
  const face = overlay.options.inject();
  const state = () => face.hooks.sidecarState.getSnapshot();
  const activeDetails = () => [...entries].filter(entry => entry.options.name === 'details').sort((a, b) => (a.options.priority || 0) - (b.options.priority || 0))[0];
  return {
    entries, originalDetails, overlay, header, face, state, activeDetails, calls, selected, connected,
    opened: () => opened, closed: () => closed, notify,
    setResponse: value => { response = value; },
    setSessions(value) { sessions = { ...sessions, ...value }; notify(); },
    setWorkspaces(value) { workspaces = { ...workspaces, ...value }; },
    renderOverlay: () => overlay.component({ ...face, useSidecarState: selector => selector(state()) }),
    renderHeader: () => header.component({ ...header.options.inject(), useSidecarState: selector => selector(state()) }),
    cleanup: async () => { for (const dispose of cleanups.toReversed()) await dispose(); },
  };
}

test('home toolbar is globally registered and opens files before the first main message', async () => {
  const h = harness({ blank: true });
  assert.equal(h.overlay.options.name, 'shell.overlay');
  assert.equal(h.header.options.name, 'conversation.session.header.utilities');
  assert.equal(h.header.options.order, 10000);
  assert.equal(h.renderHeader(), null);
  assert(h.renderOverlay().props.children[0], 'blank home needs a global toolbar');
  await h.face.onTool('files');
  assert.equal(h.state().visible, true);
  assert.equal(h.state().toolIntent.tool, 'files');
  assert.equal(h.state().mainSessionId, 'main');
  assert.equal(h.activeDetails(), h.originalDetails, 'blank home does not rely on the zero-width native details column');
  assert.equal(h.opened(), 0);
  assert.equal(h.calls.length, 0, 'opening a tool never sends a prompt');
  assert.equal(h.selected.length, 0, 'existing main selection is retained');
  await h.cleanup();
});

test('nonblank native column is reversible and returns the original details contribution', async () => {
  const h = harness();
  assert(h.renderHeader());
  await h.face.onToggle();
  assert.equal(h.opened(), 1);
  assert.equal(h.renderHeader(), null, 'open panel has only one global toolbar');
  assert.notEqual(h.activeDetails(), h.originalDetails);
  assert(h.entries.has(h.originalDetails));
  h.activeDetails().options.inject().onWidth(512);
  assert.equal(h.state().width, 512);
  h.face.onClose();
  assert.equal(h.activeDetails(), h.originalDetails);
  assert.equal(h.state().visible, false);
  assert.equal(h.closed(), 1);
  assert(h.renderHeader());
  await h.cleanup();
});

test('changing tools or blank status preserves the panel element and does not replay new-sidechat', async () => {
  const h = harness({ blank: true });
  await h.face.onTool('chat', 'new-sidechat');
  const initialIntent = h.state().toolIntent;
  const panelBefore = h.renderOverlay().props.children[1].props.children[1];
  h.setSessions({ byId: { main: { id: 'main', blank: false } } });
  const panelAfter = h.renderOverlay().props.children[1].props.children[1];
  assert.equal(h.state().toolIntent, initialIntent);
  assert.equal(panelBefore.type, panelAfter.type);
  assert.equal(panelBefore.key, panelAfter.key);
  assert.equal(h.state().visible, true);
  assert.equal(h.opened(), 1);
  await h.face.onTool('terminal');
  assert.equal(h.state().toolIntent.tool, 'terminal');
  assert.equal(h.state().toolIntent.action, undefined);
  assert(h.state().toolIntent.sequence > initialIntent.sequence);
  h.setSessions({ current: 'different', byId: { different: { id: 'different', blank: false } } });
  assert.equal(h.state().toolIntent, undefined, 'new-sidechat cannot replay into another main');
  assert.equal(h.state().visible, false);
  assert.equal(h.activeDetails(), h.originalDetails);
  await h.cleanup();
});

test('empty selection reuses public workspace navigation and supports batched DSH stores', async () => {
  const h = harness({ noCurrent: true, deferredNotifications: true });
  await h.face.onTool('chat', 'new-sidechat');
  assert.deepEqual(h.connected, ['project']);
  assert.deepEqual(h.selected, ['empty-project']);
  assert.equal(h.state().mainSessionId, 'empty-project');
  assert.equal(h.state().toolIntent.action, 'new-sidechat');
  h.notify();
  assert.equal(h.state().visible, true, 'later batched notification must not cancel our own navigation');
  assert.equal(h.state().toolIntent.action, 'new-sidechat');
  assert.equal(h.calls.length, 0);
  await h.cleanup();
});

test('navigation or close during a pending workspace connect cannot hijack the main selection', async () => {
  for (const cancel of ['navigate', 'close', 'dispose']) {
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const h = harness({ noCurrent: true, connect: () => pending });
    const opening = h.face.onTool('chat', 'new-sidechat');
    await h.face.onTool('chat', 'new-sidechat');
    assert.equal(h.connected.length, 1, 'pending repeated clicks are coalesced');
    if (cancel === 'navigate') h.setSessions({ current: 'main' });
    if (cancel === 'close') h.face.onClose();
    if (cancel === 'dispose') await h.cleanup();
    resolve('late-empty');
    await opening;
    assert.deepEqual(h.selected, []);
    assert.equal(h.state().toolIntent, undefined);
    if (cancel !== 'dispose') await h.cleanup();
  }
});

test('missing or loading workspace gives a usable hint without creating anything', async () => {
  const h = harness({ noCurrent: true, items: [] });
  await h.face.onTool('files');
  assert.match(h.state().error, /添加工作区/);
  assert.equal(h.state().busy, false);
  assert.equal(h.state().visible, true);
  assert.deepEqual(h.connected, []);
  h.setWorkspaces({ phase: 'pending' });
  await h.face.onTool('browser');
  assert.match(h.state().error, /加载/);
  await h.cleanup();
});

test('RPC uses the authenticated channel and preserves cancellation and backend errors', async () => {
  const h = harness();
  const controller = new AbortController();
  const payload = { mainSessionId: 'main', sessionId: 'side' };
  const value = { id: 'side', messages: [] };
  h.setResponse({ ok: true, value });
  assert.equal(await h.face.api.call('conversation/get', payload, controller.signal), value);
  assert.deepEqual(h.calls[0], ['/sidecar-api', 'conversation/get', payload, controller.signal]);
  const details = { sessionId: 'side' };
  h.setResponse({ ok: false, error: { code: 'sidecar/session-not-found', message: 'Side conversation no longer exists.', details } });
  await assert.rejects(h.face.api.call('conversation/get', {}), error => {
    assert.equal(error.message, 'Side conversation no longer exists.');
    assert.equal(error.code, 'sidecar/session-not-found');
    assert.equal(error.details, details);
    return true;
  });
  await h.cleanup();
});
