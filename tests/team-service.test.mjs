import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createTeamService } from '../src/team-service.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const textOutput = text => ({ text, images: [], usage: { inputTokens: 3, outputTokens: 2 } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const webAgent = () => ({ id: 'web', name: '网页人工验收', role: '审查边界条件', protocol: 'manual-web', baseUrl: 'https://chat.deepseek.com', model: '', authMode: 'none', enabled: true, hasKey: false, ready: true, executionMode: 'web-manual' });
async function until(predicate, message = 'fixture condition did not settle') {
  const deadline = Date.now() + 2500;
  while (!await predicate()) {
    if (Date.now() > deadline) assert.fail(message);
    await delay(5);
  }
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'dsh-sidecar-team-tests-'));
  const workspace = path.join(root, 'workspace');
  const otherWorkspace = path.join(root, 'other-workspace');
  const dataDir = path.join(root, 'state');
  await Promise.all([workspace, otherWorkspace, dataDir].map(directory => fs.mkdir(directory)));
  const stateFile = path.join(dataDir, 'team-tasks.json');
  if (options.seed) await fs.writeFile(stateFile, typeof options.seed === 'string' ? options.seed : JSON.stringify(options.seed({ workspace, otherWorkspace })));
  const agents = options.agents ?? [{ id: 'writer', name: 'Writer', role: 'Text', protocol: 'chat-completions', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', authMode: 'api-key', enabled: true, hasKey: true }];
  const calls = [], inFlight = new Set(), providerPromises = new Set();
  let peak = 0;
  const store = {
    async list() { return structuredClone(agents); },
    async save(profile) { const at = agents.findIndex(agent => agent.id === profile.id); if (at >= 0) agents.splice(at, 1, profile); else agents.push(profile); return structuredClone(profile); },
    async remove(agentId) { const at = agents.findIndex(agent => agent.id === agentId); if (at >= 0) agents.splice(at, 1); return { removed: true }; },
    execute(request) {
      const entry = { ...request, aborted: false };
      let resolve, reject;
      const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
      entry.resolve = resolve; entry.reject = reject;
      const abort = () => { entry.aborted = true; reject(request.signal.reason ?? new Error('fixture aborted')); };
      calls.push(entry); inFlight.add(entry); peak = Math.max(peak, inFlight.size);
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      else if (options.outputFor) { try { resolve(options.outputFor(request)); } catch (error) { reject(error); } }
      const result = pending.finally(() => { request.signal.removeEventListener('abort', abort); inFlight.delete(entry); providerPromises.delete(result); });
      providerPromises.add(result);
      return result;
    },
  };
  const resolverCalls = [];
  const resolveWorkspace = async (mainSessionId, signal) => {
    signal?.throwIfAborted(); resolverCalls.push(mainSessionId);
    if (mainSessionId === 'main') return workspace;
    if (mainSessionId === 'other') return otherWorkspace;
    throw Object.assign(new Error('Unknown fixture session'), { code: 'unknown-main' });
  };
  let team = createTeamService({ dataDir, resolveWorkspace, providers: store, concurrency: options.concurrency ?? 3, maxPending: options.maxPending ?? 30 });
  t.after(async () => {
    await team.dispose().catch(() => {});
    await Promise.allSettled([...providerPromises]);
    await tick(); await tick();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert(root.split(/[\\/]/).at(-1).startsWith('dsh-sidecar-team-tests-'));
    await fs.rm(path.resolve(root), { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });
  return {
    root, workspace, otherWorkspace, dataDir, stateFile, calls, inFlight, store, agents, resolverCalls,
    get peak() { return peak; },
    get team() { return team; },
    submit(prompt, extra = {}) { return team.submit({ mainSessionId: 'main', agentId: 'writer', prompt, ...extra }); },
    async terminal(taskId, mainSessionId = 'main') { return (await team.waitTasks(mainSessionId, [taskId], AbortSignal.timeout(2500)))[0]; },
    async restart() { await team.dispose(); team = createTeamService({ dataDir, resolveWorkspace, providers: store, concurrency: options.concurrency ?? 3 }); return team; },
  };
}

test('concurrent submissions respect capacity and queued work starts only when a slot frees', async t => {
  const f = await fixture(t, { concurrency: 2 });
  const rows = await Promise.all(['one', 'two', 'three'].map(prompt => f.submit(prompt)));
  await until(() => f.calls.length === 2);
  assert.equal(f.peak, 2);
  const states = await Promise.all(rows.map(row => f.team.getTask('main', row.id)));
  assert.equal(states.filter(row => row.status === 'queued').length, 1);
  assert.equal(states.filter(row => row.status === 'running').length, 2);
  f.calls[0].resolve(textOutput('one done'));
  await until(() => f.calls.length === 3);
  assert.equal(f.peak, 2);
  f.calls[1].resolve(textOutput('two done')); f.calls[2].resolve(textOutput('three done'));
  const settled = await f.team.waitTasks('main', rows.map(row => row.id), AbortSignal.timeout(2500));
  assert(settled.every(row => row.status === 'completed'));
  assert.deepEqual(f.calls.map(call => call.prompt).sort(), ['one', 'three', 'two']);
});

test('cancelling a queued task never starts it and cancelling one running task preserves another owner', async t => {
  const f = await fixture(t, { concurrency: 2 });
  const first = await f.submit('main running');
  const other = await f.submit('other running', { mainSessionId: 'other' });
  const queued = await f.submit('queued to cancel');
  await until(() => f.calls.length === 2);
  assert.equal((await f.team.cancelTask('main', queued.id)).status, 'cancelled');
  assert.equal((await f.team.cancelTask('main', first.id)).status, 'cancelled');
  await until(() => f.calls[0].aborted);
  assert.equal(f.calls[1].signal.aborted, false);
  assert.equal((await f.team.getTask('other', other.id)).status, 'running');
  f.calls[1].resolve(textOutput('other finished'));
  assert.equal((await f.terminal(other.id, 'other')).status, 'completed');
  assert.equal(f.calls.length, 2);
  assert.equal((await f.team.getTask('main', queued.id)).status, 'cancelled');
});

test('task reads, cancellation, waits and result RPCs reject a different main session', async t => {
  const f = await fixture(t);
  const task = await f.submit('owned');
  await until(() => f.calls.length === 1);
  for (const action of [
    () => f.team.getTask('other', task.id),
    () => f.team.cancelTask('other', task.id),
    () => f.team.waitTasks('other', [task.id], AbortSignal.timeout(2500)),
    () => f.team.dispatch('team/tasks/result', { mainSessionId: 'other', taskId: task.id }),
  ]) await assert.rejects(action(), error => error.code === 'team-task-not-found');
  assert.deepEqual(await f.team.listTasks('other'), []);
  assert.equal(f.calls[0].signal.aborted, false);
});

test('aborting a wait releases the waiter without cancelling its running worker', async t => {
  const f = await fixture(t);
  const task = await f.submit('keep running');
  await until(() => f.calls.length === 1);
  const control = new AbortController();
  const waiting = f.team.waitTasks('main', [task.id], control.signal);
  await tick(); control.abort(new Error('fixture wait stopped'));
  await assert.rejects(waiting, /fixture wait stopped/);
  assert.equal(f.calls[0].signal.aborted, false);
  f.calls[0].resolve(textOutput('still completed'));
  assert.equal((await f.terminal(task.id)).status, 'completed');
});

test('restart marks persisted queued and running rows interrupted and never retries providers', async t => {
  const f = await fixture(t, { seed: ({ workspace }) => ({ schema: 1, tasks: [
    { id: 'saved-running', mainSessionId: 'main', agentId: 'writer', prompt: 'old running', workspace, status: 'running', createdAt: 1 },
    { id: 'saved-queued', mainSessionId: 'main', agentId: 'writer', prompt: 'old queued', workspace, status: 'queued', createdAt: 2 },
    { id: 'saved-completed', mainSessionId: 'main', agentId: 'writer', prompt: 'done', workspace, status: 'completed', createdAt: 3, result: textOutput('preserved') },
  ] }) });
  const tasks = await f.team.listTasks('main');
  assert.equal(tasks.find(row => row.id === 'saved-completed').status, 'completed');
  for (const id of ['saved-running', 'saved-queued']) {
    const row = tasks.find(task => task.id === id);
    assert.equal(row.status, 'interrupted');
    assert.equal(row.error.code, 'service-restarted');
    assert.equal(typeof row.finishedAt, 'number');
  }
  assert.equal(f.calls.length, 0);
  const saved = JSON.parse(await fs.readFile(f.stateFile, 'utf8'));
  assert(saved.tasks.filter(row => row.id !== 'saved-completed').every(row => row.status === 'interrupted'));
});

test('text and a valid small PNG are saved under the owning workspace and image bytes are fetched only on demand', async t => {
  const f = await fixture(t, { outputFor: () => ({ text: '# Fixture answer', images: [{ mimeType: 'image/png', dataBase64: PNG }], usage: { inputTokens: 10, outputTokens: 20, apiKey: 'credential-fixture', negative: -1 } }) });
  const task = await f.submit('image and text');
  const result = await f.terminal(task.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.result.text, '# Fixture answer');
  assert.equal(result.result.artifacts.length, 2);
  for (const artifact of result.result.artifacts) {
    assert.equal(path.dirname(artifact.path), path.join(await fs.realpath(f.workspace), 'outputs', 'sidecar-agents', task.id));
    assert.equal(artifact.dataUrl, undefined);
  }
  const text = result.result.artifacts.find(artifact => artifact.mimeType === 'text/markdown');
  const image = result.result.artifacts.find(artifact => artifact.mimeType === 'image/png');
  assert.equal(await fs.readFile(text.path, 'utf8'), '# Fixture answer');
  assert.deepEqual(await fs.readFile(image.path), Buffer.from(PNG, 'base64'));
  const rows = await f.team.dispatch('team/tasks/list', { mainSessionId: 'main' });
  assert.equal(rows.tasks[0].result.artifacts[1].dataUrl, undefined);
  const fetched = await f.team.dispatch('team/tasks/result', { mainSessionId: 'main', taskId: task.id });
  assert.equal(fetched.artifacts.find(artifact => artifact.mimeType === 'image/png').dataUrl, `data:image/png;base64,${PNG}`);
  assert.equal(fetched.artifacts.find(artifact => artifact.mimeType === 'text/markdown').dataUrl, undefined);
  assert(!JSON.stringify(result.result.usage).includes('credential-fixture'));
  assert.equal(JSON.parse(await fs.readFile(f.stateFile, 'utf8')).tasks[0].result.artifacts[1].dataUrl, undefined);
});

test('malformed image data fails without creating a purported image artifact', async t => {
  const f = await fixture(t, { outputFor: () => ({ text: '', images: [{ mimeType: 'image/png', dataBase64: Buffer.from('not a PNG').toString('base64') }] }) });
  const task = await f.submit('bad image');
  const result = await f.terminal(task.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'invalid-response');
  await assert.rejects(fs.access(path.join(f.workspace, 'outputs', 'sidecar-agents', task.id, 'image-1.png')), error => error.code === 'ENOENT');
});

test('an outputs directory symlink cannot send provider artifacts outside the workspace', async t => {
  const f = await fixture(t, { outputFor: () => textOutput('must stay inside') });
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  try { await fs.symlink(outside, path.join(f.workspace, 'outputs'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) { t.skip('This platform does not permit the fixture directory link'); return; } throw error; }
  const task = await f.submit('escape probe');
  assert.equal((await f.terminal(task.id)).status, 'failed');
  assert.deepEqual(await fs.readdir(outside), []);
});

test('image result retrieval rejects an artifact replaced by an outside symlink', async t => {
  const f = await fixture(t, { outputFor: () => ({ text: '', images: [{ mimeType: 'image/png', dataBase64: PNG }] }) });
  const task = await f.submit('image');
  const result = await f.terminal(task.id);
  const artifact = result.result.artifacts[0];
  const outside = path.join(f.root, 'outside.png'); await fs.writeFile(outside, Buffer.from(PNG, 'base64'));
  await fs.unlink(artifact.path);
  try { await fs.symlink(outside, artifact.path, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) { t.skip('This platform does not permit the fixture file link'); return; } throw error; }
  await assert.rejects(f.team.dispatch('team/tasks/result', { mainSessionId: 'main', taskId: task.id }), error => error.code === 'artifact-path-escape');
});

test('unconfigured or disabled workers cannot receive tasks and unknown agents are not accepted', async t => {
  const f = await fixture(t, { agents: [
    { id: 'writer', name: 'Writer', enabled: true, hasKey: false },
    { id: 'disabled', name: 'Disabled', enabled: false, hasKey: true },
  ] });
  assert.deepEqual(await f.team.listAgents(), []);
  for (const agentId of ['writer', 'disabled', 'unknown']) await assert.rejects(f.submit('task', { agentId }), error => error.code === 'not-configured');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.team.listTasks('main'), []);
});

test('provider failures expose fixed safe errors without credentials or automatic retries', async t => {
  const f = await fixture(t, { outputFor: () => { throw Object.assign(new Error('Authorization: Bearer credential-fixture https://provider.invalid?key=credential-fixture'), { code: 'provider-auth', status: 401, headers: { authorization: 'credential-fixture' } }); } });
  const task = await f.submit('safe prompt');
  const result = await f.terminal(task.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'provider-auth');
  assert.equal(result.error.message, '鉴权失败，请检查密钥、接口地址、地区与账户权限。');
  assert.equal(result.error.status, 401);
  assert(!JSON.stringify(result).includes('credential-fixture'));
  assert(!(await fs.readFile(f.stateFile, 'utf8')).includes('credential-fixture'));
  assert.equal(f.calls.length, 1);
});

test('queue admission stays bounded under simultaneous submissions', async t => {
  const f = await fixture(t, { concurrency: 1, maxPending: 2 });
  const submitted = await Promise.allSettled(['one', 'two', 'three', 'four'].map(prompt => f.submit(prompt)));
  assert.equal(submitted.filter(result => result.status === 'fulfilled').length, 2);
  assert(submitted.filter(result => result.status === 'rejected').every(result => result.reason.code === 'team-queue-full'));
  assert.equal((await f.team.listTasks('main')).length, 2);
});

test('disposing interrupts queued/running tasks, settles provider cancellation and does not restart work', async t => {
  const f = await fixture(t, { concurrency: 1 });
  const running = await f.submit('running'); const queued = await f.submit('queued');
  await until(() => f.calls.length === 1);
  await f.team.dispose();
  assert.equal(f.inFlight.size, 0);
  assert.equal(f.calls[0].aborted, true);
  const persisted = JSON.parse(await fs.readFile(f.stateFile, 'utf8'));
  assert(persisted.tasks.filter(row => [running.id, queued.id].includes(row.id)).every(row => row.status === 'interrupted'));
  await f.restart();
  assert((await f.team.listTasks('main')).every(row => row.status === 'interrupted'));
  assert.equal(f.calls.length, 1);
});

test('malformed saved state is rejected and dispose does not replace it', async t => {
  const original = '{not valid state';
  const f = await fixture(t, { seed: original });
  await assert.rejects(f.team.listTasks('main'), error => error.code === 'team-state-unavailable');
  await f.team.dispose();
  assert.equal(await fs.readFile(f.stateFile, 'utf8'), original);
});

test('aborting submission during worker metadata lookup prevents admission and provider execution', async t => {
  const f = await fixture(t);
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  const originalList = f.store.list;
  f.store.list = async () => { entered = true; await gate; return originalList(); };
  const control = new AbortController();
  const submitted = f.submit('cancel before admission', { signal: control.signal });
  await until(() => entered);
  control.abort(new Error('fixture admission cancelled')); release();
  await assert.rejects(submitted, /fixture admission cancelled/);
  assert.deepEqual(await f.team.listTasks('main'), []);
  assert.equal(f.calls.length, 0);
});

test('configuration changes serialize with admission and busy workers cannot change underneath tasks', async t => {
  const f = await fixture(t);
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  const originalSave = f.store.save;
  f.store.save = async profile => { entered = true; await gate; return originalSave(profile); };
  const profile = { ...f.agents[0], name: 'Updated writer' };
  const saving = f.team.dispatch('team/agents/save', { mainSessionId: 'main', profile });
  await until(() => entered);
  const pending = f.submit('use updated worker');
  await tick(); assert.equal(f.calls.length, 0);
  release(); await saving;
  const task = await pending;
  assert.equal(task.agentName, 'Updated writer');
  await until(() => f.calls.length === 1);
  for (const [endpoint, payload] of [
    ['team/agents/save', { profile: { ...profile, name: 'Blocked change' } }],
    ['team/agents/remove', { agentId: 'writer' }],
  ]) await assert.rejects(f.team.dispatch(endpoint, { mainSessionId: 'main', ...payload }), error => error.code === 'agent-busy');
  f.calls[0].resolve(textOutput('done'));
  assert.equal((await f.terminal(task.id)).status, 'completed');
  await f.team.dispatch('team/agents/remove', { mainSessionId: 'main', agentId: 'writer' });
  assert.deepEqual(await f.team.listAgents(), []);
});

test('lists and tool-facing reads bound long previews while the result artifact and explicit fetch retain full text', async t => {
  const complete = 'A'.repeat(30000);
  const f = await fixture(t, { outputFor: () => textOutput(complete) });
  const task = await f.submit('long output');
  const finished = await f.terminal(task.id);
  const listed = (await f.team.listTasks('main'))[0];
  const fetched = await f.team.getTask('main', task.id);
  assert.equal(listed.result.text.match(/^A+/)[0].length, 1200);
  assert.equal(finished.result.text.match(/^A+/)[0].length, 24000);
  assert.equal(fetched.result.text, finished.result.text);
  assert.match(finished.result.text, /result\.md/);
  const artifact = finished.result.artifacts.find(item => item.name === 'result.md');
  assert.equal(await fs.readFile(artifact.path, 'utf8'), complete);
  const explicit = await f.team.dispatch('team/tasks/result', { mainSessionId: 'main', taskId: task.id });
  assert.equal(explicit.text, complete);
});

test('web delegation stores a handoff without issuing a provider request or waiting for a worker', async t => {
  const f = await fixture(t, { agents: [webAgent()] });
  assert.equal((await f.team.listAgents())[0].id, 'web');
  const task = await f.submit('检查边界', { agentId: 'web' });
  assert.equal(task.status, 'awaiting-user');
  assert.equal(task.executionMode, 'web-manual');
  assert.deepEqual(task.handoff, { url: 'https://chat.deepseek.com', prompt: '审查边界条件\n\n检查边界' });
  f.agents[0].baseUrl = 'https://www.doubao.com/chat/';
  f.agents[0].role = 'different';
  assert.deepEqual((await f.team.getTask('main', task.id)).handoff, task.handoff, 'handoff is a submission snapshot');
  const waited = await f.team.waitTasks('main', [task.id], AbortSignal.timeout(500));
  assert.equal(waited[0].status, 'awaiting-user');
  assert.equal(f.calls.length, 0);
});

test('manual answer completion is owned, durable, marked as pasted, and cannot overwrite a result', async t => {
  const f = await fixture(t, { agents: [webAgent()] });
  const task = await f.submit('review', { agentId: 'web' });
  await assert.rejects(f.team.completeManualTask({ mainSessionId: 'other', taskId: task.id, text: 'wrong owner' }), error => error.code === 'team-task-not-found');
  for (const text of ['', '   ', 'A'.repeat(100001)]) await assert.rejects(f.team.completeManualTask({ mainSessionId: 'main', taskId: task.id, text }), error => error.code === 'invalid-answer');
  const answer = '<script>untrusted source text</script>\nlocal test answer';
  const finished = await f.team.dispatch('team/tasks/complete-manual', { mainSessionId: 'main', taskId: task.id, text: answer });
  assert.equal(finished.status, 'completed');
  assert.equal(finished.result.provenance, 'user-paste');
  assert.equal(finished.result.text, answer);
  assert.equal(await fs.readFile(finished.result.artifacts[0].path, 'utf8'), answer);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.team.completeManualTask({ mainSessionId: 'main', taskId: task.id, text: 'replacement' }), error => error.code === 'not-awaiting-user');
  await f.restart();
  assert.deepEqual((await f.team.getTask('main', task.id)).result, finished.result);
});

test('waiting web tasks survive restart and do not occupy automatic worker slots', async t => {
  const writer = { id: 'writer', name: 'Writer', protocol: 'chat-completions', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', enabled: true, hasKey: true };
  const f = await fixture(t, { agents: [webAgent(), writer], concurrency: 1 });
  const manual = await f.submit('manual', { agentId: 'web' });
  const automatic = await f.submit('automatic');
  await until(() => f.calls.length === 1);
  assert.equal(f.calls[0].agentId, 'writer');
  await f.restart();
  assert.equal((await f.team.getTask('main', manual.id)).status, 'awaiting-user');
  assert.equal((await f.team.getTask('main', automatic.id)).status, 'interrupted');
  assert.equal(f.calls.length, 1, 'restart does not issue another request');
});

test('cancellation and duplicate completions cannot overwrite a manual result', async t => {
  const f = await fixture(t, { agents: [webAgent()] });
  const cancelled = await f.submit('cancel', { agentId: 'web' });
  await f.team.cancelTask('main', cancelled.id);
  await assert.rejects(f.team.completeManualTask({ mainSessionId: 'main', taskId: cancelled.id, text: 'late answer' }), error => error.code === 'not-awaiting-user');
  const task = await f.submit('duplicate', { agentId: 'web' });
  const results = await Promise.allSettled(['first', 'second'].map(text => f.team.completeManualTask({ mainSessionId: 'main', taskId: task.id, text })));
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.filter(value => value.status === 'rejected')[0].reason.code, 'not-awaiting-user');
  const completed = results.find(value => value.status === 'fulfilled').value;
  assert.equal((await f.team.cancelTask('main', task.id)).result.text, completed.result.text);
  assert.equal((await fs.readdir(path.dirname(completed.result.artifacts[0].path))).length, 1);
});

test('manual completion cannot complete an API task and aborted submission keeps the handoff', async t => {
  const f = await fixture(t);
  const apiTask = await f.submit('api task');
  await assert.rejects(f.team.completeManualTask({ mainSessionId: 'main', taskId: apiTask.id, text: 'fake provider result' }), error => error.code === 'not-awaiting-user');
  f.agents.push(webAgent());
  const manual = await f.submit('manual', { agentId: 'web' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.team.completeManualTask({ mainSessionId: 'main', taskId: manual.id, text: 'answer', signal: controller.signal }));
  assert.equal((await f.team.getTask('main', manual.id)).status, 'awaiting-user');
  await assert.rejects(fs.access(path.join(f.workspace, 'outputs', 'sidecar-agents', manual.id)));
});
