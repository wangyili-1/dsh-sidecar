import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSidecarService } from '../src/service.mjs';
import { expandRecord } from '../src/backend-events.mjs';
import { CONTEXT_HEADER, PACKET_HEADER, SIDE_INSTRUCTION, explicitPromptFromWire, promptTitle } from '../src/sidechat-titles.mjs';

const scratch = fileURLToPath(new URL('../../../work/', import.meta.url));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  await fs.mkdir(scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(scratch, 'sidecar-tests-'));
  const cwd = path.join(directory, 'workspace');
  const dataDir = path.join(directory, 'metadata');
  await fs.mkdir(cwd);
  const sessions = new Map();
  const prompts = [], cancels = [], follows = [], archives = [], pages = [];
  const archived = new Set();
  let number = 0;
  function add(id, events = [], extra = {}) {
    const entry = { id, events, listeners: new Set(), running: false, ...extra };
    sessions.set(id, entry);
    return entry;
  }
  add('main'); add('other-main');
  function emit(id, type, data = {}) {
    const session = sessions.get(id);
    const event = { type, data, time: Date.now(), seq: (session.events.at(-1)?.seq ?? -1) + 1 };
    session.events.push(event);
    if (type === 'turn/start') session.running = true;
    if (type === 'turn/end') session.running = false;
    for (const listener of session.listeners) listener({ type: 'event', event });
    return event;
  }
  const controller = {
    async list() { return { items: [...sessions.values()].map(s => ({ sessionId: s.id, running: s.running })) }; },
    async create(request) { assert.equal(request.cwd, await fs.realpath(cwd)); const sessionId = `side-${++number}`; add(sessionId); return { sessionId }; },
    async prompt(request, signal) { signal.throwIfAborted(); prompts.push(request); return { accepted: true }; },
    cancel(request) { cancels.push(request); emit(request.sessionId, 'turn/end', { turn: 1, reason: { kind: 'cancelled' } }); return { accepted: true }; },
    async page(request) {
      pages.push(request);
      const events = sessions.get(request.address.sessionId).events.filter(event => event.seq < request.beforeSeq && event.seq <= request.throughSeq);
      return { records: events.slice(-50).map(event => ({ type: 'event', event })), hasMore: events.length > 50 };
    },
    async *follow(request, signal) {
      const session = sessions.get(request.address.sessionId);
      if (!session) throw Object.assign(new Error('No such session'), { code: 'session/not-found' });
      follows.push(request.address.sessionId);
      const queue = [];
      let wake;
      const push = frame => { queue.push(frame); wake?.(); };
      const abort = () => wake?.();
      session.listeners.add(push);
      signal.addEventListener('abort', abort);
      try {
        if (session.snapshotDelay) await delay(session.snapshotDelay);
        yield { type: 'snapshot', header: { id: session.id, cwd }, cursor: session.events.at(-1)?.seq ?? -1, records: session.records ?? session.events.map(event => ({ type: 'event', event })), hasMore: session.hasMore ?? false, projections: { values: { title: session.title ?? session.id } } };
        while (!signal.aborted) {
          if (!queue.length) await new Promise(resolve => { wake = resolve; });
          while (queue.length) yield queue.shift();
        }
      } finally { session.listeners.delete(push); signal.removeEventListener('abort', abort); }
    },
  };
  const ctx = { sessionController: controller, sessions: { open() { throw new Error('Selection must never change'); } },
    workspaceController: { async archiveSession({ sessionId }) { assert(sessions.has(sessionId)); archives.push(sessionId); archived.add(sessionId); return { archivedSessionIds: [...archived] }; } },
  };
  const options = { cwd, dataDir, defaultCwd: cwd };
  let service = createSidecarService(ctx, options);
  t.after(async () => { await service.dispose(); await tick(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, cwd, dataDir, sessions, prompts, cancels, follows, archives, pages, emit, add, controller, ctx,
    get service() { return service; },
    async restart() { await service.dispose(); await tick(); service = createSidecarService(ctx, options); return service; },
    call(endpoint, payload = {}) { return service.dispatch(endpoint, { mainSessionId: 'main', ...payload }); },
  };
}

test('independent conversations, main queue and cancellation never cross ownership', async t => {
  const f = await fixture(t);
  f.emit('main', 'turn/start', { turn: 1 });
  const one = await f.call('sidechat/create', { includeContext: false });
  const two = await f.call('sidechat/create', { includeContext: false });
  assert.equal(f.prompts.length, 0, 'Creating a sidechat must not run a model');
  f.emit(one.id, 'turn/start', { turn: 1 });
  f.emit(two.id, 'turn/start', { turn: 1 });
  await Promise.all([
    f.call('conversation/send', { sessionId: one.id, text: 'first' }),
    f.call('conversation/send', { sessionId: two.id, text: 'second' }),
  ]);
  assert.deepEqual(new Set(f.prompts.map(x => x.sessionId)), new Set([one.id, two.id]));
  assert.ok(f.prompts.every(x => x.mode === 'queue' && /^[0-9a-f-]{36}$/.test(x.requestId)));
  assert.match(f.prompts[0].content[0].text, /不主动改文件或运行命令/);
  await f.call('conversation/cancel', { sessionId: one.id });
  await tick();
  const state = await f.call('state');
  assert.equal(state.main.running, true);
  assert.equal(state.sidechats.find(s => s.id === one.id).running, false);
  assert.equal(state.sidechats.find(s => s.id === two.id).running, true);
  assert.deepEqual(f.cancels, [{ sessionId: one.id }]);
  await assert.rejects(f.call('conversation/cancel', { mainSessionId: 'other-main', sessionId: two.id }), { code: 'sidechat-not-found' });
  await assert.rejects(f.call('conversation/send', { sessionId: 'main', text: 'bad routing' }), { code: 'sidechat-not-found' });
  await assert.rejects(f.call('conversation/get', { mainSessionId: one.id, sessionId: one.id }), { code: 'wrong-main' });
  await f.call('main/send', { text: 'explicit main request', mode: 'steer' });
  assert.equal(f.prompts.at(-1).sessionId, 'main');
  assert.equal(f.prompts.at(-1).mode, 'queue');
  await f.call('state'); await f.call('conversation/get', { sessionId: one.id });
  assert.equal(f.follows.filter(x => x === 'main').length, 1, 'Polling reuses the stream');
  assert.equal(f.follows.filter(x => x === one.id).length, 1);
});

test('side titles use the first accepted explicit text and ignore backend snapshots and title events', async t => {
  const f = await fixture(t);
  const side = await f.call('sidechat/create');
  f.sessions.get(side.id).title = '这是独立侧聊。只分析提供的';
  assert.equal((await f.call('state')).sidechats[0].title, '新对话');
  assert.equal((await f.call('conversation/get', { sessionId: side.id })).title, '新对话');

  const text = ' \n 分析 \t' + '🚀'.repeat(45) + '\n继续 ';
  const title = '分析 ' + '🚀'.repeat(17);
  await f.call('conversation/send', { sessionId: side.id, text });
  assert.equal((await f.call('conversation/get', { sessionId: side.id })).title, title);
  f.emit(side.id, 'session/title', { title: '这是独立侧聊。自动生成标题' });
  f.emit('main', 'session/title', { title: 'Updated main title' });
  await tick();
  await f.call('conversation/send', { sessionId: side.id, text: 'A later message must not rename it' });
  const state = await f.call('state');
  assert.equal(state.sidechats[0].title, title);
  assert.equal(state.main.title, 'Updated main title');
  assert.equal((await f.call('conversation/get', { sessionId: 'main' })).title, 'Updated main title');
  const metadata = JSON.parse(await fs.readFile(path.join(f.dataDir, 'sidecar-state.json'), 'utf8'));
  assert.equal(metadata.sidechats[0].title, title);
  assert.equal(metadata.sidechats[0].titleFromText, true);
  assert.equal(metadata.mains[0].title, 'Updated main title');
  await f.restart();
  assert.equal((await f.call('state')).sidechats[0].title, title);
  assert.equal((await f.call('conversation/get', { sessionId: side.id })).title, title);
});

test('rejected messages and packet-only prompts do not claim the side title', async t => {
  const f = await fixture(t);
  const side = await f.call('sidechat/create');
  const prompt = f.controller.prompt;
  f.controller.prompt = async () => ({ accepted: false });
  await assert.rejects(f.call('conversation/send', { sessionId: side.id, text: 'Rejected title' }), { code: 'prompt-rejected' });
  let metadata = JSON.parse(await fs.readFile(path.join(f.dataDir, 'sidecar-state.json'), 'utf8'));
  assert.equal(metadata.sidechats[0].title, '新对话');
  assert.equal(metadata.sidechats[0].titleFromText, false);
  assert.equal(metadata.sidechats[0].initialized, false);
  f.controller.prompt = prompt;
  await f.call('conversation/send', { sessionId: side.id, text: ' \n\t ', packets: [{ kind: 'file', source: 'note.txt', text: 'Reference text cannot become a title' }] });
  await f.restart();
  assert.equal((await f.call('state')).sidechats[0].title, '新对话');
  await f.call('conversation/send', { sessionId: side.id, text: '  Accepted\n\t human   title  ' });
  metadata = JSON.parse(await fs.readFile(path.join(f.dataDir, 'sidecar-state.json'), 'utf8'));
  assert.equal(metadata.sidechats[0].title, 'Accepted human title');
  assert.equal(metadata.sidechats[0].titleFromText, true);
  assert.equal((await f.call('conversation/get', { sessionId: side.id })).title, 'Accepted human title');
});

test('legacy injected titles use an honest untitled fallback while explicit titles survive', async t => {
  const f = await fixture(t);
  const one = await f.call('sidechat/create');
  const two = await f.call('sidechat/create');
  const other = await f.call('sidechat/create', { mainSessionId: 'other-main' });
  const explicit = await f.call('sidechat/create');
  const humanTitle = '这是独立侧聊的标题问题';
  await f.call('conversation/send', { sessionId: explicit.id, text: humanTitle });
  const database = path.join(f.dataDir, 'sidecar-state.json');
  const metadata = JSON.parse(await fs.readFile(database, 'utf8'));
  for (const row of metadata.sidechats) if (row.id !== explicit.id) {
    row.title = '这是独立侧聊。只分析提供的';
    delete row.titleFromText;
  }
  await fs.writeFile(database, JSON.stringify(metadata));
  await f.restart();
  assert.deepEqual((await f.call('state')).sidechats.map(({ id, title }) => ({ id, title })), [
    { id: one.id, title: '新对话' }, { id: two.id, title: '新对话' }, { id: explicit.id, title: humanTitle },
  ]);
  assert.equal((await f.call('conversation/get', { sessionId: two.id })).title, '新对话');
  assert.deepEqual((await f.call('state', { mainSessionId: 'other-main' })).sidechats.map(({ id, title }) => ({ id, title })), [{ id: other.id, title: '新对话' }]);
  const repaired = JSON.parse(await fs.readFile(database, 'utf8'));
  assert.equal(repaired.sidechats.find(row => row.id === two.id).title, '新对话');
});

test('permanent close archives only its owned idle sidechat and survives restart without deleting history', async t => {
  const f = await fixture(t);
  const first = await f.call('sidechat/create');
  const second = await f.call('sidechat/create');
  f.emit(first.id, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep this durable history' }] });
  f.emit('main', 'turn/start'); f.emit(second.id, 'turn/start');
  await assert.rejects(f.call('sidechat/close', { mainSessionId: 'other-main', sessionId: first.id }), { code: 'sidechat-not-found' });
  await assert.rejects(f.call('sidechat/close', { sessionId: 'main' }), { code: 'sidechat-not-found' });
  await assert.rejects(f.call('sidechat/close', { sessionId: second.id }), { code: 'sidechat-running' });
  assert.deepEqual(f.archives, []); assert.deepEqual(f.cancels, []);
  const closed = await f.call('sidechat/close', { sessionId: first.id });
  assert.deepEqual(closed, { id: first.id, closed: true, archived: true, historyRetained: true });
  await tick();
  assert.equal(f.sessions.get(first.id).listeners.size, 0, 'closed chat stream is released');
  assert.equal(f.sessions.get(first.id).events.length, 1, 'native history is untouched');
  assert(f.sessions.get('main').running); assert(f.sessions.get(second.id).running);
  assert.deepEqual(f.archives, [first.id]);
  assert.deepEqual(await f.call('sidechat/close', { sessionId: first.id }), closed, 'close is idempotent');
  assert.deepEqual(f.archives, [first.id]);
  const state = await f.call('state');
  assert.deepEqual(state.sidechats.map(side => side.id), [second.id]);
  assert.deepEqual(state.closedSidechatIds, [first.id]);
  assert.deepEqual((await f.call('state', { mainSessionId: 'other-main' })).closedSidechatIds, []);
  await f.restart();
  assert.deepEqual((await f.call('state')).sidechats.map(side => side.id), [second.id]);
  assert.deepEqual((await f.call('state')).closedSidechatIds, [first.id]);
  for (const endpoint of ['conversation/get', 'conversation/send', 'conversation/cancel']) await assert.rejects(f.call(endpoint, { sessionId: first.id, text: 'stale tab' }), { code: 'sidechat-closed' });
  await assert.rejects(f.call('main/send', { sourceSessionId: first.id, text: 'stale return' }), { code: 'sidechat-closed' });
  assert.equal(f.prompts.length, 0); assert.equal(f.cancels.length, 0);
});

test('close and sends are serialized, so stale tabs cannot enqueue after permanent close', async t => {
  const f = await fixture(t); const side = await f.call('sidechat/create');
  let admit; let sending;
  const startedSend = new Promise(resolve => { sending = resolve; });
  f.controller.prompt = async request => { f.prompts.push(request); sending(); await new Promise(resolve => { admit = resolve; }); return { accepted: true }; };
  const activeSend = f.call('conversation/send', { sessionId: side.id, text: 'First question' });
  await startedSend;
  await assert.rejects(f.call('sidechat/close', { sessionId: side.id }), { code: 'sidechat-running' });
  admit(); await activeSend;
  let archive; let archiving;
  const startedArchive = new Promise(resolve => { archiving = resolve; });
  f.ctx.workspaceController.archiveSession = async ({ sessionId }) => { archiving(); await new Promise(resolve => { archive = resolve; }); return { archivedSessionIds: [sessionId] }; };
  const closing = f.call('sidechat/close', { sessionId: side.id });
  await startedArchive;
  const staleSend = assert.rejects(f.call('conversation/send', { sessionId: side.id, text: 'Must not be sent' }), { code: 'sidechat-closed' });
  const staleReturn = assert.rejects(f.call('main/send', { sourceSessionId: side.id, text: 'Must not reach main' }), { code: 'sidechat-closed' });
  await tick(); archive(); await closing; await staleSend; await staleReturn;
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].sessionId, side.id);
});

test('failed native archive keeps the chat open and unavailable archival still supports durable local close', async t => {
  const f = await fixture(t); const side = await f.call('sidechat/create');
  f.ctx.workspaceController.archiveSession = async () => { throw new Error('fixture archive failed'); };
  await assert.rejects(f.call('sidechat/close', { sessionId: side.id }), { code: 'sidechat-archive-failed' });
  assert.equal((await f.call('state')).sidechats.length, 1);
  f.ctx.workspaceController.archiveSession = async () => ({ archivedSessionIds: [] });
  await assert.rejects(f.call('sidechat/close', { sessionId: side.id }), { code: 'sidechat-archive-failed' });
  delete f.ctx.workspaceController;
  const closed = await f.call('sidechat/close', { sessionId: side.id });
  assert.equal(closed.archived, false); assert.equal(closed.historyRetained, true);
  await f.restart();
  assert.deepEqual((await f.call('state')).closedSidechatIds, [side.id]);
});

test('a missing or failed fresh running baseline refuses closure instead of trusting a stale idle cache', async t => {
  const f = await fixture(t); const side = await f.call('sidechat/create');
  await f.call('state');
  f.controller.list = async () => ({ items: [{ sessionId: 'main', running: false }] });
  await assert.rejects(f.call('sidechat/close', { sessionId: side.id }), { code: 'sidechat-state-unavailable' });
  f.controller.list = async () => { throw new Error('fixture list failure'); };
  await assert.rejects(f.call('sidechat/close', { sessionId: side.id }), { code: 'sidechat-state-unavailable' });
  assert.deepEqual(f.archives, []);
  assert.equal((await f.call('state')).sidechats.length, 1);
});

test('legacy numeric titles recover the first real question across history pages and ignore all wrapped context', async t => {
  const f = await fixture(t); const side = await f.call('sidechat/create', { includeContext: true });
  const packet = { kind: 'file', source: 'fixture.py', text: 'This is reference data, never a title' };
  await f.call('conversation/send', { sessionId: side.id, text: '', packets: [packet] });
  f.emit(side.id, 'user/message', { source: { kind: 'user' }, content: f.prompts[0].content });
  f.emit(side.id, 'user/message', { source: { kind: 'system' }, content: [{ type: 'text', text: 'Synthetic context must not title the chat' }] });
  await f.call('conversation/send', { sessionId: side.id, text: '请帮我分析侧栏动画为什么遮住主页面', packets: [packet] });
  f.emit(side.id, 'user/message', { source: { kind: 'user' }, content: f.prompts[1].content });
  for (let index = 0; index < 140; index++) f.emit(side.id, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `Later question ${index}` }] });
  f.sessions.get(side.id).records = f.sessions.get(side.id).events.slice(-12).map(event => ({ type: 'event', event }));
  f.sessions.get(side.id).hasMore = true;
  const database = path.join(f.dataDir, 'sidecar-state.json');
  const metadata = JSON.parse(await fs.readFile(database, 'utf8'));
  Object.assign(metadata.sidechats[0], { title: '侧聊 17', titleFromText: false }); delete metadata.sidechats[0].firstPromptTitle;
  await fs.writeFile(database, JSON.stringify(metadata)); await f.restart();
  const state = await f.call('state');
  assert.equal(state.sidechats[0].title, '分析侧栏动画为什么遮住主页面');
  assert(f.pages.length >= 2, 'migration must reach the complete prefix rather than rename from the recent tail');
  assert(f.pages.every(request => request.address.sessionId === side.id));
  const repaired = JSON.parse(await fs.readFile(database, 'utf8')).sidechats[0];
  assert.equal(repaired.titleFromText, true); assert.equal(repaired.titleNeedsRecovery, false);
  await f.restart();
  assert.equal((await f.call('state')).sidechats[0].title, repaired.title);
});

test('unreadable earliest history remains untitled instead of borrowing a later question or native wrapper title', async t => {
  const f = await fixture(t); const side = await f.call('sidechat/create');
  f.sessions.get(side.id).hasMore = true;
  f.emit(side.id, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Later visible question' }] });
  f.sessions.get(side.id).title = 'A native title cannot prove the first explicit request';
  const database = path.join(f.dataDir, 'sidecar-state.json');
  const metadata = JSON.parse(await fs.readFile(database, 'utf8'));
  Object.assign(metadata.sidechats[0], { title: '侧聊 5', initialized: true });
  await fs.writeFile(database, JSON.stringify(metadata)); await f.restart();
  f.controller.page = async () => { throw new Error('fixture read failure'); };
  assert.equal((await f.call('state')).sidechats[0].title, '新对话');
  await f.call('conversation/send', { sessionId: side.id, text: 'Another later question' });
  assert.equal((await f.call('state')).sidechats[0].title, '新对话');
});

test('short titles and wrapper recovery do not use quoted attachments or system instructions', () => {
  assert.equal(promptTitle('请帮我总结这个开源项目的安装方法以及常见报错如何修复'), '总结这个开源项目的安装方法以及常见报错');
  assert.equal(promptTitle('Explain why this failing Python property test loses information during round trip'), 'Explain why this failing Python property test loses');
  assert.equal(promptTitle('> A quoted paragraph\n```python\nsecret = 3\n```\n如何修复这个错误？然后讲讲原理'), '如何修复这个错误？');
  const quoted = CONTEXT_HEADER + '\n' + JSON.stringify({ source: 'main', text: 'Quoted main instructions' });
  const packet = PACKET_HEADER + '\n' + JSON.stringify([{ kind: 'file', source: 'a.py', text: 'Quoted code' }]);
  assert.equal(explicitPromptFromWire([SIDE_INSTRUCTION, quoted, 'How to reproduce this bug?', packet].join('\n\n')), 'How to reproduce this bug?');
  assert.equal(explicitPromptFromWire([SIDE_INSTRUCTION, quoted, '', packet].join('\n\n')), '');
  assert.equal(explicitPromptFromWire(SIDE_INSTRUCTION + '\n\n' + CONTEXT_HEADER + '\nnot-json\n\nUnknown tail'), '');
});

test('mixed-language titles retain whole project names and remove only narrow answer-format preambles', () => {
  const title = promptTitle('只根据引用报告，用两句话说明 humanize 的最小反例和实际/期望值。保持整数的所有数字准确，不调用工具、不读写文件。');
  assert.equal(title, 'humanize 最小反例和实际/期望值');
  assert(title.includes('humanize')); assert(!title.includes('引用报告'));
  assert.equal(promptTitle('只根据引用报告，用两句话说明 python-dotenv 的最小反例和期望值。'), 'python-dotenv 最小反例和期望值');
  assert.equal(promptTitle('分析这些参数造成的 hyperparameterization 错误'), '分析这些参数造成的 hyperparameterization');
  assert.equal(promptTitle('根据特征报告预测故障时间'), '根据特征报告预测故障时间', 'domain-specific source requirements are not stripped');
});

test('packed streaming text is visible, internal reasoning stays hidden and final messages deduplicate', async t => {
  const f = await fixture(t);
  const record = { type: 'chunks', event: { type: 'chunkrow/text-chunks', seq: 2, time: 1000, data: { turn: 1, step: 1, index: 1, texts: ['hello', ' world'], dt: [10] } } };
  f.sessions.get('main').records = [
    { type: 'event', event: { type: 'turn/start', seq: 0, time: 990, data: { turn: 1 } } },
    { type: 'chunks', event: { type: 'chunkrow/reasoning-chunks', seq: 1, time: 999, data: { turn: 1, step: 1, index: 0, texts: ['PRIVATE_REASONING'], dt: [] } } },
    record,
  ];
  f.sessions.get('main').events = [{ type: 'assistant/chunk', seq: 3, time: 1010, data: {} }];
  f.sessions.get('main').running = true;
  const projected = await f.call('conversation/get', { sessionId: 'main' });
  assert.equal(projected.messages.length, 1);
  assert.equal(projected.messages[0].text, 'hello world');
  assert.equal(projected.running, true);
  assert.equal(expandRecord(record)[1].time, 1010);
  f.emit('main', 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text: 'hello world!' }] } });
  f.emit('main', 'tool/call', { callId: 'call1', name: 'read_file', arguments: '{"path":"a.txt"}' });
  f.emit('main', 'tool/result', { message: { id: 'tool1', content: [{ type: 'tool-result', toolCallId: 'call1', content: [{ type: 'text', text: 'actual output' }] }] } });
  f.emit('main', 'turn/end', { turn: 1 });
  await tick();
  const final = await f.call('conversation/get', { sessionId: 'main' });
  assert.deepEqual(final.messages.map(m => m.role), ['assistant', 'tool', 'tool']);
  assert.equal(final.messages[0].text, 'hello world!');
  assert.ok(!JSON.stringify(final).includes('PRIVATE_REASONING'));
  assert.equal(final.running, false);
  assert.throws(() => expandRecord({ ...record, event: { ...record.event, data: { ...record.event.data, dt: [] } } }), /Malformed/);
});

test('mid-turn bounded history receives real running baseline', async t => {
  const f = await fixture(t);
  const main = f.sessions.get('main');
  main.hasMore = true; main.running = true;
  main.events = [{ type: 'assistant/chunk', seq: 5000, time: 1, data: { turn: 5, step: 10, chunk: { type: 'text-delta', index: 0, text: 'still busy' } } }];
  assert.equal((await f.call('state')).main.running, true);
});

test('completed-only context, explicit source packets, and durable ownership survive restart', async t => {
  const f = await fixture(t);
  f.emit('main', 'turn/start', { turn: 1 });
  f.emit('main', 'user/message', { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'completed question' }] });
  f.emit('main', 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'completed answer' }] } });
  f.emit('main', 'turn/end', { turn: 1 });
  f.emit('main', 'turn/start', { turn: 2 });
  f.emit('main', 'user/message', { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'unfinished question' }] });
  f.emit('main', 'tool/call', { callId: 'unsafe', name: 'write_file', arguments: 'DO_NOT_REPLAY' });
  const side = await f.call('sidechat/create', { includeContext: true });
  await f.restart();
  const packet = { kind: 'file', source: 'src/example.js', text: 'REFERENCE_ONLY', startLine: 2, endLine: 3, sha256: 'source-digest' };
  await f.call('conversation/send', { sessionId: side.id, text: 'explain', packets: [packet] });
  const sent = f.prompts[0].content[0].text;
  assert.match(sent, /completed question/); assert.match(sent, /completed answer/);
  assert.ok(!sent.includes('unfinished question')); assert.ok(!sent.includes('DO_NOT_REPLAY'));
  assert.match(sent, /source-digest/); assert.match(sent, /REFERENCE_ONLY/); assert.match(sent, /startLine/);
  await f.call('conversation/send', { sessionId: side.id, text: 'continue' });
  assert.equal(f.prompts[1].content[0].text, 'continue', 'Initial context and guard are sent exactly once');
  const metadata = JSON.parse(await fs.readFile(path.join(f.dataDir, 'sidecar-state.json'), 'utf8'));
  assert.equal(metadata.sidechats[0].mainSessionId, 'main');
  assert.equal(metadata.sidechats[0].references[0].packets[0].sha256, 'source-digest');
  assert.ok(!JSON.stringify(metadata).includes('REFERENCE_ONLY'), 'Reference metadata does not persist packet text');
  await f.restart();
  assert.equal((await f.call('state')).sidechats[0].id, side.id);
});

test('files remain inside the main workspace and exclude credentials, links outside, binaries, and large tails', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, 'readme.txt'), 'visible text\n');
  await fs.writeFile(path.join(f.cwd, '.env'), 'PRIVATE_VALUE=secret');
  await fs.writeFile(path.join(f.cwd, 'secret.key'), 'private');
  await fs.writeFile(path.join(f.cwd, 'binary.dat'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(f.cwd, 'large.txt'), 'a'.repeat(600000));
  await fs.mkdir(path.join(f.cwd, 'node_modules'));
  const outside = path.join(f.directory, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'external.txt'), 'external');
  await fs.symlink(outside, path.join(f.cwd, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const listing = await f.call('files/list');
  assert.ok(listing.entries.some(x => x.name === 'readme.txt'));
  for (const excluded of ['.env', 'secret.key', 'node_modules', 'external-link']) assert.ok(!listing.entries.some(x => x.name === excluded));
  assert.equal((await f.call('files/read', { path: 'readme.txt' })).text, 'visible text\n');
  await assert.rejects(f.call('files/read', { path: '../outside/external.txt' }), { code: 'invalid-path' });
  await assert.rejects(f.call('files/read', { path: 'external-link/external.txt' }), { code: 'path-outside-workspace' });
  await assert.rejects(f.call('files/read', { path: '.env' }), { code: 'restricted-file' });
  await assert.rejects(f.call('files/read', { path: 'binary.dat' }), { code: 'not-text' });
  const large = await f.call('files/read', { path: 'large.txt' });
  assert.equal(large.truncated, true); assert.equal(large.text.length, 512 * 1024);
  assert.match(large.sha256, /^[a-f0-9]{64}$/);
});

test('real independent command jobs report output and exit code; cancelling one preserves another', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const win = process.platform === 'win32';
  const first = await f.call('terminal/run', { command: win ? "Start-Sleep -Seconds 10; Write-Output 'CANCELLED_TOO_LATE'" : "sleep 10; printf 'CANCELLED_TOO_LATE'" });
  const second = await f.call('terminal/run', { command: win ? "Start-Sleep -Seconds 1; Write-Output 'SIDE_ECHO'" : "sleep 1; printf 'SIDE_ECHO'" });
  await assert.rejects(f.call('terminal/cancel', { mainSessionId: 'other-main', id: first.id }), { code: 'job-not-found' });
  await f.call('terminal/cancel', { id: first.id });
  let a, b;
  for (let attempt = 0; attempt < 80; attempt++) {
    a = await f.call('terminal/get', { id: first.id }); b = await f.call('terminal/get', { id: second.id });
    if (!a.running && !b.running) break;
    await delay(100);
  }
  assert.equal(a.running, false); assert.equal(a.reason, 'cancelled'); assert.ok(!a.output.includes('CANCELLED_TOO_LATE'));
  assert.equal(b.running, false); assert.equal(b.exitCode, 0); assert.match(b.output, /SIDE_ECHO/); assert.equal(b.pty, false);
  assert.equal(b.cwd, await fs.realpath(f.cwd));
});

test('request cancellation does not abort shared follow or another conversation', async t => {
  const f = await fixture(t);
  await f.call('state');
  const abort = new AbortController(); abort.abort(new Error('client disconnected'));
  await assert.rejects(f.service.dispatch('state', { mainSessionId: 'main' }, abort.signal), /client disconnected/);
  assert.equal((await f.call('state')).main.id, 'main');
  assert.equal(f.follows.filter(x => x === 'main').length, 1);
});

test('disconnecting during shared history startup leaves its subscription usable', async t => {
  const f = await fixture(t);
  f.sessions.get('main').snapshotDelay = 80;
  const abort = new AbortController();
  const opening = f.service.dispatch('state', { mainSessionId: 'main' }, abort.signal);
  const rejected = assert.rejects(opening, /client disconnected/);
  await delay(15);
  abort.abort(new Error('client disconnected'));
  await rejected;
  assert.equal((await f.call('state')).main.id, 'main');
  assert.equal(f.follows.filter(x => x === 'main').length, 1);
});

test('terminal text is UTF-8 and output retention is bounded to 256 KiB', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const command = process.platform === 'win32' ? "[Console]::Write(('界' * 100000))" : "node -e \"process.stdout.write('界'.repeat(100000))\"";
  const job = await f.call('terminal/run', { command });
  let result;
  for (let attempt = 0; attempt < 80; attempt++) {
    result = await f.call('terminal/get', { id: job.id });
    if (!result.running) break;
    await delay(100);
  }
  assert.equal(result.running, false); assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(result.output) <= 256 * 1024);
  assert.ok(result.output.startsWith('界界')); assert.ok(!result.output.includes('\ufffd'));
});
