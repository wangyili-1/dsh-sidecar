// Browser-safe resource catalog and readiness checks: no filesystem, credentials,
// network probes, or automatic model installation. URLs checked 2026-10-26.
const API_PROTOCOLS = new Set(['chat-completions', 'responses', 'images', 'anthropic-messages']);

function parsedEndpoint(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\\?#]/u.test(value)) return null;
  const authority = value.match(/^https?:\/\/([^/]+)/i)?.[1];
  if (!authority || authority.includes('@')) return null;
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

export function isLoopbackAgentUrl(value) {
  const url = parsedEndpoint(value);
  return Boolean(url && /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(value));
}

export function isManualWebUrl(value) {
  return parsedEndpoint(value)?.protocol === 'https:';
}

/** Static configuration readiness only; this does not verify an account or a running local server. */
export function isAgentReady(profile) {
  if (!profile || profile.enabled !== true || (profile.ready !== undefined && profile.ready !== true)) return false;
  const authMode = profile.authMode ?? 'api-key';
  if (profile.protocol === 'manual-web') return authMode === 'none' && isManualWebUrl(profile.baseUrl);
  if (!API_PROTOCOLS.has(profile.protocol) || typeof profile.model !== 'string' || !profile.model.trim() || profile.model.length > 160) return false;
  const url = parsedEndpoint(profile.baseUrl);
  if (!url || (url.protocol !== 'https:' && !isLoopbackAgentUrl(profile.baseUrl))) return false;
  if (authMode === 'none') return ['chat-completions', 'responses'].includes(profile.protocol) && isLoopbackAgentUrl(profile.baseUrl);
  return authMode === 'api-key' && profile.hasKey === true;
}

export const RESOURCE_PRESETS = Object.freeze([
  {
    id: 'deepseek-web', name: 'DeepSeek 网页版',
    description: '在官方网页手动提问，再粘贴结果回传；网页体验不等于免费 API，使用范围以官网为准。',
    docsUrl: 'https://www.deepseek.com/download/',
    profile: { name: 'DeepSeek 网页版', role: '', protocol: 'manual-web', authMode: 'none', baseUrl: 'https://chat.deepseek.com/', model: '', enabled: true },
  },
  {
    id: 'doubao-web', name: '豆包网页版',
    description: '外部打开豆包，复制任务后手动完成并回传；免费功能和次数以当前账号为准。',
    docsUrl: 'https://www.doubao.com/chat/',
    profile: { name: '豆包网页版', role: '', protocol: 'manual-web', authMode: 'none', baseUrl: 'https://www.doubao.com/chat/', model: '', enabled: true },
  },
  {
    id: 'qwen-web', name: 'Qwen 网页版',
    description: '使用官方网页免费助手，手动粘贴结果；网站限制跨域嵌入，需在外部浏览器打开。',
    docsUrl: 'https://qwen.ai/qwenchat',
    profile: { name: 'Qwen 网页版', role: '', protocol: 'manual-web', authMode: 'none', baseUrl: 'https://chat.qwen.ai/', model: '', enabled: true },
  },
  {
    id: 'kimi-web', name: 'Kimi 网页版',
    description: '使用官方网页并手动回传；免费档的模型与任务额度有限，会员权益不等于 API 余额。',
    docsUrl: 'https://www.kimi.com/membership/pricing',
    profile: { name: 'Kimi 网页版', role: '', protocol: 'manual-web', authMode: 'none', baseUrl: 'https://www.kimi.com/', model: '', enabled: true },
  },
  {
    id: 'ollama-local', name: 'Ollama 本地模型',
    description: '连接本机已安装的本地模型，无需 API Key；先填写实际模型名并启用，不自动安装。云模型不属于本地免费运行。',
    docsUrl: 'https://docs.ollama.com/api/openai-compatibility',
    profile: { name: 'Ollama 本地模型', role: '', protocol: 'chat-completions', authMode: 'none', baseUrl: 'http://127.0.0.1:11434/v1', model: '', enabled: false },
  },
].map(resource => Object.freeze({ ...resource, profile: Object.freeze(resource.profile) })));
