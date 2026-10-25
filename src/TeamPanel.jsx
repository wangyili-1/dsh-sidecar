import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import './team.css';

const POLL_MS = 2000;
const STATUS = { queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const BUSY = new Set(['queued', 'running']);
const PROTOCOLS = { 'chat-completions': 'Chat Completions', responses: 'Responses', images: 'Images', 'anthropic-messages': 'Claude Messages' };
const blankProfile = () => ({ name: '', role: '', protocol: 'chat-completions', baseUrl: '', model: '', apiKey: '', apiKeyEnv: '', enabled: false, timeoutMs: 120000, maxOutputTokens: 4096 });
const failureText = (failure, fallback) => typeof failure === 'string' ? failure : failure?.message || fallback;
const configured = agent => Boolean(agent?.enabled && agent.hasKey && agent.model && agent.baseUrl);

/** Never copy list metadata, or an empty password, into a credential update. */
export function profilePayload(draft) {
  const profile = {
    name: draft.name.trim(), role: draft.role.trim(), protocol: draft.protocol,
    baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), apiKeyEnv: draft.apiKeyEnv.trim(),
    enabled: Boolean(draft.enabled), timeoutMs: Number(draft.timeoutMs), maxOutputTokens: Number(draft.maxOutputTokens),
  };
  if (draft.id) profile.id = draft.id;
  if (draft.apiKey.trim()) profile.apiKey = draft.apiKey.trim();
  return profile;
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
    if (pendingCancels.current.has(taskId)) return;
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
    if (!isOpen && !BUSY.has(task.status) && !results[task.id]?.value) void loadResult(task.id);
  };
  const field = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const selected = agents.find(agent => agent.id === agentId);
  const running = tasks.filter(task => BUSY.has(task.status)).length;
  const statusOf = agent => !agent.enabled ? '已停用' : configured(agent) ? '已配置' : '未配置';

  return <section className="dsh-team" aria-label="协作任务">
    <header className="dsh-team-heading"><span><Icon kind="team"/>协作</span><span>{running ? `${running} 项进行中` : '按需分派'}</span></header>
    {(error || connectionError) && <div className="dsh-team-error" role="status">{error || connectionError}</div>}
    <div className="dsh-team-tasks" aria-label="任务列表">
      {!tasks.length && <div className="dsh-team-empty"><Icon kind="team"/><strong>{!loaded ? '正在读取协作任务…' : '把一部分工作交给专长模型'}</strong><p>在下方选择成员并分派任务，主任务分派的协作也会显示在这里。</p></div>}
      {[...tasks].sort((a, b) => (Date.parse(b.createdAt) || Number(b.createdAt) || 0) - (Date.parse(a.createdAt) || Number(a.createdAt) || 0)).map(task => {
        const isOpen = expanded.includes(task.id);
        const detail = results[task.id];
        const result = detail?.value || task.result;
        return <article key={task.id} className="dsh-team-task" data-task-id={task.id}>
          <div className="dsh-team-task-row"><button className="dsh-team-task-toggle" type="button" aria-expanded={isOpen} aria-controls={`${prefix}-result-${task.id}`} onClick={() => toggleTask(task)}><span className="dsh-team-task-title">{task.title || '协作任务'}</span><span className="dsh-team-task-meta">{task.agentName || task.agentId} · <span data-status={task.status}>{STATUS[task.status] || task.status}</span></span></button>{BUSY.has(task.status) && <button className="dsh-team-text-button" type="button" disabled={cancelling.includes(task.id)} onClick={() => void cancelTask(task.id)} aria-label={`取消任务 ${task.title || task.id}`}>{cancelling.includes(task.id) ? '取消中…' : '取消'}</button>}</div>
          {isOpen && <div className="dsh-team-result" id={`${prefix}-result-${task.id}`}><details className="dsh-team-request"><summary>任务要求</summary><pre>{task.prompt}</pre></details>
            {task.error && <p className="dsh-team-error">{failureText(task.error, '任务失败')}</p>}
            {BUSY.has(task.status) && <p className="dsh-team-hint">{task.status === 'queued' ? '等待可用执行位置。' : '成员正在处理，状态会自动更新。'}</p>}
            {result?.text && <pre className="dsh-team-output">{result.text}</pre>}
            {detail?.loading && <p className="dsh-team-hint">读取产物中…</p>}
            {detail?.error && <p className="dsh-team-error">{detail.error} <button type="button" className="dsh-team-text-button" onClick={() => void loadResult(task.id)}>重试</button></p>}
            {(result?.artifacts || []).map(artifact => <figure key={artifact.id} className="dsh-team-artifact">{artifactImage(artifact) ? <a href={artifact.dataUrl} download={artifact.name}><img src={artifact.dataUrl} alt={artifact.name || '生成图片'} loading="lazy"/></a> : null}<figcaption>{artifact.name || artifact.path || '产物'}{!artifactImage(artifact) && artifact.mimeType?.startsWith('image/') && !detail?.loading && <button className="dsh-team-text-button" type="button" onClick={() => void loadResult(task.id)}>查看图片</button>}</figcaption></figure>)}
            {!BUSY.has(task.status) && !detail?.loading && !result?.text && !result?.artifacts?.length && !task.error && <p className="dsh-team-hint">没有文本或图片产物。</p>}
          </div>}
        </article>;
      })}
    </div>
    <form className="dsh-team-composer" onSubmit={submit}>
      <textarea aria-label="协作任务要求" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="描述要交给成员的工作…" rows={3} maxLength={60000} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); void submit(); } }}/>
      <div className="dsh-team-composer-bar"><select aria-label="执行成员" value={agentId} onChange={event => setAgentId(event.target.value)} disabled={!agents.length}>{!agents.length && <option value="">尚未配置成员</option>}{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {statusOf(agent)}</option>)}</select><button ref={configTrigger} className="dsh-team-icon-button" type="button" aria-label="配置协作成员" title="配置协作成员" onClick={() => { setConfigOpen(true); setDraft(null); setConfigError(''); }}><Icon kind="config"/></button><button className="dsh-team-send" type="submit" aria-label="分派任务" disabled={sending || !prompt.trim() || !configured(selected)} title={configured(selected) ? '分派任务（Ctrl / ⌘ Enter）' : '请先配置并启用成员'}><Icon kind="send"/>{sending ? '分派中' : '分派'}</button></div>
      <p className="dsh-team-hint">{selected && !configured(selected) ? '该成员尚未就绪，请先完成配置并启用。' : '产物保留在当前主会话，由主任务按需整合。'}</p>
    </form>
    <dialog ref={dialog} className="dsh-team-config" aria-labelledby={`${prefix}-config-title`} onCancel={event => { event.preventDefault(); closeConfig(); }} onClose={() => { if (configOpen) closeConfig(); }}>
      <header><h2 id={`${prefix}-config-title`}>协作成员</h2><button className="dsh-team-icon-button" type="button" aria-label="关闭成员配置" onClick={closeConfig}><Icon kind="close"/></button></header>
      <div className="dsh-team-config-body">
        <div className="dsh-team-agent-list">{agents.map(agent => <button className={`dsh-team-agent${draft?.id === agent.id ? ' is-selected' : ''}`} type="button" key={agent.id} disabled={saving} onClick={() => editAgent(agent)}><span><strong>{agent.name}</strong><small>{agent.role || agent.model || PROTOCOLS[agent.protocol]}</small></span><span>{statusOf(agent)}</span></button>)}<button className="dsh-team-add" type="button" disabled={saving} onClick={() => { configEpoch.current++; setDraft({ ...blankProfile(), id: `agent-${globalThis.crypto.randomUUID()}`, isNew: true }); setConfigError(''); setRemoveId(null); }}>＋ 添加成员</button></div>
        {draft ? <form className="dsh-team-profile" onSubmit={event => { event.preventDefault(); void mutateProfile('save'); }}>
          <fieldset disabled={saving}>
            <label>名称<input required value={draft.name} onChange={event => field('name', event.target.value)} maxLength={80}/></label>
            <label>专长说明<input value={draft.role} placeholder="例如：代码审查、图片生成" onChange={event => field('role', event.target.value)} maxLength={1000}/></label>
            <div className="dsh-team-field-row"><label>接口<select value={draft.protocol} onChange={event => field('protocol', event.target.value)}>{Object.entries(PROTOCOLS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label><label>模型<input required={draft.enabled} maxLength={160} value={draft.model} placeholder="模型 ID" onChange={event => field('model', event.target.value)}/></label></div>
            <label>API Base URL<input required type="url" maxLength={2048} value={draft.baseUrl} placeholder="https://api.example.com/v1" onChange={event => field('baseUrl', event.target.value)}/></label>
            <label>API Key<input type="password" autoComplete="new-password" maxLength={4096} value={draft.apiKey} placeholder={draft.hasKey ? '已保存，留空保留' : '输入密钥，或在高级设置中指定环境变量'} onChange={event => field('apiKey', event.target.value)}/></label>
            <details><summary>高级设置</summary><label>密钥环境变量<input value={draft.apiKeyEnv} maxLength={128} pattern="[A-Za-z_][A-Za-z0-9_]*" placeholder="例如 OPENAI_API_KEY" onChange={event => field('apiKeyEnv', event.target.value)}/></label><p className="dsh-team-hint">环境变量保存后会读取配置状态，读取到密钥即可启用。</p><div className="dsh-team-field-row"><label>超时（毫秒）<input type="number" required min="1000" max="600000" step="1000" value={draft.timeoutMs} onChange={event => field('timeoutMs', event.target.value)}/></label><label>输出 token 上限<input type="number" required min="1" max="65536" value={draft.maxOutputTokens} onChange={event => field('maxOutputTokens', event.target.value)}/></label></div></details>
            <label className="dsh-team-checkbox"><input type="checkbox" checked={draft.enabled} disabled={!draft.enabled && !(draft.model.trim() && draft.baseUrl.trim() && (draft.hasKey || draft.apiKey.trim()))} onChange={event => field('enabled', event.target.checked)}/>启用此成员</label>
          </fieldset>
          {configError && <p className="dsh-team-error" role="status">{configError}</p>}
          <footer>{draft.id && !draft.isNew && (removeId === draft.id ? <span className="dsh-team-remove-confirm">移除此配置？<button className="dsh-team-text-button" type="button" disabled={saving} onClick={() => void mutateProfile('remove')}>确认</button><button className="dsh-team-text-button" type="button" disabled={saving} onClick={() => setRemoveId(null)}>取消</button></span> : <button className="dsh-team-text-button" type="button" disabled={saving} onClick={() => setRemoveId(draft.id)}>移除</button>)}<button type="submit" className="dsh-team-save" disabled={saving}>{saving ? '保存中…' : '保存配置'}</button></footer>
        </form> : <p className="dsh-team-hint">选择成员配置接口和模型。只有明确分派任务时才会调用该成员。</p>}
        <p className="dsh-team-hint">中转服务可使用自定义 Base URL 和模型 ID。WorkBuddy 需要开放平台 OAuth 或外部 agent 接入，不能填普通聊天网址。</p>
      </div>
    </dialog>
  </section>;
}
