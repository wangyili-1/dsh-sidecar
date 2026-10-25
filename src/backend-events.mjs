// DSH 0.1.2-rc.1 wire projection. Deliberately excludes reasoning and request headers.
import { explicitPromptFromWire, promptTitle } from './sidechat-titles.mjs';
const MAX_MESSAGES = 200;
const MAX_TEXT = 256 * 1024;

export function visibleText(content) {
  if (!Array.isArray(content)) return '';
  return content.flatMap(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return [block.text];
    if (block?.type === 'tool-result') return [visibleText(block.content)];
    if (block?.type === 'image') return ['[image attachment]'];
    return [];
  }).join('\n').slice(0, MAX_TEXT);
}

export function expandRecord(record) {
  if (record?.type === 'event') return [record.event];
  if (record?.type !== 'chunks') throw new Error('Unsupported history record');
  const row = record.event;
  const types = { 'chunkrow/text-chunks': 'text-delta', 'chunkrow/reasoning-chunks': 'reasoning-delta', 'chunkrow/tool-call-chunks': 'tool-call-delta' };
  const type = types[row?.type];
  const data = row?.data;
  const fragments = type === 'tool-call-delta' ? data?.args : data?.texts;
  if (!type || !Array.isArray(fragments) || fragments.length < 1 || !fragments.every(x => typeof x === 'string')
    || !Array.isArray(data.dt) || data.dt.length !== fragments.length - 1 || !data.dt.every(Number.isSafeInteger)
    || !Number.isSafeInteger(row.seq) || !Number.isSafeInteger(row.time)) throw new Error('Malformed packed history record');
  let time = row.time;
  return fragments.map((fragment, index) => {
    if (index) time += data.dt[index - 1];
    if (!Number.isSafeInteger(time) || !Number.isSafeInteger(row.seq + index)) throw new Error('Malformed chunk coordinates');
    const chunk = type === 'tool-call-delta'
      ? { type, index: data.index, id: data.id, ...(data.name === undefined ? {} : { name: data.name }), argumentsDelta: fragment }
      : { type, index: data.index, text: fragment };
    return { type: 'assistant/chunk', seq: row.seq + index, time, data: { turn: data.turn, step: data.step, chunk } };
  });
}

export function resetProjection(cache) {
  cache.messages = [];
  cache.streams = new Map();
  cache.running = false;
  cache.runningKnown = false;
  cache.lastSeq = -1;
  cache.completedSeq = -1;
  cache.firstSeq = undefined;
  cache.firstPromptTitle = '';
}

function put(cache, message) {
  const old = cache.messages.findIndex(x => x.id === message.id);
  if (old < 0) cache.messages.push(message);
  else cache.messages[old] = message;
  if (cache.messages.length > MAX_MESSAGES) cache.messages.splice(0, cache.messages.length - MAX_MESSAGES);
}

export function applyEvent(cache, event) {
  if (!event || !Number.isSafeInteger(event.seq) || typeof event.type !== 'string') throw new Error('Malformed session event');
  if (event.seq <= cache.lastSeq) return;
  cache.firstSeq ??= event.seq;
  cache.lastSeq = event.seq;
  const data = event.data ?? {};
  const time = Number.isFinite(event.time) ? event.time : 0;
  const base = { time, _seq: event.seq };
  if (event.type === 'turn/start') { cache.running = true; cache.runningKnown = true; }
  if (event.type === 'turn/end') { cache.running = false; cache.runningKnown = true; cache.completedSeq = event.seq; }
  if (event.type === 'session/title' && typeof data.title === 'string') cache.title = data.title.slice(0, 200);
  if (event.type === 'user/message') {
    // Synthetic context injections remain distinguishable from human turns.
    const role = data.source?.kind === 'user' ? 'user' : 'system';
    const text = visibleText(data.content);
    if (role === 'user' && !cache.firstPromptTitle) cache.firstPromptTitle = promptTitle(explicitPromptFromWire(text));
    if (text) put(cache, { ...base, id: `user:${data.id ?? event.seq}`, role, text });
  }
  const streamKey = `${data.turn}:${data.step}`;
  if (event.type === 'assistant/chunk') {
    const chunk = data.chunk;
    if (!chunk || (chunk.type !== 'text-delta' && !(chunk.type === 'block-end' && chunk.block?.type === 'text'))) return;
    let stream = cache.streams.get(streamKey);
    if (!stream) {
      stream = { blocks: new Map(), time, seq: event.seq };
      cache.streams.set(streamKey, stream);
    }
    const previous = stream.blocks.get(chunk.index) ?? '';
    stream.blocks.set(chunk.index, (chunk.type === 'text-delta' ? previous + chunk.text : chunk.block.text).slice(0, MAX_TEXT));
    const text = [...stream.blocks.entries()].sort((a, b) => a[0] - b[0]).map(x => x[1]).join('\n').slice(0, MAX_TEXT);
    put(cache, { id: `assistant:${streamKey}`, role: 'assistant', text, time: stream.time, _seq: event.seq, _streaming: true });
  }
  if (event.type === 'assistant/message') {
    const text = visibleText(data.message?.content);
    const id = `assistant:${streamKey}`;
    cache.messages = cache.messages.filter(x => x.id !== id);
    if (text) put(cache, { ...base, id, role: 'assistant', text });
    cache.streams.delete(streamKey);
  }
  if (event.type === 'tool/call') {
    put(cache, { ...base, id: `tool-call:${data.callId ?? event.seq}`, role: 'tool', text: `${data.name ?? 'Tool'}\n${typeof data.arguments === 'string' ? data.arguments : ''}`.slice(0, MAX_TEXT) });
  }
  if (event.type === 'tool/result') {
    const text = visibleText(data.message?.content);
    put(cache, { ...base, id: `tool-result:${data.message?.id ?? event.seq}`, role: 'tool', text: text || '[Tool completed with no text output]' });
  }
}

export function publicMessages(cache) {
  return cache.messages.map(({ id, role, text, time }) => ({ id, role, text, time }));
}

export function completedContext(cache) {
  const messages = cache.messages.filter(x => x._seq <= cache.completedSeq && !x._streaming && (x.role === 'user' || x.role === 'assistant')).slice(-24);
  // A deterministic excerpt, explicitly described as quoted context, never replayed executable messages.
  const text = messages.map(x => `${x.role.toUpperCase()}: ${x.text}`).join('\n\n').slice(-24000);
  return { text, throughSeq: cache.completedSeq, messageCount: messages.length, capturedAt: Date.now() };
}
