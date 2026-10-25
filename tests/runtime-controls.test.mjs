import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createRuntimeControls } from '../src/runtime-controls.mjs';

function store(initial) {
  let value = initial;
  const listeners = new Set();
  return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { value = next; [...listeners].forEach(fn => fn()); }, listeners };
}
const selected = { provider: 'deepseek', model: 'flash', reasoningEffort: 'high' };
const stats = { turns: 2, steps: 4, llmMs: 3000, toolMs: 200, ttftMs: 1000, ttftSteps: 2, decodeMs: 2000, decodeTokens: 800 };
const usage = { uncachedInputTokens: 10, outputTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 30 };
const permission = { currentValue: 'workspace-write', options: [{ value: 'workspace-write', name: '工作区内修改' }, { value: 'read-only', name: '只读' }, { value: 'custom', name: '自定义' }] };
function fixture(ids = ['main', 'side-a', 'side-b']) {
  const bindings = new Map();
  const dirs = new Map();
  const calls = [];
  for (const id of ids) {
    const cells = new Map(Object.entries({ permissions: permission, modelSelection: { next: selected, lastUsed: selected }, sessionStats: stats, tokenUsage: usage, contextPressure: { projectedTokens: 100, contextWindow: 1000 } }).map(([key, value]) => [key, store(value)]));
    const lifecycle = store({ removed: false });
    const session = { sessionId: id, getSnapshot: lifecycle.getSnapshot, projections: { faceOf(key) { if (!cells.has(key)) cells.set(key, store(undefined)); return cells.get(key); } },
      async command(line) { calls.push(['command', id, line]); return { ok: true, value: { matched: true } }; } };
    bindings.set(id, { sessionId: id, session, cells, lifecycle });
    const directory = { store: store({ status: 'idle', current: selected, groups: [], error: null, routable: true }),
      async load() { calls.push(['load', id]); this.store.set({ status: 'ready', current: selected, groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'flash', name: 'Flash', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }] } }] }], error: null }); return this.store.getSnapshot(); },
      async select(value) { calls.push(['select', id, value]); cells.get('modelSelection').set({ lastUsed: selected, next: value }); this.store.set({ ...this.store.getSnapshot(), current: value }); } };
    dirs.set(id, directory);
  }
  const sessions = { binding(id) { calls.push(['binding', id]); return bindings.get(id); }, async refresh() { calls.push(['refresh']); }, open() { throw new Error('Must never change the main selection'); }, list: store({ current: 'main' }) };
  const ctx = { sessions, modelDirectories: { directoryFor(id) { calls.push(['directory', id]); return dirs.get(id); } } };
  return { ctx, bindings, dirs, calls, controls: createRuntimeControls(ctx) };
}

test('binding reads only the requested session, loads no model catalog, and keeps stable immutable snapshots', async () => {
  const f = fixture();
  const controls = await f.controls.bind('side-b');
  const snapshot = controls.getSnapshot();
  assert.strictEqual(controls.getSnapshot(), snapshot);
  assert.deepEqual(snapshot.stats, stats);
  assert.deepEqual(snapshot.usage, usage);
  assert.deepEqual(snapshot.context, { projectedTokens: 100, contextWindow: 1000 });
  assert.equal(snapshot.models.selectionScope, 'session-and-future-default');
  assert.equal(snapshot.models.phase, 'idle');
  assert.deepEqual(f.calls, [['binding', 'side-b'], ['directory', 'side-b']]);
  assert.throws(() => { snapshot.permissions.options.push({ value: 'fake' }); }, TypeError);
  assert.equal(f.ctx.sessions.list.getSnapshot().current, 'main');
});

test('two bindings subscribe independently; cleanup removes every listener without disposing native directories', async () => {
  const f = fixture();
  const a = await f.controls.bind('side-a');
  const b = await f.controls.bind('side-b');
  const aBefore = a.getSnapshot();
  let seenA = 0; let seenB = 0;
  const stopA = a.subscribe(() => seenA++);
  const stopB = b.subscribe(() => seenB++);
  f.bindings.get('side-b').cells.get('sessionStats').set({ ...stats, turns: 9 });
  assert.equal(seenA, 0); assert.equal(seenB, 1);
  assert.strictEqual(a.getSnapshot(), aBefore);
  assert.equal(b.getSnapshot().stats.turns, 9);
  f.dirs.get('side-a').store.set({ status: 'loading', current: selected, groups: [] });
  assert.equal(seenA, 1); assert.equal(a.getSnapshot().models.phase, 'loading');
  stopA(); stopA(); stopB();
  for (const id of ['side-a', 'side-b']) {
    for (const cell of f.bindings.get(id).cells.values()) assert.equal(cell.listeners.size, 0);
    assert.equal(f.dirs.get(id).store.listeners.size, 0);
  }
});

test('explicit model selection validates loaded routes and efforts, strips extras, and targets only its directory', async () => {
  const f = fixture(); const controls = await f.controls.bind('side-b');
  await assert.rejects(controls.selectModel(selected), /模型目录/);
  await controls.loadModels();
  assert.deepEqual(controls.getSnapshot().models.items, [{ provider: 'deepseek', model: 'flash', label: 'Flash', reasoningEfforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }], defaultEffort: 'high' }]);
  await assert.rejects(controls.selectModel({ provider: 'other', model: 'flash' }), /模型目录/);
  await assert.rejects(controls.selectModel({ ...selected, reasoningEffort: 'fake' }), /推理强度/);
  await controls.selectModel({ ...selected, reasoningEffort: 'low', apiKey: 'never-send', sessionId: 'main' });
  assert.deepEqual(f.calls.filter(call => call[0] === 'select'), [['select', 'side-b', { ...selected, reasoningEffort: 'low' }]]);
  assert.equal(controls.getSnapshot().modelSelection.reasoningEffort, 'low');
  assert.equal(f.bindings.get('main').cells.get('modelSelection').getSnapshot().next.reasoningEffort, 'high');
  assert.equal(controls.getSnapshot().models.selectionScope, 'session-and-future-default', 'native default side effect must remain explicit');
});

test('permissions are native session commands, only advertised presets are allowed, and admission does not fake a projection', async () => {
  const f = fixture(); const controls = await f.controls.bind('side-a');
  await controls.selectPermission('workspace-write');
  await assert.rejects(controls.selectPermission('danger-full-access'), /权限预设/);
  await assert.rejects(controls.selectPermission('custom'), /权限预设/);
  await assert.rejects(controls.selectPermission('read-only\n/model other'), /权限预设/);
  await controls.selectPermission('read-only');
  assert.deepEqual(f.calls.filter(call => call[0] === 'command'), [['command', 'side-a', '/permission read-only']]);
  assert.equal(controls.getSnapshot().permissions.currentValue, 'workspace-write', 'wait for host projection rather than inventing success');
  f.bindings.get('side-a').cells.get('permissions').set({ ...permission, currentValue: 'read-only' });
  assert.equal(controls.getSnapshot().permissions.currentValue, 'read-only');
  f.bindings.get('side-a').session.command = async () => ({ ok: false, error: { message: 'secret value' } });
  await assert.rejects(controls.selectPermission('workspace-write'), error => error.message.includes('权限更改未成功') && !error.message.includes('secret'));
});

test('missing binding refreshes once without reading current or opening any session; stale bindings reject mutations', async () => {
  const f = fixture(); const saved = f.bindings.get('side-a'); f.bindings.delete('side-a');
  f.ctx.sessions.refresh = async () => { f.calls.push(['refresh']); f.bindings.set('side-a', saved); };
  const controls = await f.controls.bind('side-a');
  assert.deepEqual(f.calls.slice(0, 4), [['binding', 'side-a'], ['refresh'], ['binding', 'side-a'], ['directory', 'side-a']]);
  f.bindings.delete('side-a');
  await assert.rejects(controls.loadModels(), /已移除/);
  await assert.rejects(controls.selectPermission('read-only'), /已移除/);
  f.ctx.sessions.refresh = async () => {};
  await assert.rejects(f.controls.bind('not-present'), /尚未就绪/);
  await assert.rejects(f.controls.bind(undefined), /标识无效/);
  assert.equal(f.ctx.sessions.list.getSnapshot().current, 'main');
});

test('absent capability stays unknown, invalid numeric values never become believable zeroes', async () => {
  const f = fixture(); delete f.ctx.modelDirectories;
  for (const cell of f.bindings.get('side-a').cells.values()) cell.set(undefined);
  const controls = await f.controls.bind('side-a');
  const snapshot = controls.getSnapshot();
  assert.equal(snapshot.permissions, null); assert.equal(snapshot.modelSelection, null);
  assert.equal(snapshot.stats, null); assert.equal(snapshot.usage, null); assert.equal(snapshot.context, null);
  assert.equal(snapshot.models.phase, 'unavailable');
  await assert.rejects(controls.loadModels(), /未提供模型目录/);
  f.bindings.get('side-a').cells.get('sessionStats').set({ ...stats, turns: NaN });
  f.bindings.get('side-a').cells.get('tokenUsage').set({ ...usage, outputTokens: -1 });
  f.bindings.get('side-a').cells.get('contextPressure').set({ projectedTokens: 0, contextWindow: 0, apiKey: 'secret' });
  assert.equal(controls.getSnapshot().stats, null); assert.equal(controls.getSnapshot().usage, null);
  assert.deepEqual(controls.getSnapshot().context, { projectedTokens: 0 });
});

test('public snapshots whitelist metadata and never forward provider configuration or raw errors', async () => {
  const f = fixture(); const controls = await f.controls.bind('side-a');
  const secret = 'sk-thisisasecretkey123456789';
  f.bindings.get('side-a').cells.get('permissions').set({ ...permission, secret, options: [{ value: 'read-only', name: `Only ${secret}`, apiKey: secret }] });
  f.bindings.get('side-a').cells.get('tokenUsage').set({ ...usage, secret });
  f.dirs.get('side-a').store.set({ status: 'error', current: { ...selected, apiKey: secret }, groups: [{ id: 'deepseek', apiKey: secret, config: { secret }, models: [{ id: 'flash', name: 'Flash', providerConfiguration: secret }] }], failures: [{ message: secret }], error: `Bearer ${secret}` });
  const text = JSON.stringify(controls.getSnapshot());
  assert(!text.includes(secret)); assert(!text.includes('apiKey')); assert(!text.includes('providerConfiguration'));
  assert.equal(controls.getSnapshot().models.error, '无法读取或更改模型，请稍后重试。');
  f.dirs.get('side-a').load = async () => { throw new Error(secret); };
  await assert.rejects(controls.loadModels(), error => !error.message.includes(secret) && error.message.includes('无法加载'));
});

test('native permission default names match the Chinese composer while custom labels are preserved', async () => {
  const f = fixture();
  f.bindings.get('side-a').cells.get('permissions').set({ currentValue: 'workspace-write', options: [
    { value: 'workspace-write', name: 'workspace-write' },
    { value: 'read-only', name: 'Read Only' },
    { value: 'danger-full-access', name: 'Full access' },
    { value: 'custom-restricted', name: '团队受限权限' },
  ] });
  const controls = await f.controls.bind('side-a');
  assert.deepEqual(controls.getSnapshot().permissions.options.map(option => option.name), ['工作区内修改', '仅可查看', '完全权限', '团队受限权限']);
  assert.equal(controls.getSnapshot().permissions.currentValue, 'workspace-write', 'localizing labels does not change command values');
});

test('localized label metadata prefers Chinese then English and never falls back to arbitrary object properties', async () => {
  const f = fixture();
  const secret = 'sk-anothersecretvalue123456789';
  f.bindings.get('side-a').cells.get('permissions').set({ currentValue: 'workspace-write', options: [
    { value: 'workspace-write', name: { 'zh-CN': '工作区内编辑', zh: '备用中文', en: 'Edit workspace', apiKey: secret }, description: { zh: '仅限本工作区', en: 'Workspace only' } },
    { value: 'custom-restricted', name: { config: secret }, description: { en: 'Restricted access', unknown: secret } },
  ] });
  f.dirs.get('side-a').store.set({ status: 'ready', current: selected, groups: [{ id: 'deepseek', models: [{ id: 'flash', name: { 'zh-CN': '快速模型', en: 'Fast model' }, reasoning: { efforts: [
    { id: 'high', name: { zh: '高', en: 'High' }, description: { 'zh-CN': '更充分地推理' } },
    { id: 'low', name: { 'zh-CN': ' ', en: 'Low' }, description: { privateField: secret } },
    { id: 'max', name: { unknown: secret } },
  ] } }] }], error: null });
  const controls = await f.controls.bind('side-a');
  const snapshot = controls.getSnapshot();
  assert.equal(snapshot.permissions.options[0].name, '工作区内编辑');
  assert.equal(snapshot.permissions.options[0].description, '仅限本工作区');
  assert.equal(snapshot.permissions.options[1].name, 'custom-restricted');
  assert.equal(snapshot.permissions.options[1].description, 'Restricted access');
  assert.equal(snapshot.models.items[0].label, '快速模型');
  assert.deepEqual(snapshot.models.items[0].reasoningEfforts, [{ id: 'high', name: '高', description: '更充分地推理' }, { id: 'low', name: 'Low' }, { id: 'max', name: 'max' }]);
  assert(!JSON.stringify(snapshot).includes(secret));
});

test('model operations reject explicit error states even when the directory does not throw', async () => {
  const f = fixture(); const controls = await f.controls.bind('side-a');
  await controls.loadModels();
  const directory = f.dirs.get('side-a');
  const ready = directory.store.getSnapshot();
  directory.select = async () => { directory.store.set({ ...ready, status: 'error', error: 'secret-provider-error' }); };
  await assert.rejects(controls.selectModel(selected), error => error.message.includes('模型更改未成功') && !error.message.includes('secret'));
  assert.equal(controls.getSnapshot().models.phase, 'error');
  directory.store.set(ready);
  directory.select = async () => ({ status: 'error', error: 'secret-response-error' });
  await assert.rejects(controls.selectModel(selected), /模型更改未成功/);
  directory.load = async () => ({ status: 'error', error: 'secret-load-error' });
  await assert.rejects(controls.loadModels(), /无法加载模型目录/);
});

test('model directory resolution falls back to the injected property when get returns undefined', async () => {
  const f = fixture();
  f.ctx.get = key => { assert.equal(key, 'modelDirectories'); return undefined; };
  const controls = await f.controls.bind('side-b');
  await controls.loadModels();
  assert.equal(controls.getSnapshot().models.phase, 'ready');
  assert.equal(controls.getSnapshot().models.items.length, 1);
  assert.deepEqual(f.calls.filter(call => call[0] === 'directory'), [['directory', 'side-b']]);
});

test('optional directory can arrive after binding and safe diagnostics distinguish unresolved dependencies', async () => {
  const f = fixture(); const resolver = f.ctx.modelDirectories;
  delete f.ctx.modelDirectories;
  f.ctx.get = () => undefined;
  const controls = await f.controls.bind('side-a');
  await assert.rejects(controls.loadModels(), /未提供模型目录/);
  assert.match(controls.getSnapshot().models.error, /重新启动/);
  f.ctx.modelDirectories = { directoryFor() { throw new Error('cannot get property "remote" without inject'); } };
  await assert.rejects(controls.loadModels(), /依赖 remote 未注入/);
  assert.match(controls.getSnapshot().models.error, /依赖 remote 未注入/);
  f.ctx.modelDirectories = { directoryFor() { throw new Error('ui-model-selection: session "private-id" resolved no scope'); } };
  await assert.rejects(controls.loadModels(), /尚未识别该侧聊/);
  assert(!controls.getSnapshot().models.error.includes('private-id'));
  f.ctx.modelDirectories = resolver;
  await controls.loadModels();
  assert.equal(controls.getSnapshot().models.error, null);
  assert.equal(controls.getSnapshot().models.items.length, 1);
});

test('catalog load errors report only recognized dependency names, including error-returning directories', async () => {
  const f = fixture(); const controls = await f.controls.bind('side-a');
  f.dirs.get('side-a').load = async () => { throw new Error('cannot get required service "remote.session" in inactive context'); };
  await assert.rejects(controls.loadModels(), /依赖 remote.session 尚未激活/);
  assert.match(controls.getSnapshot().models.error, /依赖 remote.session 尚未激活/);
  f.dirs.get('side-a').load = async () => ({ status: 'error', error: 'cannot get property "remote" without inject' });
  await assert.rejects(controls.loadModels(), /依赖 remote 未注入/);
  f.dirs.get('side-a').load = async () => { throw new Error('cannot get property "sk-SECRET123456789012345" without inject'); };
  await assert.rejects(controls.loadModels(), error => !error.message.includes('SECRET') && error.message.includes('无法加载'));
});

function clientDependencies() {
  const source = readFileSync(new URL('../src/client.jsx', import.meta.url), 'utf8');
  const declaration = source.match(/export const inject = (\[[^\]]+\]);/);
  assert(declaration, 'client must explicitly declare its Cordis dependencies');
  return [...declaration[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
}

test('client declares the native model directory and associated Remote namespace dependencies', () => {
  const inject = clientDependencies();
  for (const required of ['sessions', 'modelDirectories', 'remote', 'remote.session']) assert(inject.includes(required), `missing Cordis dependency ${required}`);
});

// This local integration check uses shipped public code and fixture data only.
// A checkout without the Windows desktop installation still runs the unit suite.
const runtimeRoot = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeekHarness', 'runtime', 'node_modules') : '';
const cordisEntry = join(runtimeRoot, '@deepseek-ai', 'cordis', 'lib', 'index.js');
const directoryBundle = join(runtimeRoot, '@deepseek-ai', 'dsh-client-ui-model-selection', 'lib', 'client.js');
test('installed Cordis associated namespace reproduces missing remote.session and accepts declared dependencies', {
  skip: !runtimeRoot || !existsSync(cordisEntry) || !existsSync(directoryBundle),
}, async () => {
  const cordis = await import(pathToFileURL(cordisEntry).href);
  let factory;
  runInNewContext(readFileSync(directoryBundle, 'utf8'), { window: { __ModuleLoader__: { load(value) { factory = value.factory; } } } });
  const createSnapshotStore = initial => {
    const cell = store(initial);
    return { ...cell, update(fn) { const next = { ...cell.getSnapshot() }; fn(next); cell.set(next); } };
  };
  const native = factory(name => name === '@deepseek-ai/cordis' ? cordis : name === '@deepseek-ai/dsh-client-store' ? { createSnapshotStore } : name === 'react' ? { memo: value => value } : {});
  class Remote extends cordis.Service {
    constructor(ctx) { super(ctx, 'remote'); }
    $on() { return () => {}; }
  }
  class RemoteSession extends cordis.Service {
    constructor(ctx) { super(ctx, 'remote.session'); }
    async modelCatalog() { return { ok: true, value: { default: selected, routableProviders: ['deepseek'], groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'flash', name: 'Fixture Flash' }] }], failures: [] } }; }
    async selectModel() { throw new Error('Read-only fixture must never select a model'); }
  }
  async function attempt(inject) {
    const root = new cordis.Context();
    try {
      await root.plugin(Remote); await root.plugin(RemoteSession);
      const projections = new Map([['modelSelection', store({ lastUsed: null, next: null })]]);
      const binding = { sessionId: 'side', session: { sessionId: 'side', projections: { faceOf(key) { if (!projections.has(key)) projections.set(key, store(undefined)); return projections.get(key); } } } };
      root.provide('sessions', { scope: () => root, binding: id => id === 'side' ? binding : undefined, subagentAddress: () => undefined });
      await root.plugin(native.ModelDirectoryResolver, { blockReason: () => '' });
      let pending;
      await root.plugin({ inject, apply(ctx) {
        pending = createRuntimeControls(ctx).bind('side').then(async controls => { await controls.loadModels(); return controls.getSnapshot(); });
        // The test reads the rejection below; prevent an intermediate unhandled rejection.
        pending.catch(() => {});
      } });
      return await pending;
    } finally { await root.fiber.dispose(); }
  }
  await assert.rejects(attempt(['sessions']), /remote.session 未注入/);
  const inject = clientDependencies().filter(value => ['sessions', 'modelDirectories', 'remote', 'remote.session'].includes(value));
  const snapshot = await attempt(inject);
  assert.equal(snapshot.models.phase, 'ready');
  assert.equal(snapshot.models.items[0].label, 'Fixture Flash');
});
