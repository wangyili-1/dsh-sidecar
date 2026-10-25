import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSidecarService } from '../lib/service.mjs';

// This is an opt-in, local acceptance plugin. Normal Sidecar startup never loads it.
// Loading it with config.run=true performs real model calls against the existing Host.
export const inject = ['sessionController'];
export const name = 'dsh-sidecar-local-acceptance';

export function apply(ctx, config = {}) {
  if (config.run !== true) throw new Error('Acceptance is opt-in: set config.run: true to make real model calls.');

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const outputPath = resolve(config.outputPath || resolve(root, '.local', 'acceptance-latest.json'));
  const controller = new AbortController();
  const ownSessions = new Set();
  const followers = [];
  let service;
  let task;
  let cleaned = false;
  const proof = {
    format: 1,
    runId,
    dshVersion: '0.1.2-rc.1',
    sourceCommit: 'a66e4702047846cdaa10c66c9d3df3951f5ea70d',
    startedAt: new Date().toISOString(),
    status: 'running',
    sessions: {},
    checks: {},
    observations: [],
    events: {},
    publicOutputs: {},
  };

  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    controller.abort();
    // Only identities allocated by this acceptance run can be cancelled.
    for (const sessionId of ownSessions) {
      try { await ctx.sessionController.cancel({ sessionId }); } catch { /* A finished session needs no cancellation. */ }
    }
    await service?.dispose();
    await Promise.allSettled(followers);
  }

  // Register cleanup before starting any asynchronous setup or model activity.
  ctx.effect(() => async () => {
    await cleanup();
    await task?.catch(() => {});
  }, 'dsh-sidecar acceptance: owned sessions and observers');

  async function save() {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  }

  function observe(name, values = {}) {
    proof.observations.push({ name, at: new Date().toISOString(), ...values });
  }

  function follow(sessionId, label) {
    const rows = proof.events[label] = [];
    const seen = new Set();
    const watcher = (async () => {
      for await (const frame of ctx.sessionController.follow({
        address: { kind: 'session', sessionId }, maxMessages: 100,
      }, controller.signal)) {
        const records = frame.type === 'snapshot' ? frame.records : [frame];
        for (const record of records) {
          const event = record.event;
          if (!event || seen.has(event.seq)) continue;
          seen.add(event.seq);
          // Do not serialize event data, tool arguments, model reasoning, or metadata.
          rows.push({ type: event.type, seq: event.seq, time: event.time });
        }
      }
    })().catch(error => {
      if (!controller.signal.aborted) observe(`${label}-observer-error`, { message: String(error?.message || error) });
    });
    followers.push(watcher);
  }

  async function delay(ms) {
    controller.signal.throwIfAborted();
    await new Promise((resolveDelay, reject) => {
      const timer = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolveDelay(); }, ms);
      const onAbort = () => { clearTimeout(timer); reject(new Error('Acceptance stopped')); };
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function until(label, read, test, timeout = Number(config.timeoutMs) || 120000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      controller.signal.throwIfAborted();
      const value = await read();
      if (test(value)) return value;
      await delay(250);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async function running(sessionId) {
    const list = await ctx.sessionController.list({}, controller.signal);
    return list.items.find(row => row.sessionId === sessionId)?.running === true;
  }

  function assistantText(conversation) {
    return (conversation.messages || [])
      .filter(message => message.role === 'assistant' && typeof message.text === 'string')
      .map(message => message.text).join('\n');
  }

  async function run() {
    await save();
    const defaultCwd = resolve(config.defaultCwd || root);
    service = createSidecarService(ctx, {
      dataDir: resolve(config.dataDir || resolve(root, '.local', `acceptance-state-${runId}`)),
      defaultCwd,
    });
    const main = await ctx.sessionController.create({ cwd: defaultCwd });
    ownSessions.add(main.sessionId);
    proof.sessions.main = main.sessionId;
    follow(main.sessionId, 'main');
    const call = (endpoint, payload) => service.dispatch(endpoint, payload, controller.signal);
    const address = { mainSessionId: main.sessionId };
    const side = await call('sidechat/create', { ...address, includeContext: false });
    ownSessions.add(side.id);
    proof.sessions.side = side.id;
    proof.checks.distinctSessions = side.id !== main.sessionId;
    follow(side.id, 'side');
    const get = sessionId => call('conversation/get', { ...address, sessionId });
    const waitSeconds = Math.max(1, Math.min(60, Number(config.mainWaitSeconds) || 15));
    const mainPrompt = marker => `这是本地并发验收。请实际执行一个无副作用的 PowerShell 命令：Start-Sleep -Seconds ${waitSeconds}; Write-Output '${marker}'。等待命令结束后，最终回答仅写 ${marker}。不得读取或修改文件。`;

    await call('main/send', { ...address, text: mainPrompt('MAIN_DONE_A'), packets: [] });
    await until('first main running', () => running(main.sessionId), Boolean, 30000);
    observe('main-first-running');
    await call('conversation/send', { ...address, sessionId: side.id, text: '这是一项并发验收。不要调用任何工具。最终回答仅写 SIDE_DONE。', packets: [] });
    const sideReply = await until('side public reply', () => get(side.id), value => assistantText(value).includes('SIDE_DONE'));
    proof.publicOutputs.side = assistantText(sideReply).slice(-4000);
    proof.checks.mainRunningAtSideReply = await running(main.sessionId);
    observe('side-replied', { mainRunning: proof.checks.mainRunningAtSideReply });
    const firstMain = await until('first main final result', () => get(main.sessionId), value => !value.running && assistantText(value).includes('MAIN_DONE_A'));
    proof.publicOutputs.mainFirst = assistantText(firstMain).slice(-4000);
    proof.checks.mainCompletedAfterSideReply = true;
    await save();

    await call('main/send', { ...address, text: mainPrompt('MAIN_DONE_B'), packets: [] });
    await until('second main running', () => running(main.sessionId), Boolean, 30000);
    await call('conversation/send', {
      ...address, sessionId: side.id,
      text: '不要调用工具。请从一到五百依次写出中文数字，每个数字独占一行，不省略，不解释。', packets: [],
    });
    await until('side turn running before cancellation', () => running(side.id), Boolean, 30000);
    proof.checks.mainRunningBeforeSideCancel = await running(main.sessionId);
    observe('before-side-cancel', { mainRunning: proof.checks.mainRunningBeforeSideCancel, sideRunning: true });
    await call('conversation/cancel', { ...address, sessionId: side.id });
    proof.checks.mainRunningAfterSideCancel = await running(main.sessionId);
    await until('side turn stopped', () => running(side.id), value => !value, 30000);
    proof.checks.sideStoppedAfterCancel = true;
    observe('after-side-cancel', { mainRunning: proof.checks.mainRunningAfterSideCancel, sideRunning: false });
    const secondMain = await until('second main final result', () => get(main.sessionId), value => !value.running && assistantText(value).includes('MAIN_DONE_B'));
    proof.publicOutputs.mainSecond = assistantText(secondMain).slice(-4000);
    proof.checks.mainCompletedAfterSideCancel = true;
    proof.status = Object.values(proof.checks).every(value => value === true) ? 'passed' : 'failed';
  }

  task = run().catch(error => {
    proof.status = 'failed';
    proof.failure = { message: String(error?.message || error) };
  }).finally(async () => {
    proof.finishedAt = new Date().toISOString();
    await cleanup();
    await save();
  });
}
