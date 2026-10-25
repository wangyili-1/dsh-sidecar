import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { RESOURCE_PRESETS, isAgentReady, isManualWebUrl } from './agent-resources.mjs';
import './team.css';

const POLL_MS = 2000;
const STATUS = { queued: '排队中', running: '执行中', 'awaiting-user': '等待你粘贴回答', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const BUSY = new Set(['queued', 'running']);
const CANCELLABLE = new Set(['queued', 'running', 'awaiting-user']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const PROTOCOLS = { 'chat-completions': 'Chat Completions', responses: 'Responses', images: 'Images', 'anthropic-messages': 'Claude Messages', 'manual-web': '网页人工交接' };
const blankProfile = () => ({ name: '', role: '', protocol: 'chat-completions', authMode: 'api-key', baseUrl: '', model: '', apiKey: '', apiKeyEnv: '', enabled: false, timeoutMs: 120000, maxOutputTokens: 4096 });
const failureText = (failure, fallback) => typeof failure === 'string' ? failure : failure?.message || fallback;
const configured = agent => isAgentReady(agent);
const manualProfile = profile => profile?.protocol === 'manual-web';
const localProfile = profile => !manualProfile(profile) && profile?.authMode === 'none';

/** Never copy list metadata, or an empty password, into a credential update. */
export function profilePayload(draft) {
  const profile = {
    name: draft.name.trim(), role: draft.role.trim(), protocol: draft.protocol,
    authMode: manualProfile(draft) ? 'none' : draft.authMode || 'api-key',
    baseUrl: draft.baseUrl.trim(), enabled: Boolean(draft.enabled),
  };
  if (!manualProfile(draft)) Object.assign(profile, { model: draft.model.trim(), timeoutMs: Number(draft.timeoutMs), maxOutputTokens: Number(draft.maxOutputTokens) });
  if (draft.id) profile.id = draft.id;
  if (profile.authMode === 'api-key') {
    profile.apiKeyEnv = draft.apiKeyEnv.trim();
    if (draft.apiKey.trim()) profile.apiKey = draft.apiKey.trim();
  }
  return profile;
}

/** Website handoff opens a plain HTTPS page, never an embedded prompt or credential. */
export function handoffWebsite(value) {
  try {
    return isManualWebUrl(value) ? new URL(value).href : undefined;
  } catch { return undefined; }
}

export function artifactImage(artifact) {
  return /^image\/(?:png|jpeg|webp|gif)$/i.test(artifact?.mimeType || '') && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(artifact?.dataUrl || '') ? artifact.dataUrl : undefined;
}

function Icon({ kind }) {
  const paths = {
    config: <><path d="M10 6h10M4 12h8M18 12h2M4 18h3M13 18h7"/><circle cx="6" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></>,
    team: <><circle cx="9" cy="7" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2"/></>,
    send: <><path d="m5 12 7-7 7 7M12 5v15"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
  };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

export default function TeamPanel(props) { return <TeamSession key={String(props.mainSessionId)} {...props}/>; }

function TeamSession({ api, mainSessionId }) {
  const transport = useRef(api); transport.current = api;
  const scope = useRef(null);
  const pollSequence = useRef(0);
  const dialog = useRef(null);
  const configTrigger = useRef(null);
  const configEpoch = useRef(0);
  const pendingMutation = useRef(false);
  const pendingSubmit = useRef(false);
  const pendingCancels = useRef(new Set());
  const pendingManual = useRef(new Set());
  const resultPending = useRef(new Set());
  const prefix = useId();
  const [agents, setAgents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [error, setError] = useState('');
  const [agentId, setAgentId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState([]);
  const [expanded, setExpanded] = useState([]);
  const [results, setResults] = useState({});
  const [answers, setAnswers] = useState({});
  const [manualActions, setManualActions] = useState({});
  const [configOpen, setConfigOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [configError, setConfigError] = useState('');
  const [removeId, setRemoveId] = useState(null);
  const currentScope = token => Boolean(token && scope.current === token && !token.signal.aborted);
  const refresh = useCallback(async token => {
    if (!token || token.signal.aborted) return;
    const sequence = ++pollSequence.current;
    try {
      const [agentValue, taskValue] = await Promise.all([
        transport.current.call('team/agents/list', { mainSessionId }, token.signal),
        transport.current.call('team/tasks/list', { mainSessionId }, token.signal),
      ]);
      if (scope.current !== token || token.signal.aborted || sequence !== pollSequence.current) return;
      const nextAgents = Array.isArray(agentValue?.agents) ? agentValue.agents : [];
      setAgents(nextAgents);
      setTasks((Array.isArray(taskValue?.tasks) ? taskValue.tasks : []).filter(task => task.mainSessionId === mainSessionId));
      setAgentId(value => nextAgents.some(agent => agent.id === value) ? value : (nextAgents.find(configured)?.id || nextAgents[0]?.id || ''));
      setLoaded(true); setConnectionError('');
    } catch (failure) {
      if (scope.current === token && !token.signal.aborted && sequence === pollSequence.current) setConnectionError(failureText(failure, '协作任务暂不可用'));
    }
  }, [mainSessionId]);
  useEffect(() => {
    const controller = new AbortController();
    const token = { signal: controller.signal }; scope.current = token;
    let pending = false;
    const poll = async () => { if (pending) return; pending = true; try { await refresh(token); } finally { pending = false; } };
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { controller.abort(); clearInterval(timer); if (scope.current === token) scope.current = null; };
  }, [refresh]);
  useEffect(() => {
    const element = dialog.current;
    if (configOpen && element && !element.open) element.showModal();
    else if (!configOpen && element?.open) element.close();
  }, [configOpen]);

  const closeConfig = () => {
    configEpoch.current++;
    setConfigOpen(false); setDraft(null); setConfigError(''); setRemoveId(null);
    configTrigger.current?.focus();
  };
  const editAgent = agent => {
    configEpoch.current++;
    setDraft({ ...blankProfile(), ...Object.fromEntries(Object.keys(blankProfile()).filter(key => key !== 'apiKey').map(key => [key, agent[key] ?? blankProfile()[key]])), id: agent.id, hasKey: Boolean(agent.hasKey) });
    setConfigError(''); setRemoveId(null);
  };
  const mutateProfile = async action => {
    if (pendingMutation.current) return;
    const token = scope.current;
    const epoch = configEpoch.current;
    pendingMutation.current = true; setSaving(true); setConfigError('');
    try {
      const endpoint = action === 'remove' ? 'team/agents/remove' : 'team/agents/save';
      const payload = action === 'remove' ? { agentId: draft.id } : { profile: profilePayload(draft) };
      await transport.current.call(endpoint, { mainSessionId, ...payload }, token?.signal);
      if (!currentScope(token)) return;
      if (configEpoch.current === epoch) { setDraft(null); setRemoveId(null); }
      await refresh(token);
    } catch (failure) {
      if (currentScope(token) && configEpoch.current === epoch) setConfigError(failureText(failure, '未能保存协作配置'));
    } finally { pendingMutation.current = false; if (currentScope(token)) setSaving(false); }
  };
  const submit = async event => {
    event?.preventDefault();
    const selected = agents.find(agent => agent.id === agentId);
    const text = prompt.trim();
    if (pendingSubmit.current || !text || !configured(selected)) return;
    const token = scope.current;
    pendingSubmit.current = true; setSending(true); setError('');
    try {
      await transport.current.call('team/tasks/submit', { mainSessionId, agentId, prompt: text, title: text.split('\n')[0].slice(0, 70) }, token?.signal);
      if (!currentScope(token)) return;
      setPrompt(value => value.trim() === text ? '' : value);
      await refresh(token);
    } catch (failure) { if (currentScope(token)) setError(failureText(failure, '未能分派任务')); }
    finally { pendingSubmit.current = false; if (currentScope(token)) setSending(false); }
  };
  const cancelTask = async taskId => {
    if (pendingCancels.current.has(taskId) || pendingManual.current.has(taskId)) return;
    const token = scope.current;
    pendingCancels.current.add(taskId); setCancelling(value => [...value, taskId]); setError('');
    try {
      await transport.current.call('team/tasks/cancel', { mainSessionId, taskId }, token?.signal);
      if (currentScope(token)) await refresh(token);
    } catch (failure) { if (currentScope(token)) setError(failureText(failure, '未能取消任务')); }
    finally { pendingCancels.current.delete(taskId); if (currentScope(token)) setCancelling(value => value.filter(id => id !== taskId)); }
  };
  const loadResult = async taskId => {
    if (resultPending.current.has(taskId)) return;
    const token = scope.current; resultPending.current.add(taskId);
    setResults(value => ({ ...value, [taskId]: { loading: true } }));
    try {
      const result = await transport.current.call('team/tasks/result', { mainSessionId, taskId }, token?.signal);
      if (currentScope(token)) setResults(value => ({ ...value, [taskId]: { value: result } }));
    } catch (failure) { if (currentScope(token)) setResults(value => ({ ...value, [taskId]: { error: failureText(failure, '未能读取产物') } })); }
    finally { resultPending.current.delete(taskId); }
  };
  const toggleTask = task => {
    const isOpen = expanded.includes(task.id);
    setExpanded(value => isOpen ? value.filter(id => id !== task.id) : [...value, task.id]);
    if (!isOpen && TERMINAL.has(task.status) && !results[task.id]?.value) void loadResult(task.id);
  };
  const copyHandoff = async task => {
    const text = task.handoff?.prompt;
    if (typeof text !== 'string' || !text) return;
    const token = scope.current;
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await globalThis.navigator.clipboard.writeText(text);
      if (currentScope(token)) setManualActions(value => ({ ...value, [task.id]: { ...value[task.id], copy: 'copied' } }));
    } catch {
      if (currentScope(token)) setManualActions(value => ({ ...value, [task.id]: { ...value[task.id], copy: 'failed' } }));
    }
  };
  const completeManual = async (event, task) => {
    event.preventDefault();
    const text = (answers[task.id] || '').trim();
    if (task.status !== 'awaiting-user' || !text || pendingManual.current.has(task.id) || pendingCancels.current.has(task.id)) return;
    const token = scope.current;
    pendingManual.current.add(task.id);
    setManualActions(value => ({ ...value, [task.id]: { ...value[task.id], completing: true, error: '' } }));
    try {
      await transport.current.call('team/tasks/complete-manual', { mainSessionId, taskId: task.id, text }, token?.signal);
      if (!currentScope(token)) return;
      setAnswers(value => { const next = { ...value }; delete next[task.id]; return next; });
      setResults(value => { const next = { ...value }; delete next[task.id]; return next; });
      await refresh(token);
    } catch (failure) {
      if (currentScope(token)) setManualActions(value => ({ ...value, [task.id]: { ...value[task.id], error: failureText(failure, '未能保存回答，内容已保留') } }));
    } finally {
      pendingManual.current.delete(task.id);
      if (currentScope(token)) setManualActions(value => ({ ...value, [task.id]: { ...value[task.id], completing: false } }));
    }
  };
  const field = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const changeProtocol = protocol => setDraft(current => {
    const crossingWebsite = manualProfile(current) !== (protocol === 'manual-web');
    return { ...current, protocol, ...(crossingWebsite ? { baseUrl: '', model: '', apiKey: '', apiKeyEnv: '', hasKey: false, enabled: false, authMode: protocol === 'manual-web' ? 'none' : 'api-key' } : {}) };
  });
  const changeAuth = authMode => setDraft(current => ({ ...current, authMode, apiKey: '', apiKeyEnv: '', hasKey: false, enabled: false }));
  const useResource = resource => {
    configEpoch.current++;
    setDraft({ ...blankProfile(), ...resource.profile, id: `agent-${globalThis.crypto.randomUUID()}`, isNew: true, resourceDescription: resource.description, docsUrl: handoffWebsite(resource.docsUrl) });
    setConfigError(''); setRemoveId(null);
  };
  const selected = agents.find(agent => agent.id === agentId);
  const running = tasks.filter(task => BUSY.has(task.status)).length;
  const waiting = tasks.filter(task => task.status === 'awaiting-user').length;
  const modeOf = agent => manualProfile(agent) ? '网页人工' : localProfile(agent) ? '本地接口' : 'API';
  const statusOf = agent => !agent.enabled ? '已停用' : configured(agent) ? manualProfile(agent) ? '人工交接' : localProfile(agent) ? '配置完整' : '已配置' : '未配置';
  const canEnable = draft && isAgentReady({ ...draft, enabled: true, hasKey: draft.hasKey || Boolean(draft.apiKey.trim()) });

  return <section className="dsh-team" aria-label="协作任务">
    <header className="dsh-team-heading"><span><Icon kind="team"/>协作</span><span>{[running && `${running} 项进行中`, waiting && `${waiting} 项待你处理`].filter(Boolean).join(' · ') || '按需分派'}</span></header>
    {(error || connectionError) && <div className="dsh-team-error" role="status">{error || connectionError}</div>}
    <div className="dsh-team-tasks" aria-label="任务列表">
      {!tasks.length && <div className="dsh-team-empty"><Icon kind="team"/><strong>{!loaded ? '正在读取协作任务…' : '把一部分工作交给专长模型'}</strong><p>在下方选择成员并分派任务，主任务分派的协作也会显示在这里。</p></div>}
      {[...tasks].sort((a, b) => (Date.parse(b.createdAt) || Number(b.createdAt) || 0) - (Date.parse(a.createdAt) || Number(a.createdAt) || 0)).map(task => {
        const isOpen = expanded.includes(task.id);
        const detail = results[task.id];
        const result = detail?.value || task.result;
        const action = manualActions[task.id] || {};
        const website = handoffWebsite(task.handoff?.url);
        return <article key={task.id} className="dsh-team-task" data-task-id={task.id}>
          <div className="dsh-team-task-row"><button className="dsh-team-task-toggle" type="button" aria-expanded={isOpen} aria-controls={`${prefix}-result-${task.id}`} onClick={() => toggleTask(task)}><span className="dsh-team-task-title">{task.title || '协作任务'}</span><span className="dsh-team-task-meta">{task.agentName || task.agentId} · <span data-status={task.status}>{STATUS[task.status] || task.status}</span></span></button>{CANCELLABLE.has(task.status) && <button className="dsh-team-text-button" type="button" disabled={cancelling.includes(task.id) || action.completing} onClick={() => void cancelTask(task.id)} aria-label={`取消任务 ${task.title || task.id}`}>{cancelling.includes(task.id) ? '取消中…' : '取消'}</button>}</div>
          {isOpen && <div className="dsh-team-result" id={`${prefix}-result-${task.id}`}><details className="dsh-team-request"><summary>任务要求</summary><pre>{task.prompt}</pre></details>
            {task.error && <p className="dsh-team-error">{failureText(task.error, '任务失败')}</p>}
            {BUSY.has(task.status) && <p className="dsh-team-hint">{task.status === 'queued' ? '等待可用执行位置。' : '成员正在处理，状态会自动更新。'}</p>}
            {task.status === 'awaiting-user' && <div className="dsh-team-handoff">
              <p className="dsh-team-hint">把提示词粘贴到网页，取得回答后粘贴回这里。网页额度和登录要求以官网为准。</p>
              <div className="dsh-team-handoff-actions"><button className="dsh-team-text-button" type="button" disabled={!task.handoff?.prompt} onClick={() => void copyHandoff(task)} aria-label={`复制提示词 ${task.title || task.id}`}>{action.copy === 'copied' ? '已复制提示词' : '复制提示词'}</button>{website && <a href={website} target="_blank" rel="noopener noreferrer">打开官网 ↗</a>}</div>
              {action.copy === 'failed' && <label className="dsh-team-copy-fallback"><span>复制失败，请选中下方文本手动复制。</span><textarea readOnly aria-label={`交接提示词 ${task.title || task.id}`} value={task.handoff?.prompt || ''} rows={4} onFocus={event => event.target.select()}/></label>}
              {!website && <p className="dsh-team-hint">官网地址不可用，请检查此任务的交接信息。</p>}
              <form className="dsh-team-manual-form" onSubmit={event => void completeManual(event, task)}><textarea aria-label={`粘贴回答 ${task.title || task.id}`} placeholder="粘贴网页上的回答…" value={answers[task.id] || ''} onChange={event => { const text = event.target.value; setAnswers(value => ({ ...value, [task.id]: text })); }} rows={4} maxLength={100000} disabled={action.completing}/>{action.error && <p className="dsh-team-error" role="status">{action.error}</p>}<button type="submit" className="dsh-team-save" disabled={action.completing || cancelling.includes(task.id) || !(answers[task.id] || '').trim()}>{action.completing ? '保存中…' : '保存回答并完成'}</button></form>
            </div>}
            {task.executionMode === 'web-manual' && task.status === 'completed' && <p className="dsh-team-hint">网页回答 · 用户粘贴</p>}
            {result?.text && <pre className="dsh-team-output">{result.text}</pre>}
            {detail?.loading && <p className="dsh-team-hint">读取产物中…</p>}
            {detail?.error && <p className="dsh-team-error">{detail.error} <button type="button" className="dsh-team-text-button" onClick={() => void loadResult(task.id)}>重试</button></p>}
            {(result?.artifacts || []).map(artifact => <figure key={artifact.id} className="dsh-team-artifact">{artifactImage(artifact) ? <a href={artifact.dataUrl} download={artifact.name}><img src={artifact.dataUrl} alt={artifact.name || '生成图片'} loading="lazy"/></a> : null}<figcaption>{artifact.name || artifact.path || '产物'}{!artifactImage(artifact) && artifact.mimeType?.startsWith('image/') && !detail?.loading && <button className="dsh-team-text-button" type="button" onClick={() => void loadResult(task.id)}>查看图片</button>}</figcaption></figure>)}
            {TERMINAL.has(task.status) && !detail?.loading && !result?.text && !result?.artifacts?.length && !task.error && <p className="dsh-team-hint">没有文本或图片产物。</p>}
          </div>}
        </article>;
      })}
    </div>
    <form className="dsh-team-composer" onSubmit={submit}>
      <textarea aria-label="协作任务要求" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="描述要交给成员的工作…" rows={3} maxLength={60000} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); void submit(); } }}/>
      <div className="dsh-team-composer-bar"><select aria-label="执行成员" value={agentId} onChange={event => setAgentId(event.target.value)} disabled={!agents.length}>{!agents.length && <option value="">尚未配置成员</option>}{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {modeOf(agent)} · {statusOf(agent)}</option>)}</select><button ref={configTrigger} className="dsh-team-icon-button" type="button" aria-label="配置协作成员" title="配置协作成员" onClick={() => { setConfigOpen(true); setDraft(null); setConfigError(''); }}><Icon kind="config"/></button><button className="dsh-team-send" type="submit" aria-label="分派任务" disabled={sending || !prompt.trim() || !configured(selected)} title={configured(selected) ? '分派任务（Ctrl / ⌘ Enter）' : '请先配置并启用成员'}><Icon kind="send"/>{sending ? '分派中' : '分派'}</button></div>
      <p className="dsh-team-hint">{selected && !configured(selected) ? '请先完成成员配置并启用。' : manualProfile(selected) ? '分派后由你在官网粘贴提示词，再把回答带回这里。' : localProfile(selected) ? '本地服务需已启动，模型需已下载；分派时才会连接。' : '产物保留在当前主会话，由主任务按需整合。'}</p>
    </form>
    <dialog ref={dialog} className="dsh-team-config" aria-labelledby={`${prefix}-config-title`} onCancel={event => { event.preventDefault(); closeConfig(); }} onClose={() => { if (configOpen) closeConfig(); }}>
      <header><h2 id={`${prefix}-config-title`}>协作成员</h2><button className="dsh-team-icon-button" type="button" aria-label="关闭成员配置" onClick={closeConfig}><Icon kind="close"/></button></header>
      <div className="dsh-team-config-body">
        <div className="dsh-team-agent-list">{agents.map(agent => <button className={`dsh-team-agent${draft?.id === agent.id ? ' is-selected' : ''}`} type="button" key={agent.id} disabled={saving} onClick={() => editAgent(agent)}><span><strong>{agent.name}</strong><small>{agent.role || agent.model || PROTOCOLS[agent.protocol]}</small></span><span>{statusOf(agent)}</span></button>)}<button className="dsh-team-add" type="button" disabled={saving} onClick={() => { configEpoch.current++; setDraft({ ...blankProfile(), id: `agent-${globalThis.crypto.randomUUID()}`, isNew: true }); setConfigError(''); setRemoveId(null); }}>＋ 添加成员</button></div>
        <details className="dsh-team-resources"><summary>免费/本地资源</summary><p className="dsh-team-hint">选一个预设，检查配置后保存。网页需要人工交接；本地服务需要自行安装启动。</p><div className="dsh-team-resource-list">{RESOURCE_PRESETS.map(resource => <button key={resource.id} className="dsh-team-resource" type="button" aria-label={`使用资源 ${resource.name}`} disabled={saving} onClick={event => { useResource(resource); const list = event?.currentTarget?.closest?.('details'); if (list) list.open = false; }}><strong>{resource.name}</strong><span>{resource.description}</span></button>)}</div></details>
        {draft ? <form className="dsh-team-profile" onSubmit={event => { event.preventDefault(); void mutateProfile('save'); }}>
          {draft.resourceDescription && <p className="dsh-team-resource-note">{draft.resourceDescription}{draft.docsUrl && <> <a href={draft.docsUrl} target="_blank" rel="noopener noreferrer">说明 ↗</a></>}</p>}
          <fieldset disabled={saving}>
            <label>名称<input required value={draft.name} onChange={event => field('name', event.target.value)} maxLength={80}/></label>
            <label>专长说明<input value={draft.role} placeholder="例如：代码审查、图片生成" onChange={event => field('role', event.target.value)} maxLength={1000}/></label>
            <div className="dsh-team-field-row"><label>接入方式<select aria-label="接入方式" value={draft.protocol} onChange={event => changeProtocol(event.target.value)}>{Object.entries(PROTOCOLS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>{!manualProfile(draft) && <label>鉴权<select aria-label="鉴权方式" value={draft.authMode} onChange={event => changeAuth(event.target.value)}><option value="api-key">API Key</option><option value="none">无需密钥（仅本机）</option></select></label>}</div>
            {!manualProfile(draft) && <label>模型<input required={draft.enabled} maxLength={160} value={draft.model} placeholder={localProfile(draft) ? '已下载的本地模型名称' : '模型 ID'} onChange={event => field('model', event.target.value)}/></label>}
            <label>{manualProfile(draft) ? '官网 URL' : localProfile(draft) ? '本地 API Base URL' : 'API Base URL'}<input required type="url" maxLength={2048} value={draft.baseUrl} placeholder={manualProfile(draft) ? 'https://官方聊天网页' : localProfile(draft) ? 'http://127.0.0.1:11434/v1' : 'https://api.example.com/v1'} onChange={event => field('baseUrl', event.target.value)}/></label>
            {manualProfile(draft) ? <p className="dsh-team-hint">只打开官网并人工交接，不读取网页登录信息。网站可能需要登录或设有使用额度。</p> : localProfile(draft) ? <p className="dsh-team-hint">仅接受本机回环地址。请先安装并启动 Ollama 等兼容服务，再填写已下载模型；配置保存不会检查服务是否运行。</p> : <label>API Key<input type="password" autoComplete="new-password" maxLength={4096} value={draft.apiKey} placeholder={draft.hasKey ? '已保存，留空保留' : '输入密钥，或在高级设置中指定环境变量'} onChange={event => field('apiKey', event.target.value)}/></label>}
            {!manualProfile(draft) && <details><summary>高级设置</summary>{!localProfile(draft) && <><label>密钥环境变量<input value={draft.apiKeyEnv} maxLength={128} pattern="[A-Za-z_][A-Za-z0-9_]*" placeholder="例如 OPENAI_API_KEY" onChange={event => field('apiKeyEnv', event.target.value)}/></label><p className="dsh-team-hint">环境变量保存后会读取配置状态，读取到密钥即可启用。</p></>}<div className="dsh-team-field-row"><label>超时（毫秒）<input type="number" required min="1000" max="600000" step="1000" value={draft.timeoutMs} onChange={event => field('timeoutMs', event.target.value)}/></label><label>输出 token 上限<input type="number" required min="1" max="65536" value={draft.maxOutputTokens} onChange={event => field('maxOutputTokens', event.target.value)}/></label></div></details>}
            <label className="dsh-team-checkbox"><input type="checkbox" checked={draft.enabled} disabled={!draft.enabled && !canEnable} onChange={event => field('enabled', event.target.checked)}/>启用此成员</label>
          </fieldset>
          {configError && <p className="dsh-team-error" role="status">{configError}</p>}
          <footer>{draft.id && !draft.isNew && (removeId === draft.id ? <span className="dsh-team-remove-confirm">移除此配置？<button className="dsh-team-text-button" type="button" disabled={saving} onClick={() => void mutateProfile('remove')}>确认</button><button className="dsh-team-text-button" type="button" disabled={saving} onClick={() => setRemoveId(null)}>取消</button></span> : <button className="dsh-team-text-button" type="button" disabled={saving} onClick={() => setRemoveId(draft.id)}>移除</button>)}<button type="submit" className="dsh-team-save" disabled={saving}>{saving ? '保存中…' : '保存配置'}</button></footer>
        </form> : <p className="dsh-team-hint">选择成员或资源预设，检查配置后保存。只有明确分派时才开始任务。</p>}
        <p className="dsh-team-hint">中转服务可使用自定义 Base URL 和模型 ID。WorkBuddy 需要开放平台 OAuth 或外部 agent 接入，不能填普通聊天网址。</p>
      </div>
    </dialog>
  </section>;
}
