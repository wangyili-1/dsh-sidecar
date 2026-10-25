import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/WorkspacePanel.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'browser', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], loader: { '.css': 'empty' },
  plugins: [{ name: 'surface-fixture', setup(builder) {
    builder.onResolve({ filter: /\.\/Panel\.jsx$/ }, () => ({ path: 'Surface', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: 'export default function Surface(){return null}' }));
  } }],
});

function harness({ intent, strict = false, sidechats = [], create } = {}) {
  const slots = [], pending = new Set(), calls = [], timers = [];
  let cursor = 0, dirty = false, tree, props, ordinal = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const slot = initial => slots[cursor] || (slots[cursor] = initial());
  const react = {
    useRef(value) { const item = slot(() => ({ current: value })); cursor++; return item; },
    useState(value) {
      const item = slot(() => ({ value: typeof value === 'function' ? value() : value })); cursor++;
      item.set ||= next => { const value = typeof next === 'function' ? next(item.value) : next; if (!Object.is(value, item.value)) { item.value = value; dirty = true; } };
      return [item.value, item.set];
    },
    useReducer(reducer, value, init) {
      const item = slot(() => ({ value: init ? init(value) : value })); cursor++;
      item.dispatch ||= action => { const next = reducer(item.value, action); if (next !== item.value) { item.value = next; dirty = true; } };
      return [item.value, item.dispatch];
    },
    useMemo(fn, deps) { const item = slot(() => ({})); cursor++; if (!same(item.deps, deps)) { item.value = fn(); item.deps = deps; } return item.value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(run, deps) { const item = slot(() => ({ effect: true })); cursor++; if (!same(item.deps, deps)) pending.add(item); item.run = run; item.deps = deps; },
    useLayoutEffect(run, deps) { return react.useEffect(run, deps); },
    useId() { return react.useMemo(() => 'workspace-fixture', []); },
  };
  const jsx = (type, props, key) => ({ type, props, key });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, queueMicrotask,
    setInterval: () => 1, clearInterval() {},
    setTimeout: run => { timers.push(run); return timers.length; }, clearTimeout() {},
    require: name => name === 'react' ? react : { jsx, jsxs: jsx },
  });
  const api = { async call(endpoint, payload) {
    calls.push({ endpoint, payload });
    if (endpoint === 'state') return { main: { title: 'Main' }, sidechats };
    if (endpoint === 'sidechat/create') return create ? create() : { id: `side-${++ordinal}`, title: `Side ${ordinal}` };
    throw new Error(`Unexpected shell RPC: ${endpoint}`);
  } };
  const visit = (value, callback) => {
    if (Array.isArray(value)) return value.forEach(child => visit(child, callback));
    if (!value || typeof value !== 'object') return;
    callback(value); visit(value.props?.children, callback);
  };
  const nodes = predicate => { const result = []; visit(tree, node => { if (predicate(node)) result.push(node); }); return result; };
  function render(next = props?.toolIntent ?? intent) {
    props = { api, mainSessionId: 'main-fixture', toolIntent: next };
    cursor = 0; dirty = false;
    const session = module.exports.default(props);
    tree = session.type(session.props);
    for (const item of pending) { item.cleanup?.(); item.cleanup = item.run(); }
    pending.clear();
  }
  render();
  if (strict) {
    for (const item of slots) if (item?.effect) item.cleanup?.();
    for (const item of slots) if (item?.effect) item.cleanup = item.run();
  }
  return {
    calls, render, nodes, geometry: module.exports.workspaceDropTarget,
    async flush() { for (let pass = 0; pass < 20; pass++) { await Promise.resolve(); if (dirty) render(); } },
    find(predicate) { const matching = nodes(predicate); assert.equal(matching.length, 1, 'Expected exactly one matching UI node'); return matching[0]; },
    surfaces() { return nodes(node => node.props?.className === 'dsh-ws-surface'); },
    unmount() { for (const item of slots) if (item?.effect) item.cleanup?.(); },
    runTimers() { for (const timer of timers.splice(0)) timer(); },
  };
}

const label = value => node => node.props?.['aria-label'] === value;
const text = value => node => node.props?.role === 'menuitem' && node.props.children?.includes?.(value);
const surfaceOf = (h, kind) => h.surfaces().filter(node => node.props.children.props.surface === kind);
async function menu(h, group = 'top') { h.find(label(group === 'top' ? '新建顶部标签' : '新建底部标签')).props.onClick(); await h.flush(); }

test('drop geometry distinguishes tab insertion from lower split and rejects outside drops', () => {
  const h = harness();
  const geometry = { bounds: { left: 100, right: 520, top: 0, bottom: 900 }, bars: [{ left: 100, right: 520, top: 0, bottom: 52, group: 'top', tabs: [{ left: 100, right: 200 }, { left: 203, right: 303 }] }], total: 2, split: false };
  assert.equal(h.geometry({ ...geometry, x: 140, y: 20 }).index, 0);
  assert.equal(h.geometry({ ...geometry, x: 280, y: 20 }).index, 2);
  assert.equal(h.geometry({ ...geometry, x: 250, y: 800 }).to, 'bottom');
  assert.equal(h.geometry({ ...geometry, x: 250, y: 800, total: 1 }).to, 'top');
  assert.equal(h.geometry({ ...geometry, x: 80, y: 800 }), null);
  h.unmount();
});

test('two web tabs retain stable surface parents and keys through split, close and restore', async () => {
  const h = harness(); await h.flush();
  assert.equal(surfaceOf(h, 'files').length, 0, 'opening the workspace should start with a blank web page');
  assert.equal(surfaceOf(h, 'browser')[0].key, 'web-start');
  assert(h.find(label('关闭标签 新标签页')));
  await menu(h);
  assert.equal(h.nodes(text('文件')).length, 0);
  assert.equal(h.nodes(text('终端')).length, 0);
  h.find(text('新建网页')).props.onClick(); await h.flush();
  const before = surfaceOf(h, 'browser');
  assert.equal(before.length, 2);
  assert.notEqual(before[0].key, before[1].key);
  assert.equal(before[0].props.hidden, true);
  const active = before[1];
  h.find(label('上下分屏')).props.onClick(); await h.flush();
  const split = h.surfaces().find(node => node.key === active.key);
  assert.equal(split.props['data-ws-pane-content'], 'bottom');
  assert.equal(split.props.children.type, active.props.children.type);
  assert.equal(split.key, active.key);
  const title = h.nodes(node => node.props?.role === 'tab' && node.props['data-ws-tab-id'] === active.key)[0].props.children[1].props.children;
  h.find(label(`关闭标签 ${title}`)).props.onClick(); await h.flush();
  assert.equal(h.surfaces().find(node => node.key === active.key).props.hidden, true);
  await menu(h); h.find(label(`恢复标签 ${title}`)).props.onClick(); await h.flush();
  assert.equal(h.surfaces().find(node => node.key === active.key).props.hidden, false);
  assert.equal(surfaceOf(h, 'browser').length, 2, 'restoring must not create another iframe surface');
  h.unmount();
});

test('pointer capture drag commits a real split without remounting the source surface', async () => {
  const h = harness(); await h.flush();
  await menu(h); h.find(text('新建网页')).props.onClick(); await h.flush();
  const web = surfaceOf(h, 'browser').at(-1);
  const tab = h.find(node => node.props?.['data-ws-tab-id'] === web.key);
  const bounds = { left: 100, right: 520, top: 0, bottom: 900, height: 900 };
  h.find(node => node.props?.className === 'dsh-ws-grid').props.ref.current = { getBoundingClientRect: () => bounds, querySelectorAll: () => [] };
  const pointer = { captured: false, setPointerCapture() { this.captured = true; }, hasPointerCapture() { return this.captured; }, releasePointerCapture() { this.captured = false; } };
  tab.props.onPointerDown({ button: 0, pointerId: 4, clientX: 220, clientY: 20, currentTarget: pointer });
  tab.props.onPointerMove({ pointerId: 4, clientX: 260, clientY: 780, preventDefault() {} });
  await h.flush();
  assert(h.nodes(node => node.props?.className === 'dsh-ws-drop-preview is-bottom').length);
  tab.props.onPointerUp({ pointerId: 4 }); await h.flush();
  assert.equal(h.surfaces().find(node => node.key === web.key).props['data-ws-pane-content'], 'bottom');
  assert.equal(h.surfaces().find(node => node.key === web.key).props.children.type, web.props.children.type);
  assert.equal(pointer.captured, false);
  h.unmount();
});

test('external new-sidechat intent creates once under StrictMode and keeps fixed identities separate', async () => {
  const intent = { sequence: 1, tool: 'chat', action: 'new-sidechat' };
  const h = harness({ intent, strict: true }); await h.flush();
  h.render({ ...intent }); await h.flush();
  assert.equal(h.calls.filter(call => call.endpoint === 'sidechat/create').length, 1);
  h.render({ sequence: 2, tool: 'chat', action: 'new-sidechat' }); await h.flush();
  const chats = surfaceOf(h, 'chat');
  assert.equal(chats.length, 2);
  assert.notEqual(chats[0].props.children.props.fixedSidechat.id, chats[1].props.children.props.fixedSidechat.id);
  assert(!h.calls.some(call => call.endpoint.endsWith('/send')));
  h.unmount();
});

test('continuing chat without history opens choices without creating or sending', async () => {
  const h = harness({ intent: { sequence: 8, tool: 'chat' } }); await h.flush();
  assert(h.find(text('新建侧聊')));
  assert.equal(surfaceOf(h, 'chat').length, 0);
  assert(!h.calls.some(call => call.endpoint === 'sidechat/create' || call.endpoint.endsWith('/send')));
  h.unmount();
});

test('explicit context-carrying creation retains the requested backend flag', async () => {
  const h = harness(); await h.flush();
  await menu(h); h.find(label('新建侧聊（带主任务上下文）')).props.onClick(); await h.flush();
  const request = h.calls.find(call => call.endpoint === 'sidechat/create');
  assert.equal(request.payload.includeContext, true);
  assert.equal(request.payload.mainSessionId, 'main-fixture');
  h.unmount();
});

test('tool citations route to one owned chat with unique packet ids and failure remains rejectable', async () => {
  const h = harness({ intent: { sequence: 1, tool: 'files' }, sidechats: [{ id: 'existing', title: 'Existing' }] }); await h.flush();
  const files = surfaceOf(h, 'files')[0].props.children;
  await files.props.onPacket({ kind: 'file', source: 'one.py', text: 'one' }); await h.flush();
  await files.props.onPacket({ kind: 'web', source: 'https://example.invalid/', text: 'two' }); await h.flush();
  const chat = surfaceOf(h, 'chat')[0].props.children;
  assert.equal(chat.props.fixedSidechat.id, 'existing');
  assert.equal(chat.props.packets.length, 2);
  assert.notEqual(chat.props.packets[0]._id, chat.props.packets[1]._id);
  assert(!h.calls.some(call => call.endpoint === 'sidechat/create'));
  h.unmount();
  const failed = harness({ intent: { sequence: 1, tool: 'files' }, create: () => { throw new Error('fixture failure'); } }); await failed.flush();
  await assert.rejects(surfaceOf(failed, 'files')[0].props.children.props.onPacket({ kind: 'file', source: 'keep.py', text: 'keep' }), /引用内容仍保留/);
  failed.unmount();
});
