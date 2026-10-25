import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/TeamPanel.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'browser', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], loader: { '.css': 'empty' },
});
const worker = { id: 'reviewer', name: '代码审查', role: '审阅代码', protocol: 'chat-completions', baseUrl: 'https://example.invalid/v1', model: 'review-model', enabled: true, hasKey: true, apiKeyEnv: '', timeoutMs: 120000, maxOutputTokens: 4096 };
const task = (changes = {}) => ({ id: 'task-1', mainSessionId: 'main-a', agentId: 'reviewer', agentName: '代码审查', title: '检查边界', prompt: '检查边界条件', status: 'running', createdAt: '2026-10-26T00:00:00Z', ...changes });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function harness({ agents = [worker], tasks = [], handler, strict = false } = {}) {
  const slots = [], effects = new Set(), calls = [], timers = new Map();
  let cursor = 0, dirty = false, tree, stopped = false, nextTimer = 1, afterUnmountWrites = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const slot = initial => slots[cursor] || (slots[cursor] = initial());
  const react = {
    useRef(value) { const item = slot(() => ({ current: value })); cursor++; return item; },
    useState(value) {
      const item = slot(() => ({ value: typeof value === 'function' ? value() : value })); cursor++;
      item.set ||= next => { if (stopped) afterUnmountWrites++; const value = typeof next === 'function' ? next(item.value) : next; if (!Object.is(value, item.value)) { item.value = value; dirty = true; } };
      return [item.value, item.set];
    },
    useCallback(fn, deps) { const item = slot(() => ({})); cursor++; if (!same(item.deps, deps)) { item.value = fn; item.deps = deps; } return item.value; },
    useEffect(run, deps) { const item = slot(() => ({ effect: true })); cursor++; if (!same(item.deps, deps)) effects.add(item); item.run = run; item.deps = deps; },
    useId() { const item = slot(() => 'team-fixture'); cursor++; return item; },
  };
  const jsx = (type, props, key) => ({ type, props, key });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, AbortController, crypto: webcrypto,
    setInterval: fn => { const id = nextTimer++; timers.set(id, fn); return id; }, clearInterval: id => timers.delete(id),
    require: name => name === 'react' ? react : { jsx, jsxs: jsx },
  });
  const visit = (value, callback) => {
    if (Array.isArray(value)) return value.forEach(child => visit(child, callback));
    if (!value || typeof value !== 'object') return;
    callback(value); visit(value.props?.children, callback);
  };
  const nodes = predicate => { const result = []; visit(tree, node => { if (predicate(node)) result.push(node); }); return result; };
  const nativeDialog = { open: false, shown: 0, showModal() { this.open = true; this.shown++; }, close() { this.open = false; } };
  const api = { async call(endpoint, payload, signal) {
    calls.push({ endpoint, payload, signal });
    const custom = handler?.(endpoint, payload, signal);
    if (custom !== undefined) return custom;
    if (endpoint === 'team/agents/list') return { agents };
    if (endpoint === 'team/tasks/list') return { tasks };
    if (endpoint === 'team/tasks/result') return { text: '边界条件结果', artifacts: [] };
    return {};
  } };
  function render() {
    cursor = 0; dirty = false;
    const session = module.exports.default({ api, mainSessionId: 'main-a' });
    tree = session.type(session.props);
    const dialog = nodes(node => node.type === 'dialog')[0];
    if (dialog?.props.ref) dialog.props.ref.current = nativeDialog;
    for (const item of effects) { item.cleanup?.(); item.cleanup = item.run(); }
    effects.clear();
  }
  render();
  if (strict) {
    for (const item of slots) if (item?.effect) item.cleanup?.();
    for (const item of slots) if (item?.effect) item.cleanup = item.run();
  }
  return {
    calls, nodes, nativeDialog, exports: module.exports,
    get afterUnmountWrites() { return afterUnmountWrites; },
    get timerCount() { return timers.size; },
    find(predicate) { const found = nodes(predicate); assert.equal(found.length, 1); return found[0]; },
    async flush() { for (let pass = 0; pass < 30; pass++) { await Promise.resolve(); if (dirty && !stopped) render(); } },
    async poll() { await Promise.all([...timers.values()].map(fn => fn())); await this.flush(); },
    unmount() { for (const item of slots) if (item?.effect) item.cleanup?.(); stopped = true; },
  };
}
const label = text => node => node.props?.['aria-label'] === text;
const buttonText = text => node => node.type === 'button' && node.props.children === text;
const className = text => node => node.props?.className === text;
async function config(h) { h.find(label('配置协作成员')).props.onClick(); await h.flush(); }

test('unconfigured presets stay unavailable, mount only lists and config does not dispatch', async () => {
  const h = harness({ agents: [{ ...worker, enabled: false, hasKey: false }] }); await h.flush();
  h.find(label('协作任务要求')).props.onChange({ target: { value: '审查一下' } }); await h.flush();
  assert.equal(h.find(label('分派任务')).props.disabled, true);
  await config(h);
  assert.equal(h.nativeDialog.open, true, 'native dialog avoids clipping in either split pane');
  h.find(buttonText('＋ 添加成员')).props.onClick(); await h.flush();
  const enabled = h.find(node => node.type === 'input' && node.props.type === 'checkbox');
  assert.equal(enabled.props.checked, false);
  assert.equal(enabled.props.disabled, true);
  assert(h.nodes(node => node.type === 'option' && node.props.value === 'anthropic-messages').length);
  assert(h.calls.every(call => call.endpoint.endsWith('/list')));
  h.unmount();
});

test('polling shows main-agent tasks, rejects other sessions and reads images only on demand', async () => {
  let remote = [];
  const image = 'data:image/png;base64,aGVsbG8=';
  const h = harness({ handler(endpoint) {
    if (endpoint === 'team/tasks/list') return { tasks: remote };
    if (endpoint === 'team/tasks/result') return { text: '真实结果', artifacts: [{ id: 'image-1', name: '图.png', mimeType: 'image/png', dataUrl: image }] };
  } }); await h.flush();
  remote = [task({ status: 'completed' }), task({ id: 'foreign', mainSessionId: 'main-b' })];
  await h.poll();
  assert.equal(h.nodes(node => node.props?.['data-task-id']).length, 1);
  assert.equal(h.calls.filter(call => call.endpoint.endsWith('/result')).length, 0);
  h.find(className('dsh-team-task-toggle')).props.onClick(); await h.flush();
  assert.equal(h.calls.filter(call => call.endpoint.endsWith('/result')).length, 1);
  assert.equal(h.find(node => node.type === 'img').props.src, image);
  await h.poll();
  assert.equal(h.calls.filter(call => call.endpoint.endsWith('/result')).length, 1, 'polling never reloads image bytes');
  assert(h.calls.every(call => call.payload.mainSessionId === 'main-a'));
  h.unmount();
});

test('explicit dispatch carries selected worker and duplicate clicks stay one request', async () => {
  const pending = deferred();
  const h = harness({ agents: [worker, { ...worker, id: 'artist', name: '图片', protocol: 'images' }], handler: endpoint => endpoint === 'team/tasks/submit' ? pending.promise : undefined }); await h.flush();
  h.find(label('执行成员')).props.onChange({ target: { value: 'artist' } });
  h.find(label('协作任务要求')).props.onChange({ target: { value: '画一张示意图\n使用黑灰风格' } }); await h.flush();
  const submit = h.find(className('dsh-team-composer')).props.onSubmit;
  void submit({ preventDefault() {} }); void submit({ preventDefault() {} }); await h.flush();
  const calls = h.calls.filter(call => call.endpoint === 'team/tasks/submit');
  assert.equal(calls.length, 1); assert.equal(calls[0].payload.agentId, 'artist');
  assert.equal(calls[0].payload.title, '画一张示意图');
  assert.equal(calls[0].payload.prompt, '画一张示意图\n使用黑灰风格');
  pending.resolve({ id: 'submitted' }); await h.flush();
  assert.equal(h.find(label('协作任务要求')).props.value, ''); h.unmount();
});

test('cancel only targets requested task and errors remain human-readable', async () => {
  const pending = deferred();
  const h = harness({ tasks: [task(), task({ id: 'failed', title: '失败任务', status: 'failed', error: { code: 'provider_error', message: '该成员尚未配置' } })], handler: endpoint => endpoint === 'team/tasks/cancel' ? pending.promise : undefined }); await h.flush();
  const cancel = h.find(label('取消任务 检查边界')).props.onClick;
  cancel(); cancel(); await h.flush();
  const calls = h.calls.filter(call => call.endpoint.endsWith('/cancel'));
  assert.equal(calls.length, 1); assert.equal(calls[0].payload.taskId, 'task-1');
  const failed = h.find(node => node.props?.['data-task-id'] === 'failed');
  failed.props.children[0].props.children[0].props.onClick(); await h.flush();
  assert(h.nodes(node => node.type === 'p' && node.props.children === '该成员尚未配置').length);
  pending.resolve({}); await h.flush(); h.unmount();
});

test('editing preserves an existing key without exposing it and closing wipes the password', async () => {
  const h = harness({ agents: [{ ...worker, apiKey: 'must-never-copy-from-list' }] }); await h.flush(); await config(h);
  h.find(node => node.type === 'button' && node.props.className?.startsWith('dsh-team-agent')).props.onClick(); await h.flush();
  const password = () => h.find(node => node.type === 'input' && node.props.type === 'password');
  assert.equal(password().props.value, '');
  h.find(className('dsh-team-profile')).props.onSubmit({ preventDefault() {} }); await h.flush();
  const save = h.calls.find(call => call.endpoint === 'team/agents/save');
  assert(!Object.hasOwn(save.payload.profile, 'apiKey'));
  assert(!Object.hasOwn(save.payload.profile, 'hasKey'));
  h.find(node => node.type === 'button' && node.props.className?.startsWith('dsh-team-agent')).props.onClick(); await h.flush();
  password().props.onChange({ target: { value: 'write-only-fixture' } }); await h.flush();
  h.find(label('关闭成员配置')).props.onClick(); await h.flush(); await config(h);
  h.find(node => node.type === 'button' && node.props.className?.startsWith('dsh-team-agent')).props.onClick(); await h.flush();
  assert.equal(password().props.value, ''); h.unmount();
});

test('new disabled profiles use a stable valid id across failed save retries', async () => {
  let count = 0;
  const h = harness({ handler: endpoint => endpoint === 'team/agents/save' && ++count === 1 ? Promise.reject(new Error('fixture save failure')) : undefined });
  await h.flush(); await config(h);
  h.find(buttonText('＋ 添加成员')).props.onClick(); await h.flush();
  h.find(node => node.type === 'input' && node.props.maxLength === 80).props.onChange({ target: { value: '我的中转' } });
  h.find(node => node.type === 'input' && node.props.type === 'url').props.onChange({ target: { value: 'https://gateway.example.invalid/v1' } }); await h.flush();
  h.find(className('dsh-team-profile')).props.onSubmit({ preventDefault() {} }); await h.flush();
  h.find(className('dsh-team-profile')).props.onSubmit({ preventDefault() {} }); await h.flush();
  const saved = h.calls.filter(call => call.endpoint === 'team/agents/save').map(call => call.payload.profile);
  assert.equal(saved.length, 2); assert.match(saved[0].id, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
  assert.equal(saved[0].id, saved[1].id); assert.equal(saved[0].enabled, false);
  assert.equal(saved[0].model, ''); assert(!Object.hasOwn(saved[0], 'isNew')); h.unmount();
});

test('late polls and result requests cannot update an unmounted main session', async () => {
  const result = deferred(); let pendingPoll;
  const h = harness({ tasks: [task({ status: 'completed' })], handler(endpoint) {
    if (endpoint === 'team/tasks/list' && pendingPoll) return pendingPoll.promise;
    if (endpoint === 'team/tasks/result') return result.promise;
  } }); await h.flush();
  h.find(className('dsh-team-task-toggle')).props.onClick(); await h.flush();
  pendingPoll = deferred(); const polling = h.poll(); await Promise.resolve();
  h.unmount();
  assert.equal(h.timerCount, 0);
  assert(h.calls.every(call => call.signal.aborted));
  pendingPoll.resolve({ tasks: [task({ title: '旧会话结果' })] }); result.resolve({ text: '迟到结果', artifacts: [] });
  await polling; await h.flush(); assert.equal(h.afterUnmountWrites, 0);
});

test('StrictMode cleans the prior polling scope and keeps one interval', async () => {
  const h = harness({ strict: true }); await h.flush();
  assert.equal(h.timerCount, 1); assert(h.calls[0].signal.aborted);
  assert(!h.calls.at(-1).signal.aborted);
  assert(h.calls.every(call => call.endpoint.endsWith('/list'))); h.unmount();
});

test('artifact rendering accepts inline raster results and rejects remote or active content', () => {
  const h = harness(); const image = h.exports.artifactImage;
  assert.equal(image({ mimeType: 'image/png', dataUrl: 'data:image/png;base64,aA==' }), 'data:image/png;base64,aA==');
  assert.equal(image({ mimeType: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,aA==' }), undefined);
  assert.equal(image({ mimeType: 'image/png', dataUrl: 'https://example.invalid/tracker.png' }), undefined);
  assert.equal(image({ mimeType: 'text/html', dataUrl: 'data:text/html;base64,aA==' }), undefined); h.unmount();
});
