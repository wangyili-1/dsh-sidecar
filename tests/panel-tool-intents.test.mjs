import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/Panel.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'browser', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'empty' },
});

// Exercise the real component's closures with deterministic hook commits and
// effect replay. This is a lifecycle contract harness, not a browser renderer.
function harness({ intent, strict = false, sidechats = [], create, surfaceProps = {}, request } = {}) {
  const hooks = [];
  const pending = new Set();
  const calls = [];
  const intervals = new Map();
  let nextInterval = 0;
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
    setInterval: callback => { const id = ++nextInterval; intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id), setTimeout: () => 1, clearTimeout() {},
    require: (specifier) => specifier === 'react' ? react : specifier === 'react-dom' ? { createPortal: value => value } : { jsx, jsxs: jsx },
  });
  const api = { async call(endpoint, payload) {
    calls.push({ endpoint, payload });
    if (request) {
      const response = request(endpoint, payload);
      if (response !== undefined) return response;
    }
    if (endpoint === 'state') return { main: { title: 'Main' }, sidechats };
    if (endpoint === 'files/list') return { path: '.', entries: [] };
    if (endpoint === 'conversation/get') return { id: payload.sessionId, title: 'Side', messages: [] };
    if (endpoint === 'sidechat/create') return create ? create() : { id: 'created-side', title: 'Created' };
    if (endpoint === 'conversation/send' || endpoint === 'conversation/cancel') return { accepted: true };
    throw new Error(`Unexpected API call: ${endpoint}`);
  } };
  const visit = (value, fn) => {
    if (Array.isArray(value)) return value.forEach((child) => visit(child, fn));
    if (!value || typeof value !== 'object') return;
    fn(value);
    visit(value.props?.children, fn);
  };
  function render(nextIntent = props?.toolIntent ?? intent) {
    props = { api, mainSessionId: 'main', toolIntent: nextIntent, ...surfaceProps };
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
    updateSurface(value) { surfaceProps = { ...surfaceProps, ...value }; render(); },
    async tick() { for (const callback of [...intervals.values()]) await callback(); await this.flush(); },
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

const formFor = label => node => node.type === 'form' && node.props?.children?.some?.(child => child?.props?.['aria-label'] === label);
const enter = (h, label, value) => h.find(byLabel(label)).props.onChange({ target: { value } });

test('a fixed chat surface loads, sends and cancels only its assigned session', async () => {
  const h = harness({
    sidechats: [{ id: 'first-unrelated-side', title: 'Unrelated' }],
    surfaceProps: { surface: 'chat', fixedSidechat: { id: 'assigned-side', title: 'Assigned' } },
  });
  await h.flush();
  await h.tick();
  assert(h.calls.some(({ endpoint }) => endpoint === 'conversation/get'));
  assert(h.calls.filter(({ endpoint }) => endpoint === 'conversation/get').every(({ payload }) => payload.sessionId === 'assigned-side'));
  assert(!h.calls.some(({ endpoint }) => endpoint.startsWith('files/') || endpoint === 'sidechat/create'));
  enter(h, '侧聊消息输入', 'Only the assigned chat receives this');
  await h.flush();
  await h.find(byLabel('发送到侧聊')).props.onClick();
  await h.flush();
  await h.find(byLabel('停止侧聊')).props.onClick();
  await h.flush();
  const mutations = h.calls.filter(({ endpoint }) => endpoint === 'conversation/send' || endpoint === 'conversation/cancel');
  assert.equal(mutations.length, 2);
  for (const { payload } of mutations) {
    assert.equal(payload.mainSessionId, 'main');
    assert.equal(payload.sessionId, 'assigned-side');
  }
  assert.equal(mutations[0].payload.text, 'Only the assigned chat receives this');
  h.unmount();
});

test('two mounted chat surfaces preserve independent drafts and sending one leaves the other intact', async () => {
  const first = harness({ surfaceProps: { surface: 'chat', fixedSidechat: { id: 'side-a', title: 'A' } } });
  const second = harness({ surfaceProps: { surface: 'chat', fixedSidechat: { id: 'side-b', title: 'B' } } });
  await first.flush(); await second.flush();
  enter(first, '侧聊消息输入', 'draft A');
  enter(second, '侧聊消息输入', 'draft B');
  await first.flush(); await second.flush();
  first.render(); second.render();
  await first.tick(); await second.tick();
  assert.equal(first.find(byLabel('侧聊消息输入')).props.value, 'draft A');
  assert.equal(second.find(byLabel('侧聊消息输入')).props.value, 'draft B');
  await first.find(byLabel('发送到侧聊')).props.onClick();
  await first.flush(); await second.flush();
  assert.equal(first.find(byLabel('侧聊消息输入')).props.value, '');
  assert.equal(second.find(byLabel('侧聊消息输入')).props.value, 'draft B');
  assert(!second.calls.some(({ endpoint }) => endpoint === 'conversation/send'));
  assert.equal(first.calls.find(({ endpoint }) => endpoint === 'conversation/send').payload.sessionId, 'side-a');
  first.unmount(); second.unmount();
});

test('browser-only surfaces keep their own URL and quote state without polling chats or files', async () => {
  const firstPackets = [], secondPackets = [], firstTitles = [], secondTitles = [];
  const first = harness({ surfaceProps: { surface: 'browser', onPacket: packet => firstPackets.push(packet), onTitle: title => firstTitles.push(title) } });
  const second = harness({ surfaceProps: { surface: 'browser', onPacket: packet => secondPackets.push(packet), onTitle: title => secondTitles.push(title) } });
  await first.flush(); await second.flush();
  enter(first, '浏览器网址', 'https://first.example/path');
  enter(second, '浏览器网址', 'http://localhost:4400/preview');
  await first.flush(); await second.flush();
  first.find(formFor('浏览器网址')).props.onSubmit({ preventDefault() {} });
  second.find(formFor('浏览器网址')).props.onSubmit({ preventDefault() {} });
  await first.flush(); await second.flush();
  enter(first, '网页引用片段', 'first quote');
  enter(second, '网页引用片段', 'second quote');
  await first.flush(); await second.flush();
  first.render(); second.render();
  await first.tick(); await second.tick();
  assert.equal(first.find(node => node.type === 'iframe').props.src, 'https://first.example/path');
  assert.equal(second.find(node => node.type === 'iframe').props.src, 'http://localhost:4400/preview');
  assert.equal(first.find(byLabel('网页引用片段')).props.value, 'first quote');
  assert.equal(second.find(byLabel('网页引用片段')).props.value, 'second quote');
  await first.find(byLabel('加入上下文包')).props.onClick();
  await first.flush(); await second.flush();
  assert.equal(firstPackets.length, 1);
  assert.equal(firstPackets[0].text, 'first quote');
  assert.equal(firstPackets[0].url, 'https://first.example/path');
  assert.equal(first.find(byLabel('网页引用片段')).props.value, '');
  assert.equal(second.find(byLabel('网页引用片段')).props.value, 'second quote');
  assert.equal(secondPackets.length, 0);
  assert.equal(firstTitles.length, 1);
  assert.equal(secondTitles.length, 1);
  assert.equal(firstTitles[0], 'path · first.example');
  assert.equal(secondTitles[0], 'preview · localhost');
  assert.deepEqual(first.calls, []);
  assert.deepEqual(second.calls, []);
  first.unmount(); second.unmount();
});

test('controlled context packets and external web delivery update only their chosen chat', async () => {
  let firstPackets = [{ _id: 'a-original', kind: 'file', source: 'a.txt', text: 'A context' }];
  const secondPackets = Object.freeze([{ _id: 'b-original', kind: 'file', source: 'b.txt', text: 'B context' }]);
  const updates = [];
  let nextId = 0;
  let first;
  let resolveSend;
  const sending = new Promise(resolve => { resolveSend = resolve; });
  const onPacketsChange = update => {
    updates.push(typeof update);
    firstPackets = typeof update === 'function' ? update(firstPackets) : update;
    first.updateSurface({ packets: firstPackets });
  };
  first = harness({
    surfaceProps: { surface: 'chat', fixedSidechat: { id: 'side-a', title: 'A' }, packets: firstPackets, onPacketsChange, createPacketId: () => `a-added-${++nextId}` },
    request(endpoint, payload) {
      if (endpoint === 'conversation/get') return { id: payload.sessionId, title: 'A', messages: [{ id: 'message-a', role: 'assistant', text: 'A response' }] };
      if (endpoint === 'conversation/send') return sending;
    },
  });
  const second = harness({ surfaceProps: { surface: 'chat', fixedSidechat: { id: 'side-b', title: 'B' }, packets: secondPackets, onPacketsChange() { assert.fail('unrelated chat packets changed'); } } });
  const browser = harness({ surfaceProps: { surface: 'browser', onPacket(packet) {
    onPacketsChange(current => [...current, { ...packet, _id: `a-web-${++nextId}` }]);
  } } });
  await first.flush(); await second.flush(); await browser.flush();
  await first.find(byLabel('引用消息')).props.onClick();
  await first.flush();
  assert.equal(firstPackets.length, 2);
  assert.equal(firstPackets[1]._id, 'a-added-1');
  assert.equal(firstPackets[1].text, 'A response');
  enter(first, '侧聊消息输入', 'Send current context');
  await first.flush();
  const pendingSend = first.find(byLabel('发送到侧聊')).props.onClick();
  await first.flush();
  enter(browser, '网页引用来源地址', 'https://context.example/');
  enter(browser, '网页引用片段', 'Added while chat A is sending');
  await browser.flush();
  await browser.find(byLabel('加入上下文包')).props.onClick();
  await browser.flush(); await first.flush();
  assert.equal(firstPackets.length, 3);
  resolveSend({ accepted: true });
  await pendingSend; await first.flush(); await second.flush();
  assert.equal(firstPackets.length, 1, 'successful send removes only packets captured for that send');
  assert.equal(firstPackets[0].text, 'Added while chat A is sending');
  assert.equal(secondPackets.length, 1);
  assert.equal(second.find(node => node.type === 'pre' && node.props.children === 'B context').props.children, 'B context');
  assert(updates.every(type => type === 'function'), 'parent receives functional packet updates');
  const send = first.calls.find(({ endpoint }) => endpoint === 'conversation/send');
  assert.equal(send.payload.packets.length, 2);
  assert(send.payload.packets.every(packet => !Object.hasOwn(packet, '_id')), 'internal UI packet IDs never reach the service');
  assert(!second.calls.some(({ endpoint }) => endpoint.endsWith('/send')));
  assert.deepEqual(browser.calls, []);
  first.unmount(); second.unmount(); browser.unmount();
});
