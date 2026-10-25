import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './composer.css';

const tokenCount = value => Number.isFinite(value) ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : '—';
const seconds = value => Number.isFinite(value) ? `${(value / 1000).toFixed(1)} 秒` : '—';
function Glyph({ name, size = 14 }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14"/>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/></>,
    chevron: <path d="m7 10 5 5 5-5"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export default function ComposerBar({ api, sessionId, mainSessionId, onPacket, children }) {
  const [snapshot, setSnapshot] = useState(null);
  const [menu, setMenu] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attachmentKind, setAttachmentKind] = useState('file');
  const [path, setPath] = useState('');
  const [quote, setQuote] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [portalHost, setPortalHost] = useState(null);
  const [popupLayout, setPopupLayout] = useState(null);
  const runtime = useRef(null);
  const root = useRef(null);
  const popup = useRef(null);
  const alive = useRef(true);
  const identity = useRef(0);
  const pendingOperation = useRef(null);
  const isCurrent = useCallback(ticket => alive.current && identity.current === ticket, []);
  useEffect(() => {
    let cancelled = false;
    let unsubscribe;
    identity.current++;
    alive.current = true;
    pendingOperation.current = null;
    setBusy(false);
    setSnapshot(null);
    setMenu(null);
    setError('');
    setAcknowledged(false);
    runtime.current = null;
    if (sessionId && api.runtime?.bind) {
      void api.runtime.bind(sessionId).then(binding => {
        if (cancelled) return;
        runtime.current = binding;
        const refresh = () => { if (!cancelled) setSnapshot(binding.getSnapshot()); };
        unsubscribe = binding.subscribe(refresh);
        refresh();
        // Resolve the real default for an empty sidechat too; this reads the
        // catalog and never selects a model or sends a prompt.
        void binding.loadModels().then(refresh).catch(failure => { if (!cancelled) setError(failure?.message || '模型列表暂不可用'); });
      }).catch(() => { if (!cancelled) setError('暂时无法读取侧聊设置'); });
    }
    return () => { cancelled = true; identity.current++; alive.current = false; runtime.current = null; unsubscribe?.(); };
  }, [api, sessionId, mainSessionId]);
  useLayoutEffect(() => {
    if (!menu) { setPortalHost(null); setPopupLayout(null); return; }
    // A portal outside the tab surface escapes each split pane's overflow clip,
    // while retaining the workspace's native theme and bounds.
    const host = root.current?.closest('.dsh-ws') || root.current?.closest('.dsh-sidecar');
    setPortalHost(host || null);
  }, [menu]);
  const positionPopup = useCallback(() => {
    if (!menu || !portalHost || !root.current || !popup.current) return;
    if (!root.current.getClientRects().length || root.current.closest('[hidden]')) { setMenu(null); return; }
    const bounds = portalHost.getBoundingClientRect();
    const anchor = root.current.getBoundingClientRect();
    const margin = 8, gap = 8;
    const hostWidth = portalHost.clientWidth;
    const hostHeight = portalHost.clientHeight;
    const originLeft = bounds.left + portalHost.clientLeft;
    const originTop = bounds.top + portalHost.clientTop;
    const anchorTop = anchor.top - originTop;
    const anchorBottom = anchor.bottom - originTop;
    const width = Math.max(0, Math.min(Math.max(anchor.width, 260), hostWidth - margin * 2));
    const above = Math.max(0, anchorTop - margin - gap);
    const below = Math.max(0, hostHeight - anchorBottom - margin - gap);
    const naturalHeight = Math.min(400, popup.current.scrollHeight + 2);
    const up = above >= naturalHeight || above >= below;
    const room = up ? above : below;
    // Very short workspaces use the whole available box rather than rendering
    // a tiny off-screen menu. The menu itself remains scrollable.
    const fallback = room < 96;
    const maxHeight = Math.max(0, Math.min(400, fallback ? hostHeight - margin * 2 : room));
    const height = Math.min(naturalHeight, maxHeight);
    const next = {
      left: Math.max(margin, Math.min(anchor.left - originLeft, hostWidth - margin - width)),
      top: fallback ? margin : up ? Math.max(margin, anchorTop - gap - height) : Math.min(hostHeight - margin - height, anchorBottom + gap),
      width, maxHeight, visibility: 'visible',
    };
    setPopupLayout(previous => previous && Object.keys(next).every(key => previous[key] === next[key]) ? previous : next);
  }, [menu, portalHost]);
  // Also runs after moving a mounted chat between top and bottom tab groups.
  useLayoutEffect(positionPopup);
  useEffect(() => {
    if (!menu || !portalHost) return undefined;
    const owner = portalHost.ownerDocument;
    const view = owner.defaultView;
    const observer = view?.ResizeObserver ? new view.ResizeObserver(positionPopup) : null;
    observer?.observe(portalHost);
    if (root.current) observer?.observe(root.current);
    view?.addEventListener('resize', positionPopup);
    owner.addEventListener('scroll', positionPopup, true);
    return () => { observer?.disconnect(); view?.removeEventListener('resize', positionPopup); owner.removeEventListener('scroll', positionPopup, true); };
  }, [menu, portalHost, positionPopup]);
  useEffect(() => {
    if (!menu) return undefined;
    const owner = root.current?.ownerDocument;
    const outside = event => { if (!root.current?.contains(event.target) && !popup.current?.contains(event.target)) setMenu(null); };
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); setMenu(null); } };
    owner?.addEventListener('pointerdown', outside);
    owner?.addEventListener('keydown', escape);
    return () => { owner?.removeEventListener('pointerdown', outside); owner?.removeEventListener('keydown', escape); };
  }, [menu]);

  const permissions = snapshot?.permissions;
  const permission = permissions?.options?.find(item => item.value === permissions.currentValue);
  const selection = snapshot?.modelSelection || snapshot?.models?.current;
  const models = snapshot?.models?.items || [];
  const model = models.find(item => item.provider === selection?.provider && item.model === selection?.model);
  const effort = model?.reasoningEfforts?.find(item => item.id === selection?.reasoningEffort);
  const effortName = effort?.name || selection?.reasoningEffort || '';
  const modelName = model?.label || selection?.model || '读取模型…';
  const stats = snapshot?.stats;
  const usage = snapshot?.usage;
  const inputTokens = usage ? usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : undefined;
  const hitRate = inputTokens > 0 ? Math.round(usage.cacheReadTokens / inputTokens * 100) : undefined;
  const context = snapshot?.context;
  const used = context?.projectedTokens ?? context?.pressureTokens;
  const percentage = Number.isFinite(used) && context?.contextWindow > 0 ? Math.min(100, Math.max(0, Math.round(used / context.contextWindow * 100))) : null;
  const statText = stats ? [
    `${stats.turns} 轮 · ${stats.steps} 步`,
    ...(stats.steps > 0 ? [`LLM ${seconds(stats.llmMs)}`, ...(stats.toolMs > 0 ? [`工具 ${seconds(stats.toolMs)}`] : []), ...(stats.ttftSteps > 0 ? [`首 token ${seconds(stats.ttftMs / stats.ttftSteps)}`] : []), ...(stats.decodeMs > 0 ? [`${Math.round(stats.decodeTokens / (stats.decodeMs / 1000))} tok/s`] : []), ...(hitRate !== undefined ? [`缓存 ${hitRate}%`] : []), ...(inputTokens !== undefined ? [`输入 ${tokenCount(inputTokens)} tok`] : [])] : ['尚未开始']),
  ].join('  ·  ') : '等待运行信息';
  const [input, submit] = React.Children.toArray(children);

  async function perform(action) {
    if (pendingOperation.current !== null) return;
    const ticket = identity.current;
    pendingOperation.current = ticket;
    setBusy(true); setError('');
    try { await action(ticket); if (isCurrent(ticket)) setMenu(null); }
    catch (failure) { if (isCurrent(ticket)) setError(failure?.message || '操作未完成，请重试'); }
    finally { if (isCurrent(ticket)) { pendingOperation.current = null; setBusy(false); } }
  }
  function toggleMenu(next) {
    setError(''); setAcknowledged(false); setMenu(current => current === next ? null : next);
    const ticket = identity.current;
    if (next === 'model') void runtime.current?.loadModels().catch(failure => { if (isCurrent(ticket)) setError(failure?.message || '模型列表暂不可用'); });
  }
  function choosePermission(value) {
    if (value === permissions?.currentValue) { setMenu(null); return; }
    if (value === 'danger-full-access') { setAcknowledged(false); setMenu('full-access'); return; }
    const binding = runtime.current;
    void perform(() => binding.selectPermission(value));
  }
  async function attach(ticket) {
    if (attachmentKind === 'file') {
      const file = await api.call('files/read', { mainSessionId, path: path.trim() });
      if (!isCurrent(ticket)) return;
      const accepted = await onPacket({ kind: 'file', source: file.path, sourceHash: file.sha256, text: file.text, startLine: 1, endLine: file.text.split('\n').length });
      if (!isCurrent(ticket)) return;
      if (!accepted) throw new Error('未能加入引用，请重试');
      if (file.truncated) setError('已加入已读取的部分，文件内容有截断。');
      setPath('');
    } else {
      const accepted = await onPacket({ kind: 'message', source: '手动引用', text: quote.trim() });
      if (!isCurrent(ticket)) return;
      if (!accepted) throw new Error('未能加入引用，请重试');
      setQuote('');
    }
  }
  const popover = menu && <div ref={popup} className={`dsh-sc-composer-popover is-${menu}`} style={popupLayout || { visibility: 'hidden' }} role="dialog" aria-label={{ context: '侧聊上下文用量', stats: '侧聊运行详情', model: '侧聊模型设置', permissions: '侧聊访问模式', attach: '添加侧聊上下文', 'full-access': '确认侧聊完全权限' }[menu]}>
      <div className="dsh-sc-composer-popover-heading"><strong>{{ context: '上下文', stats: '运行统计', model: '模型', permissions: '访问模式', attach: '添加上下文', 'full-access': '启用完全权限？' }[menu]}</strong><button aria-label="关闭底栏菜单" onClick={() => setMenu(null)}><Glyph name="close"/></button></div>
      {menu === 'permissions' && <div role="menu" aria-label="侧聊权限选项">{permissions?.options?.filter(item => item.value !== 'custom').map(item => <button type="button" role="menuitemradio" key={item.value} aria-checked={item.value === permissions.currentValue} disabled={busy} onClick={() => choosePermission(item.value)}><span><b>{item.name}</b>{item.description && <small>{item.description}</small>}</span>{item.value === permissions.currentValue && <Glyph name="check"/>}</button>)}</div>}
      {menu === 'full-access' && <div className="dsh-sc-permission-confirm"><p>完全权限允许此侧聊在工作区外读写文件和运行命令。仅在你信任当前任务时启用。</p><label><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)}/><span>我了解风险，确认启用</span></label><div><button type="button" className="dsh-sc-small-button" disabled={busy} onClick={() => { setAcknowledged(false); setMenu(null); }}>取消</button><button type="button" className="dsh-sc-small-button" disabled={!acknowledged || busy} onClick={() => { if (!acknowledged) return; const binding = runtime.current; void perform(() => binding.selectPermission('danger-full-access')); }}>启用完全权限</button></div></div>}
      {menu === 'model' && <>
        <div className="dsh-sc-model-choices" role="menu" aria-label="侧聊模型选项">{models.map(item => <button type="button" role="menuitemradio" key={`${item.provider}/${item.model}`} aria-checked={item.provider === selection?.provider && item.model === selection?.model} disabled={busy} onClick={() => perform(() => runtime.current.selectModel({ provider: item.provider, model: item.model, ...(item.defaultEffort ? { reasoningEffort: item.defaultEffort } : {}) }))}><span><b>{item.label}</b><small>{item.provider}</small></span>{item.provider === selection?.provider && item.model === selection?.model && <Glyph name="check"/>}</button>)}</div>
        {!models.length && <p className="dsh-sc-composer-hint">{snapshot?.models?.phase === 'loading' ? '读取模型列表…' : '暂无可用模型'}</p>}
        {model?.reasoningEfforts?.length > 0 && <div className="dsh-sc-effort-options"><span>推理等级</span><div>{model.reasoningEfforts.map(item => <button type="button" key={item.id} aria-pressed={item.id === selection?.reasoningEffort} title={item.description || item.name} disabled={busy} onClick={() => perform(() => runtime.current.selectModel({ provider: model.provider, model: model.model, reasoningEffort: item.id }))}>{item.name}</button>)}</div></div>}
        <p className="dsh-sc-composer-hint">更改也作为之后新建会话的默认模型。</p>
      </>}
      {(menu === 'stats' || menu === 'context') && <dl className="dsh-sc-usage-details">
        {menu === 'context' ? <><dt>当前占用</dt><dd>{percentage === null ? '尚未采样' : `${percentage}% · 约 ${tokenCount(used)} tok`}</dd><dt>上下文窗口</dt><dd>{tokenCount(context?.contextWindow)} tok</dd></> : <><dt>轮次 / 步数</dt><dd>{stats ? `${stats.turns} / ${stats.steps}` : '—'}</dd><dt>LLM 用时</dt><dd>{seconds(stats?.llmMs)}</dd><dt>工具用时</dt><dd>{seconds(stats?.toolMs)}</dd><dt>首 token 平均</dt><dd>{stats?.ttftSteps > 0 ? seconds(stats.ttftMs / stats.ttftSteps) : '—'}</dd><dt>生成速度</dt><dd>{stats?.decodeMs > 0 ? `${Math.round(stats.decodeTokens / (stats.decodeMs / 1000))} tok/s` : '—'}</dd></>}
        <dt>累计输入</dt><dd>{tokenCount(inputTokens)} tok</dd><dt>累计输出</dt><dd>{tokenCount(usage?.outputTokens)} tok</dd><dt>缓存命中</dt><dd>{hitRate !== undefined ? `${hitRate}%` : '—'}</dd>
      </dl>}
      {menu === 'attach' && <div className="dsh-sc-context-entry"><div className="dsh-sc-context-kinds"><button type="button" aria-pressed={attachmentKind === 'file'} onClick={() => setAttachmentKind('file')}>工作区文件</button><button type="button" aria-pressed={attachmentKind === 'text'} onClick={() => setAttachmentKind('text')}>引用文字</button></div>{attachmentKind === 'file' ? <input aria-label="引用文件路径" value={path} onChange={event => setPath(event.target.value)} placeholder="例如 src/main.py"/> : <textarea aria-label="引用文字内容" value={quote} onChange={event => setQuote(event.target.value)} rows={4} placeholder="粘贴作为上下文的内容"/>}<button className="dsh-sc-small-button" disabled={busy || !(attachmentKind === 'file' ? path.trim() : quote.trim())} onClick={() => perform(attach)}>加入引用</button></div>}
    </div>;
  return <div className="dsh-sc-composer-frame" ref={root}>
    {error && <div className="dsh-sc-composer-error" role="status"><span>{error}</span><button aria-label="关闭设置提示" onClick={() => setError('')}><Glyph name="close" size={12}/></button></div>}
    {portalHost && popover ? createPortal(popover, portalHost) : null}
    <div className="dsh-sc-composer">
      {input}
      <div className="dsh-sc-runtime-toolbar">
        <button type="button" className="dsh-sc-runtime-add" aria-label="添加侧聊上下文" title="添加上下文" aria-expanded={menu === 'attach'} disabled={!sessionId || busy} onClick={() => toggleMenu('attach')}><Glyph name="plus" size={18}/></button>
        <button type="button" className="dsh-sc-runtime-permission" aria-label={`侧聊访问模式，当前：${permission?.name || '读取中'}`} title={permission?.description || '当前侧聊的访问模式'} disabled={!permissions?.options?.length || busy} aria-expanded={menu === 'permissions'} onClick={() => toggleMenu('permissions')}><Glyph name="shield"/><span>{permission?.name || '权限'}</span><Glyph name="chevron" size={11}/></button>
        <button type="button" className="dsh-sc-runtime-model" aria-label={`侧聊模型，当前：${modelName}${effortName ? `，${effortName}` : ''}`} title={`${modelName}${effortName ? ` · ${effortName}` : ''}`} disabled={!runtime.current || busy} aria-expanded={menu === 'model'} onClick={() => toggleMenu('model')}><b>{modelName}</b>{effortName && <span>{effortName}</span>}<Glyph name="chevron" size={11}/></button>
        <button type="button" className="dsh-sc-context-meter" aria-label={percentage === null ? '侧聊上下文尚未采样' : `侧聊上下文已用 ${percentage}%`} title={percentage === null ? '上下文尚未采样' : `上下文已用 ${percentage}%`} aria-expanded={menu === 'context'} onClick={() => toggleMenu('context')}><svg width="19" height="19" viewBox="0 0 20 20" aria-hidden="true"><circle className="dsh-sc-context-track" cx="10" cy="10" r="6.5"/><circle className="dsh-sc-context-fill" cx="10" cy="10" r="6.5" pathLength="100" strokeDasharray={`${percentage ?? 0} 100`} transform="rotate(-90 10 10)"/></svg></button>
        {submit}
      </div>
    </div>
    <button type="button" className="dsh-sc-runtime-stats" aria-label="查看侧聊运行统计" title={statText} aria-expanded={menu === 'stats'} onClick={() => toggleMenu('stats')}>{statText}</button>
  </div>;
}
