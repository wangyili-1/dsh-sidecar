import React, { useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from 'react';
import Surface from './Panel.jsx';
import { createWorkspaceState, workspaceTabsReducer, groupForTab, openTabIds } from './workspace-tabs.mjs';
import './workspace.css';

const POLL_MS = 1500;
const LABELS = { files: '文件', terminal: '终端', browser: '网页', chat: '侧聊' };

function createInitialWorkspace() {
  const initial = createWorkspaceState();
  return {
    ...initial,
    tabs: [{ id: 'web-start', kind: 'browser', title: '新标签页' }],
    groups: { ...initial.groups, top: ['web-start'] },
    active: { ...initial.active, top: 'web-start' },
  };
}

function Icon({ kind, size = 15 }) {
  const paths = {
    files: <><path d="M3 6h6l2 2h10v12H3z"/><path d="M3 6V4h6l2 2h8v2"/></>,
    terminal: <path d="m5 6 5 5-5 5M13 17h6"/>,
    browser: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18"/></>,
    chat: <path d="M4 4h16v12H9l-5 4z"/>,
    plus: <path d="M12 5v14M5 12h14"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    split: <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18"/></>,
    merge: <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 9 4 4 4-4"/></>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind] || paths.browser}</svg>;
}

/** Drop geometry stays independent from pointer capture and React lifecycles. */
export function workspaceDropTarget({ x, y, bounds, bars = [], split, splitterY, total }) {
  if (!bounds || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
  for (const bar of bars) {
    if (x < bar.left || x > bar.right || y < bar.top || y > bar.bottom) continue;
    const index = (bar.tabs || []).findIndex(tab => x < (tab.left + tab.right) / 2);
    return { to: bar.group, index: index === -1 ? (bar.tabs || []).length : index, zone: 'bar' };
  }
  const boundary = split ? splitterY : bounds.top + (bounds.bottom - bounds.top) / 2;
  const to = y > boundary && total > 1 ? 'bottom' : 'top';
  return { to, zone: 'pane' };
}

export default function WorkspacePanel(props) {
  if (!props.mainSessionId) return <aside className="dsh-sidecar dsh-ws"><header className="dsh-sc-heading"><span>Sidecar</span></header><div className="dsh-ws-empty">先在左侧选择工作区。</div></aside>;
  return <WorkspaceSession key={String(props.mainSessionId)} {...props}/>;
}

function WorkspaceSession({ api, mainSessionId, onClose, toolIntent }) {
  const [workspace, dispatch] = useReducer(workspaceTabsReducer, undefined, createInitialWorkspace);
  const current = useRef(workspace);
  current.current = workspace;
  const transport = useRef(api);
  transport.current = api;
  const alive = useRef(true);
  const [remote, setRemote] = useState(null);
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const pendingCreate = useRef(null);
  const sequence = useRef(1);
  const handledIntent = useRef(null);
  const lastChat = useRef(null);
  const [packetLists, setPacketLists] = useState({});
  const [menu, setMenu] = useState(null);
  const [drag, setDrag] = useState(null);
  const [resizing, setResizing] = useState(false);
  const root = useRef(null);
  const grid = useRef(null);
  const splitter = useRef(null);
  const menuRoot = useRef(null);
  const dragRef = useRef(null);
  const resizeRef = useRef(false);
  const suppressClick = useRef(false);
  const prefix = useId();
  const split = workspace.groups.bottom.length > 0;
  const getTab = useCallback(id => current.current.tabs.find(tab => tab.id === id), []);
  const createPacketId = useCallback(() => `packet-${sequence.current++}`, []);
  const revealActiveTabs = useCallback(() => {
    if (!root.current) return;
    const buttons = Array.from(root.current.querySelectorAll('[data-ws-tab-id]'));
    for (const group of ['top', 'bottom']) {
      const active = current.current.active[group];
      const button = buttons.find(item => item.getAttribute('data-ws-tab-id') === active);
      const scroller = button?.closest('.dsh-ws-tab-scroll');
      if (!scroller) continue;
      const tabBounds = button.parentElement.getBoundingClientRect();
      const scrollBounds = scroller.getBoundingClientRect();
      if (tabBounds.left < scrollBounds.left) scroller.scrollLeft += tabBounds.left - scrollBounds.left;
      else if (tabBounds.right > scrollBounds.right) scroller.scrollLeft += tabBounds.right - scrollBounds.right;
    }
  }, []);
  useLayoutEffect(() => {
    const observerType = root.current?.ownerDocument?.defaultView?.ResizeObserver;
    if (!observerType) return undefined;
    const observer = new observerType(revealActiveTabs);
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [revealActiveTabs]);
  useLayoutEffect(revealActiveTabs, [revealActiveTabs, workspace.active.top, workspace.active.bottom, workspace.groups.top, workspace.groups.bottom, workspace.tabs]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await transport.current.call('state', { mainSessionId });
        if (disposed) return;
        setRemote(value);
        setError('');
        for (const side of value.sidechats || []) dispatch({ type: 'title', id: `chat-${side.id}`, title: side.title || '侧聊' });
      } catch (failure) { if (!disposed) setError(failure?.message || '连接暂不可用，请稍后重试。'); }
      finally { pending = false; }
    };
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { disposed = true; clearInterval(timer); };
  }, [mainSessionId]);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const tab = getTab(workspace.active[workspace.focused]);
    if (tab?.kind === 'chat') lastChat.current = tab.id;
  }, [getTab, workspace.active.top, workspace.active.bottom, workspace.focused]);
  useEffect(() => {
    if (!menu) return undefined;
    const owner = root.current?.ownerDocument;
    const outside = event => { if (!menuRoot.current?.contains(event.target)) setMenu(null); };
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); setMenu(null); } };
    owner?.addEventListener('pointerdown', outside);
    owner?.addEventListener('keydown', escape);
    return () => { owner?.removeEventListener('pointerdown', outside); owner?.removeEventListener('keydown', escape); };
  }, [menu]);

  const open = useCallback((tab, group) => {
    dispatch({ type: 'open', tab, group });
    if (tab.kind === 'chat') lastChat.current = tab.id;
    setMenu(null);
    return tab;
  }, []);
  const openChat = useCallback((side, group) => open({ id: `chat-${side.id}`, kind: 'chat', sessionId: side.id, title: side.title || '侧聊' }, group), [open]);
  const newChat = useCallback((group, includeContext = false) => {
    if (pendingCreate.current) return pendingCreate.current;
    setCreating(true);
    setError('');
    const task = (async () => {
      try {
        const side = await transport.current.call('sidechat/create', { mainSessionId, includeContext });
        if (!alive.current) return null;
        setRemote(value => value ? { ...value, sidechats: [...(value.sidechats || []).filter(item => item.id !== side.id), side] } : { sidechats: [side] });
        return openChat(side, group);
      } catch (failure) { if (alive.current) setError(failure?.message || '未能创建侧聊。'); return null; }
      finally { pendingCreate.current = null; if (alive.current) setCreating(false); }
    })();
    pendingCreate.current = task;
    return task;
  }, [mainSessionId, openChat]);
  const openTool = useCallback((kind, group, forceNew = false) => {
    if (kind === 'files' || kind === 'terminal') return open({ id: kind, kind, title: LABELS[kind] }, group);
    const snapshot = current.current;
    if (!forceNew) {
      const focused = snapshot.tabs.find(tab => tab.id === snapshot.active[snapshot.focused] && tab.kind === kind);
      const existing = focused || snapshot.tabs.find(tab => tab.kind === kind && groupForTab(snapshot, tab.id));
      if (existing) return open(existing, group);
    }
    const ordinal = sequence.current++;
    return open({ id: `web-${ordinal}`, kind: 'browser', title: `网页 ${ordinal}` }, group);
  }, [open]);
  const continueChat = useCallback((group) => {
    const snapshot = current.current;
    const known = getTab(lastChat.current) || snapshot.tabs.find(tab => tab.kind === 'chat' && groupForTab(snapshot, tab.id));
    if (known) return open(known, group);
    const first = remoteRef.current?.sidechats?.[0];
    if (first) return openChat(first, group);
    setMenu(group || snapshot.focused);
    setNotice('点击“新建侧聊”开始一段独立讨论。');
    return null;
  }, [getTab, open, openChat]);
  useEffect(() => {
    if (!Number.isFinite(toolIntent?.sequence) || handledIntent.current === toolIntent.sequence) return undefined;
    if (toolIntent.tool === 'chat' && toolIntent.action !== 'new-sidechat' && remote === null) return undefined;
    let disposed = false;
    queueMicrotask(() => {
      if (disposed || !alive.current || handledIntent.current === toolIntent.sequence) return;
      handledIntent.current = toolIntent.sequence;
      if (toolIntent.action === 'new-sidechat') void newChat(current.current.focused);
      else if (toolIntent.tool === 'chat') continueChat();
      else if (['files', 'terminal', 'browser'].includes(toolIntent.tool)) openTool(toolIntent.tool);
    });
    return () => { disposed = true; };
  }, [toolIntent?.sequence, toolIntent?.tool, toolIntent?.action, remote, newChat, continueChat, openTool]);

  const updatePackets = useCallback((id, updater) => setPacketLists(value => ({ ...value, [id]: typeof updater === 'function' ? updater(value[id] || []) : updater })), []);
  const sendPacket = useCallback(async packet => {
    const snapshot = current.current;
    const active = getTab(snapshot.active[snapshot.focused]);
    let target = active?.kind === 'chat' ? active : getTab(lastChat.current);
    if (!target) {
      const first = remoteRef.current?.sidechats?.[0];
      target = first ? openChat(first, snapshot.focused) : await newChat(snapshot.focused);
    } else open(target, groupForTab(snapshot, target.id) || snapshot.focused);
    if (!target) throw new Error('未能准备侧聊，引用内容仍保留，请重试。');
    if (!alive.current) return;
    updatePackets(target.id, value => [...value, { ...packet, _id: createPacketId() }]);
    setNotice(`已加入「${target.title}」的上下文包，发送前可以审阅。`);
  }, [createPacketId, getTab, newChat, open, openChat, updatePackets]);

  const activate = id => { if (!suppressClick.current) dispatch({ type: 'activate', id }); };
  const splitActive = group => {
    const snapshot = current.current;
    const id = snapshot.active[group];
    if (id && openTabIds(snapshot).length > 1) dispatch({ type: 'move', id, to: group === 'top' ? 'bottom' : 'top' });
    setMenu(null);
  };
  const targetAt = (x, y) => {
    const element = grid.current;
    if (!element) return null;
    const bounds = element.getBoundingClientRect();
    const bars = Array.from(element.querySelectorAll('[data-ws-tabbar]')).map(bar => ({
      ...pickRect(bar.getBoundingClientRect()), group: bar.getAttribute('data-ws-tabbar'),
      tabs: Array.from(bar.querySelectorAll('[data-ws-tab-item]')).map(tab => pickRect(tab.getBoundingClientRect())),
    }));
    return workspaceDropTarget({ x, y, bounds, bars, split, splitterY: splitter.current?.getBoundingClientRect().top ?? bounds.top + bounds.height / 2, total: openTabIds(current.current).length });
  };
  const startTabDrag = (event, id) => {
    if (event.button !== 0) return;
    dragRef.current = { id, x: event.clientX, y: event.clientY, started: false, element: event.currentTarget, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveTabDrag = event => {
    const pending = dragRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    if (!pending.started && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < 6) return;
    pending.started = true;
    event.preventDefault();
    pending.target = targetAt(event.clientX, event.clientY);
    setDrag({ id: pending.id, target: pending.target });
  };
  const finishTabDrag = (event, cancelled = false) => {
    const pending = dragRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (pending.element.hasPointerCapture(event.pointerId)) pending.element.releasePointerCapture(event.pointerId);
    if (pending.started) {
      suppressClick.current = true;
      setTimeout(() => { suppressClick.current = false; }, 0);
      if (!cancelled && pending.target) dispatch({ type: 'move', id: pending.id, to: pending.target.to, index: pending.target.index });
    }
    setDrag(null);
  };
  const resizeTo = clientY => {
    const bounds = grid.current?.getBoundingClientRect();
    if (bounds?.height) dispatch({ type: 'resize', percent: (clientY - bounds.top) * 100 / bounds.height });
  };
  const tabKey = (event, group, id) => {
    const ids = workspace.groups[group];
    let index = ids.indexOf(id);
    if (event.key === 'ArrowLeft') index = (index - 1 + ids.length) % ids.length;
    else if (event.key === 'ArrowRight') index = (index + 1) % ids.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = ids.length - 1;
    else if (event.key === 'Delete') { event.preventDefault(); dispatch({ type: 'close', id }); return; }
    else return;
    event.preventDefault();
    dispatch({ type: 'activate', id: ids[index] });
    Array.from(root.current?.querySelectorAll('[data-ws-tab-id]') || []).find(item => item.getAttribute('data-ws-tab-id') === ids[index])?.focus();
  };
  const titleChanged = (id, title) => { if (title) dispatch({ type: 'title', id, title }); };
  const tabbar = group => <div className="dsh-ws-tabbar" data-ws-tabbar={group} style={{ gridRow: group === 'top' ? 1 : 4, gridColumn: 1 }}>
    <div className="dsh-ws-tab-scroll" role="tablist" aria-label={group === 'top' ? '顶部标签' : '底部标签'}>
      {workspace.groups[group].map((id, index) => {
        const tab = workspace.tabs.find(item => item.id === id);
        const selected = workspace.active[group] === id;
        const before = drag?.target?.zone === 'bar' && drag.target.to === group && drag.target.index === index;
        return <div key={id} className={`dsh-ws-tab${selected ? ' is-active' : ''}${before ? ' drop-before' : ''}${drag?.id === id ? ' is-dragged' : ''}`} data-ws-tab-item={id}>
          <button type="button" role="tab" id={`${prefix}-tab-${id}`} data-ws-tab-id={id} aria-controls={`${prefix}-surface-${id}`} aria-selected={selected} tabIndex={selected ? 0 : -1} title={`${tab.title} · 拖动排序或放到下方分屏`} onClick={() => activate(id)} onKeyDown={event => tabKey(event, group, id)} onPointerDown={event => startTabDrag(event, id)} onPointerMove={moveTabDrag} onPointerUp={event => finishTabDrag(event)} onPointerCancel={event => finishTabDrag(event, true)}><Icon kind={tab.kind}/><span>{tab.title}</span></button>
          <button type="button" className="dsh-ws-tab-close" aria-label={`关闭标签 ${tab.title}`} title="关闭标签（保留会话）" onClick={() => dispatch({ type: 'close', id })}><Icon kind="close" size={11}/></button>
        </div>;
      })}
      {drag?.target?.zone === 'bar' && drag.target.to === group && drag.target.index === workspace.groups[group].length && <span className="dsh-ws-drop-end"/>}
      {!workspace.groups[group].length && <span className="dsh-ws-no-tabs">暂无标签</span>}
    </div>
    <div className="dsh-ws-tab-tools" ref={menu === group ? menuRoot : undefined}>
      <button type="button" className="dsh-ws-icon-button" aria-label={group === 'top' ? '新建顶部标签' : '新建底部标签'} title="新建标签" aria-haspopup="menu" aria-expanded={menu === group} onClick={() => setMenu(value => value === group ? null : group)}><Icon kind="plus"/></button>
      {group === 'top' && <button type="button" className="dsh-ws-icon-button" aria-label={split ? '合并上下分屏' : '上下分屏'} title={split ? '合并为一个标签组' : '将当前标签移到下方'} disabled={!split && openTabIds(workspace).length < 2} onClick={() => split ? dispatch({ type: 'merge' }) : splitActive(group)}><Icon kind={split ? 'merge' : 'split'}/></button>}
      {menu === group && <div className="dsh-ws-menu" role="menu" aria-label="添加标签">
        <button type="button" role="menuitem" onClick={() => openTool('browser', group, true)}><Icon kind="browser"/>新建网页</button>
        <button type="button" role="menuitem" disabled={creating} onClick={() => { setMenu(null); void newChat(group); }}><Icon kind="chat"/>{creating ? '创建中…' : '新建侧聊'}</button>
        <button type="button" role="menuitem" aria-label="新建侧聊（带主任务上下文）" disabled={creating} onClick={() => { setMenu(null); void newChat(group, true); }}><Icon kind="chat"/>新建上下文侧聊</button>
        {(remote?.sidechats?.length > 0) && <><div className="dsh-ws-menu-label">继续侧聊</div>{remote.sidechats.map(side => <button key={side.id} type="button" role="menuitem" onClick={() => openChat(side, group)}><Icon kind="chat"/><span>{side.title || '侧聊'}</span></button>)}</>}
        {workspace.tabs.some(tab => !groupForTab(workspace, tab.id)) && <><div className="dsh-ws-menu-label">已关闭</div>{workspace.tabs.filter(tab => !groupForTab(workspace, tab.id)).slice(-5).reverse().map(tab => <button key={tab.id} type="button" role="menuitem" aria-label={`恢复标签 ${tab.title}`} onClick={() => open(tab, group)}><Icon kind={tab.kind}/><span>{tab.title}</span></button>)}</>}
        <div className="dsh-ws-menu-label">布局</div>
        <button type="button" role="menuitem" disabled={!workspace.active[group] || openTabIds(workspace).length < 2} onClick={() => splitActive(group)}><Icon kind="split"/>{group === 'top' ? '移到下方' : '移到上方'}</button>
        {split && <button type="button" role="menuitem" onClick={() => { dispatch({ type: 'merge' }); setMenu(null); }}><Icon kind="merge"/>合并分屏</button>}
      </div>}
    </div>
  </div>;

  return <aside ref={root} className={`dsh-sidecar dsh-ws${drag ? ' is-tab-dragging' : ''}${resizing ? ' is-pane-resizing' : ''}`} aria-label="Sidecar 标签工作区">
    <div ref={grid} className="dsh-ws-grid" data-split={split ? 'true' : 'false'} style={{ gridTemplateRows: split ? `52px minmax(0, ${workspace.split}fr) 8px 38px minmax(0, ${100 - workspace.split}fr)` : '52px minmax(0, 1fr)' }}>
      {tabbar('top')}
      {split && tabbar('bottom')}
      {split && <div ref={splitter} className="dsh-ws-splitter" style={{ gridRow: 3, gridColumn: 1 }} role="separator" aria-label="调整上下分屏高度" aria-orientation="horizontal" aria-valuemin={25} aria-valuemax={75} aria-valuenow={workspace.split} tabIndex={0} onKeyDown={event => {
        const delta = event.key === 'ArrowUp' ? -5 : event.key === 'ArrowDown' ? 5 : 0;
        if (delta) { event.preventDefault(); dispatch({ type: 'resize', percent: workspace.split + delta }); }
      }} onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); resizeRef.current = true; setResizing(true); }} onPointerMove={event => { if (resizeRef.current) resizeTo(event.clientY); }} onPointerUp={event => { if (!resizeRef.current) return; resizeTo(event.clientY); resizeRef.current = false; setResizing(false); event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { resizeRef.current = false; setResizing(false); }}><span/></div>}
      {workspace.tabs.map(tab => {
        const group = groupForTab(workspace, tab.id);
        const active = Boolean(group && workspace.active[group] === tab.id);
        return <div key={tab.id} id={`${prefix}-surface-${tab.id}`} className="dsh-ws-surface" role="tabpanel" aria-labelledby={`${prefix}-tab-${tab.id}`} hidden={!active} data-ws-pane-content={group || 'closed'} style={{ gridRow: group === 'bottom' ? 5 : 2, gridColumn: 1 }} onFocusCapture={() => { if (active) dispatch({ type: 'activate', id: tab.id }); }}>
          <Surface api={api} mainSessionId={mainSessionId} surface={tab.kind} fixedSidechat={tab.kind === 'chat' ? { id: tab.sessionId, title: tab.title } : undefined} onPacket={tab.kind === 'chat' ? undefined : sendPacket} packets={tab.kind === 'chat' ? packetLists[tab.id] || [] : undefined} onPacketsChange={tab.kind === 'chat' ? updater => updatePackets(tab.id, updater) : undefined} createPacketId={createPacketId} onTitle={title => titleChanged(tab.id, title)}/>
        </div>;
      })}
      {!workspace.groups.top.length && <div className="dsh-ws-empty" style={{ gridRow: 2, gridColumn: 1 }}><button type="button" className="dsh-sc-small-button" onClick={() => setMenu('top')}><Icon kind="plus"/>添加标签</button></div>}
      {drag?.target?.zone === 'pane' && <div className={`dsh-ws-drop-preview is-${drag.target.to}`} aria-hidden="true"><span>{drag.target.to === 'bottom' ? '放到下方分屏' : split ? '移到上方分屏' : '放到顶部标签组'}</span></div>}
    </div>
    {(error || notice) && <div className={`dsh-ws-notice${error ? ' is-error' : ''}`} role="status"><span>{error || notice}</span><button type="button" aria-label="关闭提示" onClick={() => { setError(''); setNotice(''); }}><Icon kind="close" size={12}/></button></div>}
    <span className="dsh-ws-screen-reader" aria-live="polite">{drag ? '拖动标签：放入标签栏可排序，放到下方可分屏。' : ''}</span>
  </aside>;
}

function pickRect(rect) { return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; }
