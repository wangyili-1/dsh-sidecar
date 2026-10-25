import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { applyEvent, completedContext, expandRecord, publicMessages, resetProjection } from './backend-events.mjs';
import { createTerminalManager, failure, listFiles, readFile } from './backend-workspace.mjs';
import { CONTEXT_HEADER, NEW_SIDECHAT_TITLE, PACKET_HEADER, SIDE_INSTRUCTION, needsTitleRecovery, promptTitle } from './sidechat-titles.mjs';
import { createTeamService } from './team-service.mjs';

const VERSION = '0.1.0';
const hash = text => createHash('sha256').update(text).digest('hex');
function id(value, field) {
  if (typeof value !== 'string' || !/^[\w.:-]{1,160}$/.test(value)) throw failure('invalid-argument', `${field} is required and must be a valid session/job ID.`);
  return value;
}
function string(value, field, limit, empty = false) {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) throw failure('invalid-argument', `${field} must be text of at most ${limit} characters.`);
  return value;
}
function checkAbort(signal) { if (signal?.aborted) throw signal.reason ?? failure('aborted', 'Request cancelled.'); }
function withAbort(promise, signal) {
  if (!signal) return promise;
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? failure('aborted', 'Request cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
  });
}

function packetsOf(raw = []) {
  if (!Array.isArray(raw) || raw.length > 20) throw failure('invalid-packets', 'At most 20 context packets may be attached.');
  let total = 0;
  return raw.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid-packets', 'Invalid context packet.');
    const packet = { kind: string(value.kind, 'packet.kind', 40), source: string(value.source, 'packet.source', 4096), text: string(value.text, 'packet.text', 524288, true) };
    total += packet.text.length;
    if (total > 600000) throw failure('invalid-packets', 'Context packets exceed the combined text limit.');
    for (const key of ['startLine', 'endLine']) if (value[key] !== undefined) {
      if (!Number.isSafeInteger(value[key]) || value[key] < 1) throw failure('invalid-packets', `${key} must be a positive integer.`);
      packet[key] = value[key];
    }
    if (packet.startLine && packet.endLine && packet.endLine < packet.startLine) throw failure('invalid-packets', 'Invalid line range.');
    if (value.url !== undefined) packet.url = string(value.url, 'packet.url', 4096);
    for (const key of ['sha256', 'sourceHash', 'sourcehash']) if (value[key] !== undefined) packet[key] = string(value[key], `packet.${key}`, 200);
    packet.contentSha256 = hash(packet.text);
    return packet;
  });
}

function promptText(text, packets, side, context) {
  const parts = [];
  if (side) parts.push(SIDE_INSTRUCTION);
  if (context?.text) {
    parts.push(CONTEXT_HEADER + '\n' + JSON.stringify({ source: context.source, throughSeq: context.throughSeq, capturedAt: context.capturedAt, text: context.text }));
  }
  parts.push(text);
  if (packets.length) parts.push(PACKET_HEADER + '\n' + JSON.stringify(packets));
  return parts.join('\n\n');
}

/** Host-local service; uses authenticated sessionController and never changes client selection. */
export function createSidecarService(ctx, { dataDir, defaultCwd } = {}) {
  if (!ctx?.sessionController) throw new Error('sessionController is required');
  if (!dataDir || !defaultCwd) throw new Error('dataDir and defaultCwd are required');
  const controller = ctx.sessionController;
  const database = path.join(dataDir, 'sidecar-state.json');
  const mains = new Map();
  const sides = new Map();
  const caches = new Map();
  const sendLocks = new Map();
  const terminal = createTerminalManager();
  let disposed = false;
  let writeQueue = Promise.resolve();
  const init = (async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    let stored;
    try { stored = JSON.parse(await fs.readFile(database, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw failure('state-unavailable', `Cannot read sidecar metadata: ${error.message}`); }
    if (stored.schema !== 1 || !Array.isArray(stored.mains) || !Array.isArray(stored.sidechats)) throw failure('state-unavailable', 'Unsupported sidecar metadata schema.');
    for (const row of stored.mains) { id(row.id, 'stored main ID'); mains.set(row.id, { id: row.id, title: typeof row.title === 'string' ? row.title : '主会话', references: Array.isArray(row.references) ? row.references.slice(-50) : [] }); }
    let repairedTitles = false;
    for (const row of stored.sidechats) {
      id(row.id, 'stored side ID'); id(row.mainSessionId, 'stored owner ID');
      if (!mains.has(row.mainSessionId) || mains.has(row.id) || sides.has(row.id)) throw failure('state-unavailable', 'Invalid sidechat ownership metadata.');
      const explicit = row.titleFromText === true ? promptTitle(row.firstPromptTitle || row.title) : '';
      const recover = !explicit && needsTitleRecovery(row.title);
      const title = explicit || (recover ? NEW_SIDECHAT_TITLE : row.title);
      if (title !== row.title) repairedTitles = true;
      sides.set(row.id, { ...row, title, ...(recover ? { titleNeedsRecovery: true } : {}) });
    }
    if (repairedTitles) await persist();
  })();
  init.catch(() => {});

  function persist() {
    const body = JSON.stringify({ schema: 1, mains: [...mains.values()], sidechats: [...sides.values()] }, null, 2);
    const task = writeQueue.catch(() => {}).then(async () => {
      const temporary = path.join(dataDir, `sidecar-state.${randomUUID()}.tmp`);
      await fs.writeFile(temporary, body, { mode: 0o600 });
      try { await fs.rename(temporary, database); }
      catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    });
    writeQueue = task;
    return task;
  }

  function startFollowing(cache) {
    const abort = new AbortController();
    cache.abort = abort;
    cache.error = undefined;
    cache.lastAttempt = Date.now();
    let resolveReady, rejectReady;
    let settled = false;
    cache.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // Avoid an unhandled rejection if a request disconnects while the shared subscription opens.
    cache.ready.catch(() => {});
    const timeout = setTimeout(() => { if (!settled) abort.abort(failure('follow-timeout', 'Session history did not open within 10 seconds.')); }, 10000);
    timeout.unref();
    cache.task = (async () => {
      try {
        const stream = await controller.follow({ address: { kind: 'session', sessionId: cache.id }, maxMessages: 50 }, abort.signal);
        for await (const frame of stream) {
          if (abort.signal.aborted || disposed) break;
          if (frame.type === 'snapshot') {
            if (frame.header?.id !== cache.id) throw failure('invalid-history', 'Session snapshot identity does not match.');
            resetProjection(cache);
            cache.header = frame.header;
            for (const record of frame.records ?? []) for (const event of expandRecord(record)) applyEvent(cache, event);
            if (typeof frame.projections?.values?.title === 'string') cache.title = frame.projections.values.title.slice(0, 200);
            cache.cursor = frame.cursor;
            cache.hasMore = Boolean(frame.hasMore);
            // A bounded history tail can start halfway through a long turn. Seed
            // liveness from the cold-safe official list before relying on events.
            if (typeof controller.list === 'function') {
              const baseline = await controller.list({}, abort.signal);
              const row = baseline.items?.find(item => item.sessionId === cache.id);
              if (row) { cache.running = Boolean(row.running); cache.runningKnown = true; }
            }
            if (!cache.runningKnown && cache.hasMore) {
              cache.running = true;
              cache.error = 'Running state is not yet confirmed; waiting for a live turn boundary.';
            }
            cache.loaded = true;
            settled = true;
            clearTimeout(timeout);
            resolveReady(cache);
          } else if (frame.type === 'event') applyEvent(cache, frame.event);
          const metadata = mains.get(cache.id);
          if (metadata && cache.title !== metadata.title) {
            metadata.title = cache.title;
            void persist().catch(error => { cache.error = `Could not save title: ${error.message}`; });
          }
        }
        if (!disposed && !abort.signal.aborted) throw failure('follow-ended', 'Session stream ended; reconnecting on the next refresh.');
        if (!settled) throw abort.signal.reason ?? failure('follow-ended', 'Session stream ended before its snapshot.');
      } catch (error) {
        if (!disposed) cache.error = error instanceof Error ? error.message : String(error);
        if (!settled) { settled = true; rejectReady(error); }
      } finally { clearTimeout(timeout); cache.active = false; }
    })();
    cache.active = true;
  }

  async function follow(sessionId, signal) {
    let cache = caches.get(sessionId);
    if (!cache) {
      cache = { id: sessionId, title: sides.get(sessionId)?.title ?? mains.get(sessionId)?.title ?? '主会话' };
      resetProjection(cache);
      caches.set(sessionId, cache);
      startFollowing(cache);
    } else if (!cache.active && Date.now() - cache.lastAttempt > 3000) startFollowing(cache);
    await withAbort(cache.ready, signal);
    return cache;
  }

  async function mainFor(rawId, signal) {
    const mainId = id(rawId, 'mainSessionId');
    if (sides.has(mainId)) throw failure('wrong-main', 'A sidechat cannot be used as a main-session owner.');
    const cache = await follow(mainId, signal);
    if (!mains.has(mainId)) { mains.set(mainId, { id: mainId, title: cache.title }); await persist(); }
    return cache;
  }
  function assertSide(mainId, sessionId, allowClosed = false) {
    const side = sides.get(id(sessionId, 'sessionId'));
    if (!side || side.mainSessionId !== mainId) throw failure('sidechat-not-found', 'This sidechat does not belong to the selected main session.');
    if (side.closedAt && !allowClosed) throw failure('sidechat-closed', '该侧聊已永久关闭，请新建对话。');
    return side;
  }
  async function recoverTitle(side, cache, signal) {
    if (!side.titleNeedsRecovery || side.closedAt) return;
    if (cache.titleRecovery) return cache.titleRecovery;
    if (cache.titleRecoveryAttempted) return;
    cache.titleRecoveryAttempted = true;
    cache.titleRecovery = (async () => {
      let title = cache.firstPromptTitle;
      let hasMore = cache.hasMore;
      let beforeSeq = cache.firstSeq;
      // Only a complete prefix proves which explicit human request came first.
      for (let page = 0; hasMore && page < 100; page++) {
        if (typeof controller.page !== 'function' || !Number.isSafeInteger(beforeSeq)) return;
        const older = await controller.page({ address: { kind: 'session', sessionId: side.id }, throughSeq: cache.cursor, beforeSeq, maxMessages: 50 }, signal ?? new AbortController().signal);
        const prefix = {}; resetProjection(prefix);
        for (const record of older.records ?? []) for (const event of expandRecord(record)) applyEvent(prefix, event);
        if (prefix.firstPromptTitle) title = prefix.firstPromptTitle;
        hasMore = Boolean(older.hasMore);
        if (hasMore && (!Number.isSafeInteger(prefix.firstSeq) || prefix.firstSeq >= beforeSeq)) return;
        beforeSeq = prefix.firstSeq;
      }
      if (hasMore || side.closedAt || side.titleFromText) return;
      side.title = title || NEW_SIDECHAT_TITLE;
      side.titleFromText = Boolean(title);
      if (title) side.firstPromptTitle = title;
      side.titleNeedsRecovery = false;
      await persist();
    })().catch(() => { /* Retain the honest untitled fallback if history cannot be read. */ });
    return cache.titleRecovery;
  }
  async function workspace(main) {
    // Header is authoritative. The configured cwd is only the official header-absent fallback.
    return fs.realpath(typeof main.header.cwd === 'string' && main.header.cwd ? main.header.cwd : defaultCwd);
  }
  const team = createTeamService({ dataDir, resolveWorkspace: async (mainId, signal) => {
    await init;
    const main = await mainFor(mainId, signal);
    if (main.header.origin === 'subagent') throw failure('wrong-main', '请从主会话分派协作任务。');
    return workspace(main);
  } });
  function serialSend(sessionId, fn) {
    const prior = sendLocks.get(sessionId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    sendLocks.set(sessionId, next);
    void next.finally(() => { if (sendLocks.get(sessionId) === next) sendLocks.delete(sessionId); }).catch(() => {});
    return next;
  }
  async function send(mainId, sessionId, payload, signal, side) {
    const text = string(payload.text ?? '', 'text', 100000, true);
    const packets = packetsOf(payload.packets);
    if (!text.trim() && !packets.length) throw failure('empty-message', 'Write a message or attach reference text.');
    return serialSend(sessionId, async () => {
      checkAbort(signal);
      if (side) {
        assertSide(mainId, sessionId);
        if (side.titleNeedsRecovery) await recoverTitle(side, await follow(sessionId, signal), signal);
      }
      const first = side && !side.initialized;
      const content = promptText(text, packets, first, first ? side.context : undefined);
      const requestId = randomUUID();
      const response = await controller.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: content }] }, signal ?? new AbortController().signal);
      if (response?.accepted !== true) throw failure('prompt-rejected', 'Session controller did not acknowledge the message.');
      const metadata = { requestId, sentAt: Date.now(), target: sessionId, packets: packets.map(({ text: ignored, ...packet }) => ({ ...packet, chars: ignored.length })) };
      if (side) {
        side.initialized = true;
        const title = promptTitle(text);
        if (!side.titleFromText && !side.titleNeedsRecovery && title) { side.title = title; side.firstPromptTitle = title; side.titleFromText = true; }
        side.references = [...(side.references ?? []), metadata].slice(-50);
        if (side.context) { side.context = { ...side.context, text: undefined }; }
      } else {
        const record = mains.get(mainId);
        record.references = [...(record.references ?? []), metadata].slice(-50);
      }
      await persist();
      return { accepted: true };
    });
  }

  return {
    team,
    async dispatch(endpoint, payload = {}, signal) {
      if (disposed) throw failure('disposed', 'Sidecar is closed.');
      await init;
      checkAbort(signal);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure('invalid-argument', 'Payload must be an object.');
      if (typeof endpoint === 'string' && endpoint.replace(/^\//, '').startsWith('team/')) return team.dispatch(endpoint, payload, signal);
      const known = new Set(['state', 'sidechat/create', 'sidechat/close', 'conversation/get', 'conversation/send', 'conversation/cancel', 'main/send', 'files/list', 'files/read', 'terminal/run', 'terminal/get', 'terminal/cancel']);
      if (!known.has(endpoint)) throw failure('unknown-endpoint', 'Unknown sidecar endpoint.');
      const main = await mainFor(payload.mainSessionId, signal);
      const mainId = main.id;
      switch (endpoint) {
        case 'state': {
          const children = [...sides.values()].filter(side => side.mainSessionId === mainId && !side.closedAt);
          const sidechats = await Promise.all(children.map(async side => {
            try { const cache = await follow(side.id, signal); await recoverTitle(side, cache, signal); return { id: side.id, title: side.title, running: cache.running, ...(cache.error ? { error: cache.error } : {}) }; }
            catch (error) { return { id: side.id, title: side.title, running: false, error: error.message }; }
          }));
          const closedSidechatIds = [...sides.values()].filter(side => side.mainSessionId === mainId && side.closedAt).map(side => side.id);
          return { workspace: await workspace(main), main: { id: mainId, title: main.title, running: main.running }, sidechats: sidechats.filter(side => !closedSidechatIds.includes(side.id)), closedSidechatIds, version: VERSION };
        }
        case 'sidechat/create': {
          if (payload.includeContext !== undefined && typeof payload.includeContext !== 'boolean') throw failure('invalid-argument', 'includeContext must be boolean.');
          const context = payload.includeContext ? { ...completedContext(main), source: mainId } : undefined;
          checkAbort(signal);
          const result = await controller.create({ cwd: await workspace(main) });
          const sessionId = id(result?.sessionId, 'created session ID');
          if (sessionId === mainId || sides.has(sessionId) || mains.has(sessionId)) throw failure('session-conflict', 'Controller returned an existing session identity.');
          const title = NEW_SIDECHAT_TITLE;
          sides.set(sessionId, { id: sessionId, mainSessionId: mainId, title, titleFromText: false, createdAt: Date.now(), initialized: false, ...(context ? { context: { ...context, sha256: hash(context.text) } } : {}) });
          await persist();
          return { id: sessionId, title };
        }
        case 'sidechat/close': {
          const side = assertSide(mainId, payload.sessionId, true);
          if (sendLocks.has(side.id)) throw failure('sidechat-running', '该侧聊正在发送或处理操作，请先停止后再关闭。');
          return serialSend(side.id, async () => {
            assertSide(mainId, side.id, true);
            if (side.closedAt) return { id: side.id, closed: true, archived: Boolean(side.archived), historyRetained: true };
            let cache;
            try { cache = await follow(side.id, signal); }
            catch { checkAbort(signal); throw failure('sidechat-state-unavailable', '暂时无法确认该侧聊是否运行，请稍后重试。'); }
            checkAbort(signal);
            let running;
            if (typeof controller.list === 'function') {
              let baseline;
              try { baseline = await controller.list({}, signal ?? new AbortController().signal); }
              catch { checkAbort(signal); throw failure('sidechat-state-unavailable', '暂时无法确认该侧聊是否运行，请稍后重试。'); }
              const row = baseline.items?.find(item => item.sessionId === side.id);
              if (typeof row?.running === 'boolean') running = row.running;
            } else if (cache.active && cache.runningKnown && !cache.error) running = cache.running;
            if (running === undefined) throw failure('sidechat-state-unavailable', '暂时无法确认该侧聊是否运行，请稍后重试。');
            if (running) throw failure('sidechat-running', '该侧聊正在运行，请先停止后再永久关闭。');
            checkAbort(signal);
            let archive;
            try { archive = typeof ctx.get === 'function' ? ctx.get('workspaceController') : undefined; } catch { /* optional native capability */ }
            if (!archive) { try { archive = ctx.workspaceController; } catch { /* older hosts retain local close */ } }
            let archived = false;
            if (typeof archive?.archiveSession === 'function') {
              let result;
              try { result = await archive.archiveSession({ sessionId: side.id }); }
              catch { throw failure('sidechat-archive-failed', 'DSH 未能归档该侧聊，请稍后重试。'); }
              if (!Array.isArray(result?.archivedSessionIds) || !result.archivedSessionIds.includes(side.id)) throw failure('sidechat-archive-failed', 'DSH 未确认该侧聊归档，请重试。');
              archived = true;
            }
            side.closedAt = Date.now(); side.archived = archived;
            try { await persist(); }
            catch (error) {
              delete side.closedAt; delete side.archived;
              await persist().catch(() => {});
              throw failure('state-unavailable', '无法保存永久关闭状态，请重试。');
            }
            cache.abort.abort(); caches.delete(side.id);
            return { id: side.id, closed: true, archived, historyRetained: true };
          });
        }
        case 'conversation/get': {
          const sessionId = id(payload.sessionId, 'sessionId');
          const side = sessionId === mainId ? undefined : assertSide(mainId, sessionId);
          const cache = sessionId === mainId ? main : await follow(sessionId, signal);
          if (side) { await recoverTitle(side, cache, signal); assertSide(mainId, sessionId); }
          return { id: sessionId, title: side ? side.title : cache.title, running: cache.running, messages: publicMessages(cache), hasMore: Boolean(cache.hasMore), ...(cache.error ? { error: cache.error } : {}) };
        }
        case 'conversation/send': {
          const side = assertSide(mainId, payload.sessionId);
          return send(mainId, side.id, payload, signal, side);
        }
        case 'conversation/cancel': {
          const side = assertSide(mainId, payload.sessionId);
          checkAbort(signal);
          return controller.cancel({ sessionId: side.id });
        }
        case 'main/send': {
          if (payload.sourceSessionId !== undefined) {
            const source = assertSide(mainId, payload.sourceSessionId);
            return serialSend(source.id, () => { assertSide(mainId, source.id); return send(mainId, mainId, payload, signal); });
          }
          return send(mainId, mainId, payload, signal);
        }
        case 'files/list': return listFiles(await workspace(main), payload.path ?? '.');
        case 'files/read': return readFile(await workspace(main), string(payload.path, 'path', 4096));
        case 'terminal/run': return terminal.run(mainId, await workspace(main), payload.command);
        case 'terminal/get': return terminal.get(mainId, id(payload.id, 'id'));
        case 'terminal/cancel': return terminal.cancel(mainId, id(payload.id, 'id'));
      }
    },
    async dispose() {
      disposed = true;
      for (const cache of caches.values()) cache.abort.abort();
      await terminal.dispose();
      await team.dispose();
      await writeQueue.catch(() => {});
    },
  };
}
