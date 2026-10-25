import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/Panel.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'browser', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], loader: { '.css': 'empty' },
});

// Exercise the real component's closures with deterministic hook commits and
// effect replay. This is a lifecycle contract harness, not a browser renderer.
function harness({ intent, strict = false, sidechats = [], create } = {}) {
  const hooks = [];
  const pending = new Set();
  const calls = [];
  let cursor = 0;
  let dirty = false;
  let tree;
  let props;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const slot = (init) => hooks[cursor] || (hooks[cursor] = init());
  const react = {
    useRef(value) { const entry = slot(() => ({ current: value })); cursor++; return entry; },
    useState(value) {
      const entry = slot(() => ({ value: typeof value === 'function' ? value() : value })); cursor++;
      return [entry.value, (next) => { entry.value = typeof next === 'function' ? next(entry.value) : next; dirty = true; }];
    },
    useMemo(fn, deps) {
      const entry = slot(() => ({})); cursor++;
      if (!same(entry.deps, deps)) { entry.value = fn(); entry.deps = deps; }
      return entry.value;
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(run, deps) {
      const entry = slot(() => ({ effect: true })); cursor++;
      if (!same(entry.deps, deps)) pending.add(entry);
      entry.run = run; entry.deps = deps;
    },
    useId() { return react.useMemo(() => `id-${cursor}`, []); },
    useSyncExternalStore(_subscribe, snapshot) { cursor++; return snapshot(); },
  };
  const jsx = (type, value, key) => ({ type, props: value, key });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, queueMicrotask, URL,
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    require: (specifier) => specifier === 'react' ? react : { jsx, jsxs: jsx },
  });
  const api = { async call(endpoint, payload) {
    calls.push({ endpoint, payload });
    if (endpoint === 'state') return { main: { title: 'Main' }, sidechats };
    if (endpoint === 'files/list') return { path: '.', entries: [] };
    if (endpoint === 'conversation/get') return { id: payload.sessionId, title: 'Side', messages: [] };
    if (endpoint === 'sidechat/create') return create ? create() : { id: 'created-side', title: 'Created' };
    throw new Error(`Unexpected API call: ${endpoint}`);
  } };
  const visit = (value, fn) => {
    if (Array.isArray(value)) return value.forEach((child) => visit(child, fn));
    if (!value || typeof value !== 'object') return;
    fn(value);
    visit(value.props?.children, fn);
  };
  function render(nextIntent = props?.toolIntent ?? intent) {
    props = { api, mainSessionId: 'main', toolIntent: nextIntent };
    cursor = 0; dirty = false;
    const session = module.exports.default(props);
    tree = session.type(session.props);
    visit(tree, (node) => {
      if (typeof node.type !== 'string' || !node.props?.ref) return;
      const ref = node.props.ref;
      ref.current ||= { focused: 0, focus() { this.focused++; } };
      ref.current.disabled = Boolean(node.props.disabled);
    });
    for (const entry of pending) { entry.cleanup?.(); entry.cleanup = entry.run(); }
    pending.clear();
  }
  render();
  if (strict) {
    for (const entry of hooks) if (entry?.effect) entry.cleanup?.();
    for (const entry of hooks) if (entry?.effect) entry.cleanup = entry.run();
  }
  return {
    calls, render,
    async flush() { for (let i = 0; i < 12; i++) { await Promise.resolve(); if (dirty) render(); } },
    find(predicate) { let result; visit(tree, (node) => { if (predicate(node)) result = node; }); assert(result, 'Expected UI element'); return result; },
    unmount() { for (const entry of hooks) if (entry?.effect) entry.cleanup?.(); },
  };
}

const byLabel = (label) => (node) => node.props?.['aria-label'] === label;

test('external new-sidechat creates once after StrictMode replay and selects the result without sending', async () => {
  const intent = { sequence: 1, tool: 'chat', action: 'new-sidechat' };
  const h = harness({ intent, strict: true });
  await h.flush();
  h.render({ ...intent });
  await h.flush();
  assert.equal(h.calls.filter(({ endpoint }) => endpoint === 'sidechat/create').length, 1);
  assert.equal(h.find(byLabel('选择侧聊会话')).props.value, 'created-side');
  assert.equal(h.find(byLabel('侧聊消息输入')).props.ref.current.focused, 1);
  assert(!h.calls.some(({ endpoint }) => endpoint.endsWith('/send')));
  h.unmount();
});

test('tool switching retains command, sidechat draft and pending web context', async () => {
  const h = harness({ sidechats: [{ id: 'existing-side', title: 'Existing' }] });
  await h.flush();
  h.find(byLabel('侧聊消息输入')).props.onChange({ target: { value: 'draft survives' } });
  h.find((node) => node.type === 'textarea' && node.props.id?.endsWith('-command')).props.onChange({ target: { value: 'echo saved' } });
  h.find(byLabel('网页引用来源地址')).props.onChange({ target: { value: 'https://example.test/' } });
  h.find(byLabel('网页引用片段')).props.onChange({ target: { value: 'quoted text' } });
  await h.flush();
  h.find((node) => node.type === 'button' && node.props.children?.includes?.('加入上下文包')).props.onClick();
  await h.flush();
  for (const [sequence, tool] of ['terminal', 'browser', 'files'].entries()) {
    h.render({ sequence, tool }); await h.flush();
    assert.equal(h.find((node) => node.props?.role === 'tabpanel' && node.props.id.endsWith(`-${tool}`)).props.hidden, false);
  }
  assert.equal(h.find(byLabel('侧聊消息输入')).props.value, 'draft survives');
  assert.equal(h.find((node) => node.type === 'textarea' && node.props.id?.endsWith('-command')).props.value, 'echo saved');
  assert(h.find((node) => node.type === 'pre' && node.props.children === 'quoted text'));
  assert(!h.calls.some(({ endpoint }) => endpoint === 'sidechat/create' || endpoint.endsWith('/send')));
  h.unmount();
});

test('a plain chat intent waits for initial sidechat selection to focus without creating', async () => {
  const h = harness({ intent: { sequence: 8, tool: 'chat' }, sidechats: [{ id: 'existing-side' }] });
  await h.flush();
  assert.equal(h.find(byLabel('侧聊消息输入')).props.ref.current.focused, 1);
  assert(!h.calls.some(({ endpoint }) => endpoint === 'sidechat/create'));
  h.unmount();
});

test('a pending creation survives repeated intent renders and does not steal focus from a newer tool intent', async () => {
  let finish;
  const intent = { sequence: 1, tool: 'chat', action: 'new-sidechat' };
  const h = harness({ intent, create: () => new Promise((resolve) => { finish = resolve; }) });
  await h.flush();
  h.render({ ...intent });
  await h.flush();
  assert.equal(h.calls.filter(({ endpoint }) => endpoint === 'sidechat/create').length, 1);
  h.render({ sequence: 2, tool: 'terminal' });
  await h.flush();
  finish({ id: 'late-side', title: 'Late' });
  await h.flush();
  assert.equal(h.find(byLabel('选择侧聊会话')).props.value, 'late-side');
  assert.equal(h.find(byLabel('侧聊消息输入')).props.ref.current.focused, 0);
  assert.equal(h.find((node) => node.props?.role === 'tabpanel' && node.props.id.endsWith('-terminal')).props.hidden, false);
  h.unmount();
});

test('unmount before the intent microtask cancels the mutation', async () => {
  const h = harness({ intent: { sequence: 1, tool: 'chat', action: 'new-sidechat' } });
  h.unmount();
  await Promise.resolve();
  assert(!h.calls.some(({ endpoint }) => endpoint === 'sidechat/create'));
});
