import assert from 'node:assert/strict';
import test from 'node:test';
import { registerAgentTools } from '../src/agent-tools.mjs';

const owner = 'main-session';
const taskOf = (changes = {}) => ({ id: 'task-1', mainSessionId: owner, agentId: 'writer', agentName: 'Writer', title: 'Draft', status: 'running', createdAt: 1, ...changes });
const taskResult = () => taskOf({
  status: 'completed', finishedAt: 5,
  prompt: 'private prompt', config: { apiKey: 'credential-fixture' }, baseUrl: 'https://private.invalid',
  result: {
    text: 'Worker answer', apiKey: 'credential-fixture', rawResponse: { authorization: 'credential-fixture' },
    artifacts: [{ id: 'image-1', path: 'C:\\project\\outputs\\sidecar-agents\\task-1\\image.png', mimeType: 'image/png', name: 'image.png', headers: { authorization: 'credential-fixture' } }],
    usage: { inputTokens: 12, outputTokens: 8, authorization: 'credential-fixture', apiKey: 42, total_tokens: Infinity },
  },
});

function fixture(overrides = {}) {
  const definitions = new Map();
  const calls = [];
  const unregistered = [];
  const methods = {
    listAgents: async () => [{ id: 'writer', name: 'Writer', role: 'Draft text', protocol: 'openai-compatible', enabled: true, hasKey: true }],
    submit: async () => taskOf({ status: 'queued' }),
    listTasks: async () => [taskOf()],
    getTask: async () => taskResult(),
    cancelTask: async () => taskOf({ status: 'cancelled' }),
    waitTasks: async () => [taskResult()],
    ...overrides,
  };
  const team = Object.fromEntries(Object.entries(methods).map(([name, run]) => [name, (...args) => { calls.push({ name, args }); return run(...args); }]));
  const dispose = registerAgentTools({ tools: { register(definition) {
    assert(!definitions.has(definition.name));
    definitions.set(definition.name, definition);
    return () => { unregistered.push(definition.name); definitions.delete(definition.name); };
  } } }, team);
  const exec = { agent: { session: { id: owner } }, signal: new AbortController().signal };
  return { definitions, calls, dispose, unregistered, exec, invoke(name, args = {}, execution = exec) { return definitions.get(`sidecar_${name}`).execute(args, execution); } };
}

test('registers six native ToolDefinitions with closed schemas and owns cleanup', () => {
  const h = fixture();
  assert.deepEqual([...h.definitions.keys()], ['sidecar_list_agents', 'sidecar_submit_task', 'sidecar_list_tasks', 'sidecar_get_task', 'sidecar_wait_tasks', 'sidecar_cancel_task']);
  for (const definition of h.definitions.values()) {
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.parameters.additionalProperties, false);
    assert.equal(definition.output.schema.additionalProperties, false);
    assert.equal(typeof definition.output.render, 'function');
    for (const forbidden of ['provider', 'model', 'key', 'apiKey', 'baseUrl', 'mainSessionId']) assert(!Object.hasOwn(definition.parameters.properties, forbidden));
  }
  assert.equal(h.definitions.get('sidecar_wait_tasks').timeoutMs, 30_000);
  assert.equal(h.definitions.get('sidecar_submit_task').isConcurrencySafe, undefined);
  h.dispose(); h.dispose();
  assert.equal(h.unregistered.length, 6);
  assert.equal(h.definitions.size, 0);
});

test('worker discovery exposes only configured metadata', async () => {
  const h = fixture({ listAgents: async () => [
    { id: 'writer', name: 'Writer', role: 'Draft text', protocol: 'openai-compatible', enabled: true, hasKey: true, apiKey: 'credential-fixture', baseUrl: 'https://private.invalid', config: { token: 'private' } },
    { id: 'disabled', name: 'Disabled', enabled: false, hasKey: true },
    { id: 'unconfigured', name: 'No key', enabled: true, hasKey: false },
  ] });
  assert.deepEqual(await h.invoke('list_agents'), { agents: [{ id: 'writer', name: 'Writer', role: 'Draft text', protocol: 'openai-compatible' }] });
});

test('submit uses the actual caller session and forwards cancellation only for admission', async () => {
  const h = fixture();
  const result = await h.invoke('submit_task', { agentId: 'writer', prompt: 'Draft the conclusion', title: 'Conclusion' });
  assert.equal(result.task.status, 'queued');
  assert.deepEqual(h.calls, [{ name: 'submit', args: [{ mainSessionId: owner, agentId: 'writer', prompt: 'Draft the conclusion', title: 'Conclusion', signal: h.exec.signal }] }]);
  assert.equal(h.exec.signal.aborted, false, 'returning from submit must not stop its background task');
});

test('task tools preserve scoped text and local image paths while dropping private data', async () => {
  const h = fixture();
  const result = await h.invoke('get_task', { taskId: 'task-1' });
  assert.equal(result.task.result.text, 'Worker answer');
  assert.equal(result.task.result.artifacts[0].path, taskResult().result.artifacts[0].path);
  assert.deepEqual(result.task.result.usage, { inputTokens: 12, outputTokens: 8 });
  const rendered = h.definitions.get('sidecar_get_task').output.render({}, result);
  assert(!JSON.stringify(rendered).includes('credential-fixture'));
  assert(!JSON.stringify(rendered).includes('private prompt'));
  assert(!Object.hasOwn(result.task, 'mainSessionId'));
  await h.invoke('list_tasks');
  await h.invoke('cancel_task', { taskId: 'task-1' });
  assert.deepEqual(h.calls.map(call => call.args), [[owner, 'task-1'], [owner], [owner, 'task-1']]);
});

test('caller spoofing, provider changes and malformed task arguments never reach team', async () => {
  const h = fixture();
  for (const extra of ['mainSessionId', 'provider', 'model', 'baseUrl', 'apiKey', 'headers']) {
    await assert.rejects(h.invoke('submit_task', { agentId: 'writer', prompt: 'task', [extra]: 'forbidden-fixture' }), /Unsupported arguments/);
  }
  for (const args of [{}, { agentId: 'writer', prompt: '' }, { agentId: 'writer', prompt: 'x'.repeat(64_001) }, { agentId: 'writer', prompt: 'task', title: '' }, { agentId: 'writer', prompt: 'task', title: 'x'.repeat(101) }]) await assert.rejects(h.invoke('submit_task', args));
  for (const taskIds of [[], Array(9).fill('task'), ['task', 'task'], [null]]) await assert.rejects(h.invoke('wait_tasks', { taskIds }));
  await assert.rejects(h.invoke('list_tasks', {}, { signal: h.exec.signal }), /owning DSH agent/);
  await assert.rejects(h.invoke('list_tasks', {}, { agent: h.exec.agent }), /cancellation signal/);
  assert.equal(h.calls.length, 0);
});

test('cross-session task DTOs are rejected rather than leaked', async () => {
  const foreign = taskResult(); foreign.mainSessionId = 'other-session';
  const h = fixture({ getTask: async () => foreign, listTasks: async () => [foreign], waitTasks: async () => [foreign] });
  for (const [name, args] of [['get_task', { taskId: 'task-1' }], ['list_tasks', {}], ['wait_tasks', { taskIds: ['task-1'] }]]) {
    await assert.rejects(h.invoke(name, args), error => /current DSH session/.test(error.message) && !error.message.includes('Worker answer'));
  }
});

test('raw provider failures cannot expose request credentials or endpoint settings', async () => {
  const h = fixture({ submit: async () => { throw new Error('credential-fixture at https://private.invalid?key=credential-fixture'); } });
  await assert.rejects(h.invoke('submit_task', { agentId: 'writer', prompt: 'task' }), error => {
    assert(!error.message.includes('credential-fixture'));
    assert(!error.message.includes('private.invalid'));
    assert.equal(error.cause, undefined);
    return /worker operation failed/.test(error.message);
  });
});

test('aborted callers cannot start, inspect or cancel a task', async () => {
  const h = fixture();
  const controller = new AbortController(); controller.abort(new Error('private cancellation reason'));
  const exec = { ...h.exec, signal: controller.signal };
  for (const [name, args] of [['list_agents', {}], ['submit_task', { agentId: 'writer', prompt: 'task' }], ['get_task', { taskId: 'task-1' }], ['cancel_task', { taskId: 'task-1' }]]) {
    await assert.rejects(h.invoke(name, args, exec), error => error.name === 'AbortError' && !error.message.includes('private cancellation reason'));
  }
  assert.equal(h.calls.length, 0);
});

test('cancelling a wait propagates to the wait signal without cancelling workers', async () => {
  let observed;
  const h = fixture({ waitTasks: (_owner, _ids, signal) => new Promise((_resolve, reject) => {
    observed = signal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const controller = new AbortController();
  const waiting = h.invoke('wait_tasks', { taskIds: ['task-1'] }, { ...h.exec, signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, error => error.name === 'AbortError');
  assert.equal(observed.aborted, true);
  assert.deepEqual(h.calls.map(call => call.name), ['waitTasks']);
});

test('a 25-second deadline stops only the wait and returns current task status', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let observed;
  const h = fixture({
    waitTasks: (_owner, _ids, signal) => new Promise((_resolve, reject) => {
      observed = signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    getTask: async () => taskOf(),
  });
  const waiting = h.invoke('wait_tasks', { taskIds: ['task-1'] });
  t.mock.timers.tick(25_000);
  const result = await waiting;
  assert.equal(result.timedOut, true);
  assert.equal(result.tasks[0].status, 'running');
  assert.equal(observed.aborted, true);
  assert.equal(h.exec.signal.aborted, false);
  assert.deepEqual(h.calls.map(call => call.name), ['waitTasks', 'getTask']);
});

test('registration failure removes already registered definitions', () => {
  const h = fixture();
  const names = [...h.definitions.keys()];
  let count = 0;
  const disposed = [];
  const team = Object.fromEntries(['listAgents', 'submit', 'listTasks', 'getTask', 'cancelTask', 'waitTasks'].map(name => [name, async () => []]));
  assert.throws(() => registerAgentTools({ tools: { register(definition) {
    if (++count === 3) throw new Error('fixture registry failure');
    return () => disposed.push(definition.name);
  } } }, team), /fixture registry failure/);
  assert.deepEqual(disposed, names.slice(0, 2).reverse());
  h.dispose();
});
