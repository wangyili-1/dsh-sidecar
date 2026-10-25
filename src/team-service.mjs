import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgentProviderStore } from './agent-providers.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const validId = value => typeof value === 'string' && /^[\w.:-]{1,160}$/.test(value);
const fail = (code, message) => Object.assign(new Error(message), { code });
const errorMessages = {
  'missing-api-key': '尚未配置此执行者的密钥。',
  'agent-disabled': '此执行者已停用。',
  'agent-not-found': '此执行者已不存在。',
  'provider-auth': '鉴权失败，请检查密钥、接口地址、地区与账户权限。',
  'provider-rate-limit': '供应商返回限流或额度错误，没有自动重试。',
  'provider-redirect': '接口返回重定向，已停止发送凭据。请填写最终 API 地址。',
  'provider-http': '供应商拒绝请求，请检查模型名称、参数和账户权限。',
  'provider-incomplete': '供应商没有返回完整结果，可能达到输出上限或要求未支持的工具调用。',
  'provider-error': '供应商报告生成失败，没有自动重试。',
  'timeout': '请求超时，已停止本机等待；供应商可能仍在处理，请核实后再重试。',
  'network-error': '连接供应商失败，请检查网络和接口地址。',
  'invalid-response': '供应商返回的结果格式不受支持。',
  'response-too-large': '供应商返回的结果超过大小限制。',
  'unsupported-image': '接口须返回 base64 PNG、JPEG 或 WebP 图像。',
  'artifact-path-escape': '产物目录超出当前工作区，请检查输出目录的链接。',
};
const clone = value => structuredClone(value);
const contained = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

/** Durable task ownership; API workers return proposals/artifacts, never execute local code. */
export function createTeamService({ dataDir, resolveWorkspace, providers, concurrency = 3, maxPending = 30 } = {}) {
  if (!dataDir || typeof resolveWorkspace !== 'function') throw new Error('Team storage and workspace resolver are required.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Invalid worker concurrency.');
  const store = providers ?? createAgentProviderStore({ dataDir: path.join(dataDir, 'agents') });
  const stateFile = path.join(dataDir, 'team-tasks.json');
  const tasks = new Map(), active = new Map(), listeners = new Set(), pendingAdmissions = new Set();
  let closed = false, pumping = false, writeQueue = Promise.resolve(), submitQueue = Promise.resolve();
  function changed() { for (const wake of [...listeners]) wake(); }
  function persist() {
    const body = JSON.stringify({ schema: 1, tasks: [...tasks.values()] }, null, 2);
    const next = writeQueue.catch(() => {}).then(async () => {
      const tmp = `${stateFile}.${randomUUID()}.tmp`;
      try { await fs.writeFile(tmp, body, { mode: 0o600 }); await fs.rename(tmp, stateFile); }
      finally { await fs.unlink(tmp).catch(() => {}); }
    });
    writeQueue = next;
    return next;
  }
  function serializeMutation(work) {
    const next = submitQueue.catch(() => {}).then(work);
    submitQueue = next;
    return next;
  }
  const ready = (async () => {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    let state;
    try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw fail('team-state-unavailable', '无法读取协作任务记录。'); }
    if (state.schema !== 1 || !Array.isArray(state.tasks) || state.tasks.length > 1000) throw fail('team-state-unavailable', '协作任务记录格式不正确。');
    for (const row of state.tasks) {
      if (!validId(row.id) || !validId(row.mainSessionId) || !validId(row.agentId) || tasks.has(row.id) || !['queued', 'running', ...terminal].includes(row.status)) throw fail('team-state-unavailable', '协作任务记录不完整。');
      if (!terminal.has(row.status)) {
        row.status = 'interrupted'; row.finishedAt = Date.now();
        row.error = { code: 'service-restarted', message: '服务已重启，任务没有自动重新提交。请检查供应商端状态后决定是否重试。' };
      }
      tasks.set(row.id, row);
    }
    await persist();
  })();
  ready.catch(() => {});
  async function owner(mainSessionId, signal) {
    await ready;
    if (closed) throw fail('team-closed', '协作服务已停止。');
    if (!validId(mainSessionId)) throw fail('invalid-main-session', '请选择有效的主会话。');
    signal?.throwIfAborted();
    const workspace = await resolveWorkspace(mainSessionId, signal);
    signal?.throwIfAborted();
    return fs.realpath(workspace);
  }
  function owned(mainSessionId, taskId) {
    const row = tasks.get(taskId);
    if (!validId(taskId) || !row || row.mainSessionId !== mainSessionId) throw fail('team-task-not-found', '任务不属于当前主会话。');
    return row;
  }
  function publicTask(row, summary = false) {
    const { workspace: ignored, ...value } = row;
    const result = clone(value);
    const limit = summary ? 1200 : 24000;
    if (result.result?.text?.length > limit) result.result.text = result.result.text.slice(0, limit) + '\n\n[结果较长，完整内容保存在 result.md 产物中。]';
    return result;
  }
  async function artifactDirectory(row) {
    const root = await fs.realpath(row.workspace);
    let current = root;
    for (const segment of ['outputs', 'sidecar-agents', row.id]) {
      current = path.join(current, segment);
      try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const actual = await fs.realpath(current);
      if (!contained(root, actual)) throw fail('artifact-path-escape', '产物目录超出主会话工作区。');
      current = actual;
    }
    return current;
  }
  async function saveResult(row, output, signal) {
    signal.throwIfAborted();
    if (!output || typeof output.text !== 'string' || output.text.length > 2000000 || !Array.isArray(output.images) || output.images.length > 4) throw fail('invalid-response', '供应商返回的结果格式不正确。');
    const folder = await artifactDirectory(row);
    const artifacts = [];
    async function write(name, mimeType, bytes) {
      signal.throwIfAborted();
      const file = path.join(folder, name);
      await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      artifacts.push({ id: `${row.id}-${artifacts.length + 1}`, name, mimeType, path: file });
    }
    if (output.text) await write('result.md', 'text/markdown', output.text);
    let index = 0;
    for (const image of output.images) {
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[image.mimeType];
      if (!ext || typeof image.dataBase64 !== 'string' || image.dataBase64.length > 28000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataBase64)) throw fail('invalid-response', '图像结果格式不正确。');
      const bytes = Buffer.from(image.dataBase64, 'base64');
      const validImage = ext === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : ext === 'jpg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!validImage) throw fail('invalid-response', '供应商没有返回有效的图像文件。');
      await write(`image-${++index}.${ext}`, image.mimeType, bytes);
    }
    const usage = Object.fromEntries(Object.entries(output.usage ?? {}).filter(([key, value]) => /^[\w-]{1,60}$/.test(key) && Number.isFinite(value) && value >= 0));
    signal.throwIfAborted();
    return { text: output.text, artifacts, ...(Object.keys(usage).length ? { usage } : {}) };
  }
  function safeFailure(error) {
    const code = Object.hasOwn(errorMessages, error?.code ?? '') ? error.code : 'worker-failed';
    return { code, message: errorMessages[code] ?? '任务未完成，请检查配置与本地输出目录；没有自动重试。', ...(Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? { status: error.status } : {}) };
  }
  async function run(row, control) {
    try {
      row.status = 'running'; row.startedAt = Date.now();
      await persist(); changed();
      control.signal.throwIfAborted();
      const result = await store.execute({ agentId: row.agentId, prompt: row.prompt, signal: control.signal });
      if (control.signal.aborted || closed) return;
      row.result = await saveResult(row, result, control.signal);
      if (control.signal.aborted || closed) { delete row.result; return; }
      row.status = 'completed'; row.finishedAt = Date.now();
    } catch (error) {
      if (!control.signal.aborted && !closed) { row.status = 'failed'; row.finishedAt = Date.now(); row.error = safeFailure(error); }
    } finally {
      active.delete(row.id);
      await persist().catch(() => { row.status = 'failed'; row.error = { code: 'team-state-unavailable', message: '任务状态无法保存，请检查磁盘。' }; });
      changed(); if (!closed) void pump();
    }
  }
  async function pump() {
    if (pumping || closed) return;
    pumping = true;
    try {
      await ready;
      for (const row of tasks.values()) {
        if (closed || active.size >= concurrency) break;
        if (row.status !== 'queued' || active.has(row.id) || pendingAdmissions.has(row.id)) continue;
        const control = new AbortController();
        const entry = { control, promise: null };
        active.set(row.id, entry);
        entry.promise = run(row, control);
      }
    } finally { pumping = false; }
  }
  function waitForChange(signal, ms) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = error => { clearTimeout(timer); listeners.delete(wake); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const wake = () => finish();
      const abort = () => finish(signal.reason ?? fail('cancelled', '等待已取消。'));
      if (signal?.aborted) { abort(); return; }
      listeners.add(wake); signal?.addEventListener('abort', abort, { once: true }); timer = setTimeout(wake, ms);
    });
  }
  const team = {
    async listAgents() { await ready; return (await store.list()).filter(item => item.enabled && item.hasKey); },
    async submit({ mainSessionId, agentId, prompt, title, signal }) {
      const workspace = await owner(mainSessionId, signal);
      if (!validId(agentId) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000 || (title !== undefined && (typeof title !== 'string' || title.length > 100))) throw fail('invalid-task', '请提供有效的执行者和任务描述。');
      const operation = serializeMutation(async () => {
        signal?.throwIfAborted();
        if (closed) throw fail('team-closed', '协作服务已停止。');
        const agent = (await store.list()).find(item => item.id === agentId);
        signal?.throwIfAborted();
        if (closed) throw fail('team-closed', '协作服务已停止。');
        if (!agent?.enabled || !agent.hasKey) throw fail('not-configured', '请先配置并启用该执行者。');
        if ([...tasks.values()].filter(item => !terminal.has(item.status)).length >= maxPending || tasks.size >= 1000) throw fail('team-queue-full', '协作队列已满，请等待已有任务完成。');
        const row = { id: `task-${randomUUID()}`, mainSessionId, agentId, agentName: agent.name, title: title?.trim() || Array.from(prompt.trim()).slice(0, 48).join(''), prompt, workspace, status: 'queued', createdAt: Date.now() };
        pendingAdmissions.add(row.id); tasks.set(row.id, row);
        try { await persist(); } catch (error) { pendingAdmissions.delete(row.id); tasks.delete(row.id); throw fail('team-state-unavailable', '任务未能保存，没有提交到供应商。'); }
        if (signal?.aborted || closed) {
          row.status = closed ? 'interrupted' : 'cancelled'; row.finishedAt = Date.now();
          await persist(); pendingAdmissions.delete(row.id); changed();
          signal?.throwIfAborted();
          throw fail('team-closed', '协作服务已停止。');
        }
        pendingAdmissions.delete(row.id);
        const result = publicTask(row);
        changed(); void pump();
        return result;
      });
      return operation;
    },
    async listTasks(mainSessionId, signal) { await owner(mainSessionId, signal); return [...tasks.values()].filter(row => row.mainSessionId === mainSessionId).slice(-100).reverse().map(row => publicTask(row, true)); },
    async getTask(mainSessionId, taskId, signal) { await owner(mainSessionId, signal); return publicTask(owned(mainSessionId, taskId)); },
    async cancelTask(mainSessionId, taskId) {
      await owner(mainSessionId);
      const row = owned(mainSessionId, taskId);
      if (terminal.has(row.status)) return publicTask(row);
      row.status = 'cancelled'; row.finishedAt = Date.now();
      active.get(row.id)?.control.abort(fail('cancelled', '任务已取消。'));
      await persist(); changed();
      return publicTask(row);
    },
    async waitTasks(mainSessionId, taskIds, signal) {
      await owner(mainSessionId, signal);
      if (!Array.isArray(taskIds) || !taskIds.length || taskIds.length > 30) throw fail('invalid-task', '请选择要等待的任务。');
      const rows = taskIds.map(taskId => owned(mainSessionId, taskId));
      const deadline = Date.now() + 25000;
      while (!rows.every(row => terminal.has(row.status)) && Date.now() < deadline && !closed) await waitForChange(signal, Math.min(1000, deadline - Date.now()));
      signal?.throwIfAborted();
      return rows.map(row => publicTask(row));
    },
    async dispatch(endpoint, payload, signal) {
      const workspace = await owner(payload.mainSessionId, signal);
      switch (endpoint.replace(/^\//, '')) {
        case 'team/agents/list': return { agents: await store.list() };
        case 'team/agents/save': {
          return serializeMutation(async () => {
            if (closed) throw fail('team-closed', '协作服务已停止。');
            if ([...tasks.values()].some(row => row.agentId === payload.profile?.id && !terminal.has(row.status))) throw fail('agent-busy', '请等该执行者的任务结束后修改配置。');
            return store.save(payload.profile);
          });
        }
        case 'team/agents/remove': {
          return serializeMutation(async () => {
            if (closed) throw fail('team-closed', '协作服务已停止。');
            if ([...tasks.values()].some(row => row.agentId === payload.agentId && !terminal.has(row.status))) throw fail('agent-busy', '请等该执行者的任务结束后移除配置。');
            return store.remove(payload.agentId);
          });
        }
        case 'team/tasks/list': return { tasks: await team.listTasks(payload.mainSessionId, signal) };
        case 'team/tasks/submit': return team.submit({ ...payload, signal });
        case 'team/tasks/cancel': return team.cancelTask(payload.mainSessionId, payload.taskId);
        case 'team/tasks/result': {
          const row = owned(payload.mainSessionId, payload.taskId);
          const result = clone(row.result ?? { text: '', artifacts: [] });
          for (const artifact of result.artifacts) {
            if (!artifact.mimeType.startsWith('image/')) continue;
            const actual = await fs.realpath(artifact.path);
            const expected = path.join(workspace, 'outputs', 'sidecar-agents', row.id);
            if (!contained(expected, actual)) throw fail('artifact-path-escape', '图像产物路径不可用。');
            const stat = await fs.stat(actual);
            if (!stat.isFile() || stat.size > 21000000) throw fail('artifact-unavailable', '图像产物不可用或过大。');
            artifact.dataUrl = `data:${artifact.mimeType};base64,${(await fs.readFile(actual)).toString('base64')}`;
          }
          return result;
        }
        default: throw fail('unknown-endpoint', '未知的协作操作。');
      }
    },
    async dispose() {
      closed = true;
      try { await ready; } catch { return; }
      await submitQueue.catch(() => {});
      for (const row of tasks.values()) if (!terminal.has(row.status)) {
        row.status = 'interrupted'; row.finishedAt = Date.now(); row.error = { code: 'service-stopped', message: '服务已停止，任务没有自动重试。' };
        active.get(row.id)?.control.abort(fail('service-stopped', '服务已停止。'));
      }
      changed();
      await Promise.allSettled([...active.values()].map(entry => entry.promise));
      await persist();
    },
  };
  return team;
}
