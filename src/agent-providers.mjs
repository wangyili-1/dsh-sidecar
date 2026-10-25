import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAgentReady, isLoopbackAgentUrl, isManualWebUrl } from './agent-resources.mjs';

// Protocol references checked 2026-10-26:
// https://docs.bigmodel.cn/api-reference/模型-api/对话补全
// https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions
// https://developers.openai.com/api/docs/guides/text
// https://developers.openai.com/api/reference/resources/images/methods/generate
// https://platform.claude.com/docs/en/api/messages/create
const runFile = promisify(execFile);
const queues = new Map();
const MIB = 1024 * 1024;
const MAX_PROFILES = 32;
const fields = ['id', 'name', 'role', 'protocol', 'authMode', 'baseUrl', 'model', 'apiKeyEnv', 'apiVersion', 'enabled', 'timeoutMs', 'maxOutputTokens'];
const acceptedFields = new Set([...fields, 'hasKey', 'ready', 'executionMode', 'apiKey']);
const messages = {
  'invalid-profile': 'Agent configuration contains invalid or unsupported fields.',
  'invalid-endpoint': 'Use an HTTPS base URL without credentials, query, or fragment; HTTP is allowed only for an explicit loopback address.',
  'invalid-prompt': 'Provide a non-empty prompt within the supported size limit.',
  'invalid-signal': 'The cancellation signal is invalid.',
  'agent-not-found': 'The selected agent no longer exists.',
  'agent-disabled': 'Enable the selected agent before running it.',
  'manual-web-only': 'This is a manual website resource. Open it yourself and paste the result back; no API request was made.',
  'invalid-auth-mode': 'No-key API access is restricted to explicit loopback Chat Completions or Responses endpoints.',
  'missing-api-key': 'Configure an API key or its environment variable for this agent.',
  'invalid-api-key': 'The configured API key has an invalid format.',
  'store-unavailable': 'The local agent configuration could not be read or saved.',
  'store-invalid': 'The local agent configuration is invalid; it was not overwritten.',
  'store-protection': 'The local agent directory could not be restricted to the current user.',
  'too-many-agents': 'At most 32 agent profiles may be configured.',
  'aborted': 'Agent request cancelled.',
  'timeout': 'The agent request exceeded its time limit.',
  'network-error': 'The provider connection failed. Check the endpoint and network.',
  'provider-auth': 'The provider rejected authentication. Check the key, endpoint, and account access.',
  'provider-rate-limit': 'The provider rate limit or quota was reached.',
  'provider-redirect': 'Provider redirects are not allowed.',
  'provider-http': 'The provider rejected the request.',
  'provider-error': 'The provider reported a generation error.',
  'provider-incomplete': 'The provider did not return a completed answer.',
  'invalid-response': 'The provider returned an unsupported response.',
  'response-too-large': 'The provider response exceeded the size limit.',
  'unsupported-image': 'The provider must return base64 PNG, JPEG, or WebP images; image URLs are not fetched.',
};

class ProviderError extends Error {
  constructor(code, status) {
    super(messages[code]);
    this.name = 'AgentProviderError';
    this.code = code;
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
  }
}
const failure = (code, status) => new ProviderError(code, status);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);

function text(value, limit, empty = false) {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw failure('invalid-profile');
  const cleaned = value.trim();
  if (!empty && !cleaned) throw failure('invalid-profile');
  return cleaned;
}
function agentId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw failure('invalid-profile');
  return value;
}
function endpoint(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\?#]/u.test(value)) throw failure('invalid-endpoint');
  let url;
  try { url = new URL(value); } catch { throw failure('invalid-endpoint'); }
  const authority = value.match(/^https?:\/\/([^/]+)/i)?.[1];
  const explicitLoopback = /^http:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(value);
  if (!authority || authority.includes('@') || url.username || url.password || url.search || url.hash || !url.hostname ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && explicitLoopback))) throw failure('invalid-endpoint');
  return url.href.replace(/\/+$/, '');
}
function keyText(value) {
  if (typeof value !== 'string' || value.length > 4096) throw failure('invalid-api-key');
  const key = value.trim();
  if (key && !/^[\x21-\x7e]+$/.test(key)) throw failure('invalid-api-key');
  return key;
}
function profileOf(input, previous = {}) {
  if (!record(input) || Object.keys(input).some(key => !acceptedFields.has(key))) throw failure('invalid-profile');
  const value = { role: '', model: '', authMode: 'api-key', apiKeyEnv: '', apiVersion: '2023-06-01', enabled: false, timeoutMs: 120000, maxOutputTokens: 4096, ...previous, ...input };
  const manual = value.protocol === 'manual-web';
  const profile = {
    id: agentId(value.id), name: text(value.name, 80), role: text(value.role, 8000, true),
    protocol: value.protocol, authMode: manual ? 'none' : value.authMode, baseUrl: endpoint(value.baseUrl), model: text(value.model, 160, true),
    apiKeyEnv: manual || value.authMode === 'none' ? '' : text(value.apiKeyEnv, 128, true), apiVersion: text(value.apiVersion, 20), enabled: value.enabled,
    timeoutMs: value.timeoutMs, maxOutputTokens: value.maxOutputTokens,
  };
  if (!['chat-completions', 'responses', 'images', 'anthropic-messages', 'manual-web'].includes(profile.protocol) || typeof profile.enabled !== 'boolean' ||
      (profile.enabled && !manual && !profile.model) || (profile.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv)) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(profile.apiVersion) ||
      !Number.isInteger(profile.timeoutMs) || profile.timeoutMs < 1000 || profile.timeoutMs > 600000 ||
      !Number.isInteger(profile.maxOutputTokens) || profile.maxOutputTokens < 1 || profile.maxOutputTokens > 65536) throw failure('invalid-profile');
  if (manual && !isManualWebUrl(profile.baseUrl)) throw failure('invalid-endpoint');
  if (!['api-key', 'none'].includes(profile.authMode) || (profile.authMode === 'none' && !manual &&
      (!['chat-completions', 'responses'].includes(profile.protocol) || !isLoopbackAgentUrl(value.baseUrl)))) throw failure('invalid-auth-mode');
  if (profile.authMode === 'none') {
    // Manual resources and explicitly local no-auth profiles never retain a
    // dormant credential that could later follow a profile to a remote server.
    profile.apiKey = '';
    profile.apiKeyEnv = '';
    return profile;
  }
  // A blank password field preserves a saved key only while its destination and
  // authentication mode remain compatible with the saved credential.
  const changedEndpoint = previous.baseUrl && previous.baseUrl !== profile.baseUrl;
  profile.apiKey = (own(input, 'apiKey') ? keyText(input.apiKey) : '') || (!changedEndpoint ? previous.apiKey : '') || '';
  // An unchanged environment field copied by the settings form is not renewed
  // consent to send the same credential to another endpoint or tenant path.
  if (changedEndpoint && profile.apiKeyEnv === previous.apiKeyEnv) profile.apiKeyEnv = '';
  return profile;
}

function presets() {
  return [
    { id: 'glm', name: 'GLM', role: '', protocol: 'chat-completions', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7', apiKeyEnv: 'ZHIPU_API_KEY' },
    { id: 'qwen', name: 'Qwen', role: '', protocol: 'chat-completions', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', apiKeyEnv: 'DASHSCOPE_API_KEY' },
    { id: 'openai-image', name: 'OpenAI Image', role: '', protocol: 'images', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2.5-flare', apiKeyEnv: 'OPENAI_API_KEY', timeoutMs: 180000 },
    { id: 'claude', name: 'Claude', role: '', protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', model: '', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  ].map(profile => profileOf(profile));
}

async function serialize(location, work) {
  const pending = (queues.get(location) ?? Promise.resolve()).catch(() => {}).then(work);
  queues.set(location, pending);
  try { return await pending; }
  finally { if (queues.get(location) === pending) queues.delete(location); }
}

async function protectDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('store-protection');
  try {
    if (process.platform === 'win32') {
      // chmod does not restrict Windows ACLs. This script creates a protected DACL
      // containing only the current identity; paths are data, never interpolated code.
      // Framework ACL APIs avoid Set-Acl module discovery, which can fail when a
      // PowerShell 7 parent passes its PSModulePath to Windows PowerShell 5.1.
      const script = "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($env:DSH_AGENT_PROTECTED_PATH,$acl)";
      await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, timeout: 10000, maxBuffer: 16384,
        env: { ...process.env, DSH_AGENT_PROTECTED_PATH: directory },
      });
    } else await fs.chmod(directory, 0o700);
  } catch { throw failure('store-protection'); }
}

async function readProfiles(directory, filename) {
  try {
    const folder = await fs.lstat(directory);
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw failure('store-invalid');
    const info = await fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MIB) throw failure('store-invalid');
    const source = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (!record(source) || source.version !== 1 || !Array.isArray(source.profiles) || source.profiles.length > MAX_PROFILES) throw failure('store-invalid');
    const profiles = source.profiles.map(value => profileOf(value));
    if (new Set(profiles.map(value => value.id)).size !== profiles.length) throw failure('store-invalid');
    return profiles;
  } catch (error) {
    if (error?.code === 'ENOENT') return presets();
    if (error instanceof ProviderError && error.code === 'store-invalid') throw error;
    if (error instanceof SyntaxError || error instanceof ProviderError) throw failure('store-invalid');
    throw failure('store-unavailable');
  }
}

async function writeProfiles(directory, filename, profiles) {
  const temporary = path.join(directory, `.profiles-${randomUUID()}.tmp`);
  let handle;
  try {
    await protectDirectory(directory);
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ version: 1, profiles }, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filename);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw failure('store-unavailable');
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

function usageOf(raw) {
  if (!record(raw)) return undefined;
  const usage = {};
  for (const [key, candidates] of Object.entries({ inputTokens: ['input_tokens', 'prompt_tokens'], outputTokens: ['output_tokens', 'completion_tokens'], totalTokens: ['total_tokens'] })) {
    const value = candidates.map(name => raw[name]).find(value => Number.isSafeInteger(value) && value >= 0);
    if (value !== undefined) usage[key] = value;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function imageOf(value) {
  if (typeof value !== 'string' || !value || value.length > 16 * MIB || value.length % 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw failure('unsupported-image');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > 12 * MIB) throw failure('response-too-large');
  if (bytes.toString('base64') !== value) throw failure('unsupported-image');
  let mimeType;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') mimeType = 'image/png';
  else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mimeType = 'image/jpeg';
  else if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mimeType = 'image/webp';
  if (!mimeType) throw failure('unsupported-image');
  return { mimeType, dataBase64: value };
}

function resultOf(protocol, raw) {
  if (!record(raw)) throw failure('invalid-response');
  if (raw.error) throw failure('provider-error');
  let text = '';
  let images = [];
  if (protocol === 'chat-completions') {
    const choice = Array.isArray(raw.choices) ? raw.choices.find(value => value?.index === 0) ?? raw.choices[0] : null;
    if (choice?.finish_reason === 'length' || choice?.finish_reason === 'tool_calls') throw failure('provider-incomplete');
    const message = choice?.message;
    if (!record(message) || message.role !== 'assistant') throw failure('invalid-response');
    if (typeof message.content === 'string') text = message.content;
    else if (Array.isArray(message.content)) text = message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
    if (!text && typeof message.refusal === 'string') text = message.refusal;
  } else if (protocol === 'responses') {
    if (raw.status !== 'completed') throw failure('provider-incomplete');
    if (!Array.isArray(raw.output)) throw failure('invalid-response');
    text = raw.output.filter(item => item?.type === 'message' && item.role === 'assistant' &&
      (!item.phase || item.phase === 'final_answer') && (!item.status || item.status === 'completed'))
      .flatMap(item => Array.isArray(item.content) ? item.content : [])
      .flatMap(part => part?.type === 'output_text' && typeof part.text === 'string' ? [part.text] :
        part?.type === 'refusal' && typeof part.refusal === 'string' ? [part.refusal] : []).join('\n');
  } else if (protocol === 'anthropic-messages') {
    if (raw.type !== 'message' || raw.role !== 'assistant' || !Array.isArray(raw.content)) throw failure('invalid-response');
    if (!['end_turn', 'stop_sequence'].includes(raw.stop_reason)) throw failure('provider-incomplete');
    text = raw.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
  } else {
    if (!Array.isArray(raw.data) || raw.data.length !== 1) throw failure('unsupported-image');
    images = raw.data.map(item => imageOf(item?.b64_json));
  }
  if (Buffer.byteLength(text, 'utf8') > MIB) throw failure('response-too-large');
  if (!text.trim() && !images.length) throw failure('invalid-response');
  const result = { text, images };
  const usage = usageOf(raw.usage);
  if (usage) result.usage = usage;
  return result;
}

function requestOf(profile, prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt, 'utf8') > 256 * 1024) throw failure('invalid-prompt');
  if (profile.protocol === 'images') {
    const imagePrompt = profile.role ? `${profile.role}\n\n${prompt}` : prompt;
    if (imagePrompt.length > 32000) throw failure('invalid-prompt');
    // GPT Image always returns base64. response_format is unsupported for it.
    return { suffix: '/images/generations', body: { model: profile.model, prompt: imagePrompt, n: 1, output_format: 'png' } };
  }
  if (profile.protocol === 'responses') return {
    suffix: '/responses',
    body: { model: profile.model, input: prompt, ...(profile.role ? { instructions: profile.role } : {}), max_output_tokens: profile.maxOutputTokens, store: false, stream: false },
  };
  if (profile.protocol === 'anthropic-messages') return {
    suffix: '/messages',
    body: { model: profile.model, messages: [{ role: 'user', content: prompt }], ...(profile.role ? { system: profile.role } : {}), max_tokens: profile.maxOutputTokens, stream: false },
  };
  return { suffix: '/chat/completions', body: {
    model: profile.model, messages: [...(profile.role ? [{ role: 'system', content: profile.role }] : []), { role: 'user', content: prompt }],
    max_tokens: profile.maxOutputTokens, stream: false,
  } };
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

async function responseJson(response, limit, signal) {
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    void response.body?.cancel().catch(() => {});
    throw failure('provider-redirect');
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    const code = [401, 403].includes(response.status) ? 'provider-auth' : response.status === 429 ? 'provider-rate-limit' : 'provider-http';
    throw failure(code, response.status);
  }
  const length = Number(response.headers?.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    void response.body?.cancel().catch(() => {});
    throw failure('response-too-large');
  }
  if (!response.body?.getReader) throw failure('invalid-response');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const part = await withAbort(reader.read(), signal);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) throw failure('response-too-large');
      chunks.push(Buffer.from(part.value));
    }
    try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
    catch { throw failure('invalid-response'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => {});
  }
}

/** Host-only adapter: no native DSH credentials, model tools, retries, or URL image downloads. */
export function createAgentProviderStore({ dataDir, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (typeof dataDir !== 'string' || !dataDir || !record(env) || typeof fetchImpl !== 'function') throw failure('invalid-profile');
  const directory = path.join(path.resolve(dataDir), 'agent-providers');
  const filename = path.join(directory, 'profiles.json');
  const read = () => readProfiles(directory, filename);
  const keyFor = profile => profile.authMode === 'none' ? '' : profile.apiKey || (profile.apiKeyEnv && own(env, profile.apiKeyEnv) ? env[profile.apiKeyEnv] : '') || '';
  const publicProfile = profile => {
    const key = keyFor(profile);
    const result = { ...Object.fromEntries(fields.map(field => [field, profile[field]])), hasKey: typeof key === 'string' && !!key.trim(),
      executionMode: profile.protocol === 'manual-web' ? 'web-manual' : profile.authMode === 'none' ? 'local-api' : 'api' };
    let validKey = profile.authMode === 'none';
    if (!validKey) try { validKey = Boolean(keyText(key)); } catch { /* Invalid environment values are not usable credentials. */ }
    result.ready = validKey && isAgentReady({ ...result, enabled: true });
    return result;
  };
  return {
    async list() { return serialize(filename, async () => (await read()).map(publicProfile)); },
    async save(input) {
      return serialize(filename, async () => {
        if (!record(input)) throw failure('invalid-profile');
        const profiles = await read();
        const previous = profiles.find(value => value.id === input?.id);
        const profile = profileOf({ ...input, id: input.id ?? `agent-${randomUUID()}` }, previous);
        if (profile.enabled && profile.authMode === 'api-key' && !keyText(keyFor(profile))) throw failure('missing-api-key');
        if (!previous && profiles.length >= MAX_PROFILES) throw failure('too-many-agents');
        const next = previous ? profiles.map(value => value.id === profile.id ? profile : value) : [...profiles, profile];
        await writeProfiles(directory, filename, next);
        return publicProfile(profile);
      });
    },
    async remove(id) {
      agentId(id);
      return serialize(filename, async () => {
        const profiles = await read();
        const next = profiles.filter(value => value.id !== id);
        if (next.length === profiles.length) return { removed: false };
        await writeProfiles(directory, filename, next);
        return { removed: true };
      });
    },
    async execute({ agentId: id, prompt, signal } = {}) {
      agentId(id);
      if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw failure('invalid-signal');
      if (signal?.aborted) throw failure('aborted');
      const profile = await serialize(filename, async () => (await read()).find(value => value.id === id));
      if (!profile) throw failure('agent-not-found');
      if (!profile.enabled) throw failure('agent-disabled');
      if (profile.protocol === 'manual-web') throw failure('manual-web-only');
      const key = profile.authMode === 'none' ? '' : keyText(keyFor(profile));
      if (profile.authMode === 'api-key' && !key) throw failure('missing-api-key');
      const { suffix, body } = requestOf(profile, prompt);
      const controller = new AbortController();
      const abort = () => controller.abort(failure('aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timeout = setTimeout(() => controller.abort(failure('timeout')), profile.timeoutMs);
      try {
        if (controller.signal.aborted) throw controller.signal.reason;
        const operation = (async () => {
          const response = await fetchImpl(profile.baseUrl + suffix, {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', ...(profile.authMode === 'none' ? {} : profile.protocol === 'anthropic-messages'
              ? { 'x-api-key': key, 'anthropic-version': profile.apiVersion }
              : { Authorization: `Bearer ${key}` }) }, body: JSON.stringify(body),
          });
          return resultOf(profile.protocol, await responseJson(response, profile.protocol === 'images' ? 20 * MIB : 2 * MIB, controller.signal));
        })();
        return await withAbort(operation, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (error instanceof ProviderError) throw error;
        throw failure('network-error');
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        controller.abort();
      }
    },
  };
}
