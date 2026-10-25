import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Panel from './WorkspacePanel.jsx';
import { attachDockLayout } from './dock-layout.mjs';
import { createRuntimeControls } from './runtime-controls.mjs';
import './toolbar.css';

export const inject = ['slots', 'layout', 'connection', 'sessions', 'workspaces', 'uiWorkspace', 'modelDirectories', 'remote', 'remote.session'];
const TOOLS = [
  { id: 'browser', label: '网页' },
  { id: 'chat', label: '侧聊' },
];
function ToolbarIcon({ name }) {
  const paths = {
    more: <><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/></>,
    controls: <><path d="M10 6h10M4 12h8M18 12h2M4 18h3M13 18h7"/><circle cx="6" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></>,
    new: <><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/></>,
    files: <><path d="M3 6h6l2 2h10v12H3z"/><path d="M3 6V4h6l2 2h8v2"/></>,
    terminal: <path d="m5 6 5 5-5 5M13 17h6"/>,
    browser: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18"/></>,
    chat: <path d="M4 4h16v12H9l-5 4z"/>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function Toolbar({ state, onToggle, onTool }) {
  const [menu, setMenu] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  useEffect(() => {
    if (!menu) return undefined;
    const owner = root.current?.ownerDocument;
    const outside = event => { if (!root.current?.contains(event.target)) setMenu(false); };
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); setMenu(false); trigger.current?.focus();
    };
    owner?.addEventListener('pointerdown', outside);
    owner?.addEventListener('keydown', escape);
    return () => { owner?.removeEventListener('pointerdown', outside); owner?.removeEventListener('keydown', escape); };
  }, [menu]);
  const focusItem = index => {
    const items = root.current?.querySelectorAll('[role="menuitem"]');
    if (items?.length) items[(index + items.length) % items.length].focus();
  };
  const choose = (tool, action) => { setMenu(false); void onTool(tool, action); };
  return <div ref={root} className="dsh-sc-toolbar" role="group" aria-label="Sidecar 插件工具">
    <button ref={trigger} className="dsh-sc-toolbar-button" type="button" aria-label="Sidecar 功能菜单" title="功能菜单" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(value => !value)} onKeyDown={event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setMenu(true); queueMicrotask(() => focusItem(0)); }
    }}><ToolbarIcon name="more"/></button>
    <button className="dsh-sc-toolbar-button" type="button" aria-label={state.visible ? '关闭 Sidecar 侧栏' : '打开 Sidecar 侧栏'} title={state.visible ? '关闭侧栏' : '打开侧栏'} aria-pressed={state.visible} onClick={() => { setMenu(false); void onToggle(); }}><ToolbarIcon name="controls"/></button>
    {menu && <div className="dsh-sc-toolbar-menu" role="menu" aria-label="Sidecar 功能" onKeyDown={event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const items = Array.from(root.current.querySelectorAll('[role="menuitem"]'));
      focusItem(items.indexOf(event.target) + (event.key === 'ArrowDown' ? 1 : -1));
    }}>{TOOLS.map(tool => <button key={tool.id} type="button" role="menuitem" disabled={state.busy} onClick={() => choose(tool.id)}><ToolbarIcon name={tool.id}/><span>{tool.label}</span></button>)}</div>}
  </div>;
}
function HeaderToolbar({ useSidecarState, onToggle, onTool }) {
  const state = useSidecarState(value => value);
  if (state.visible || state.blank) return null;
  return <Toolbar state={state} onToggle={onToggle} onTool={onTool}/>;
}
function Overlay({ api, useSidecarState, onToggle, onTool, onClose }) {
  const state = useSidecarState(value => value);
  const root = useRef(null);
  const dock = useRef(null);
  useLayoutEffect(() => {
    const binding = attachDockLayout(root.current);
    dock.current = binding;
    binding.update({ visible: state.visible });
    return () => { binding.dispose(); dock.current = null; };
  }, []);
  useLayoutEffect(() => { dock.current?.update({ visible: state.visible }); }, [state.visible]);
  return <div ref={root} className="dsh-sc-shell-overlay">
    {(state.visible || state.blank) && <div className="dsh-sc-floating-toolbar"><Toolbar state={state} onToggle={onToggle} onTool={onTool}/></div>}
    <div className="dsh-sc-global-panel" data-open={state.visible ? 'true' : 'false'} aria-hidden={!state.visible} inert={state.visible ? undefined : ''}>
      {state.error && <div className="dsh-sc-launcher-notice" role="status">{state.error}</div>}
      {state.opened && (state.mainSessionId ? <Panel key={state.mainSessionId} api={api} mainSessionId={state.mainSessionId} toolIntent={state.toolIntent}/> : <aside className="dsh-sc-launcher-empty" aria-label="Sidecar 右栏"><strong>{state.busy ? '连接中…' : '选择工作区'}</strong></aside>)}
    </div>
  </div>;
}
function DetailsSpacer() {
  return <div className="dsh-sc-details-spacer" aria-hidden="true"/>;
}
/** Match DSH's public navigation policy without choosing a filesystem path. */
export function recentWorkspace(items, sessions) {
  let selected;
  let selectedTime = Number.NEGATIVE_INFINITY;
  for (const workspace of items) {
    let latest = Number.NEGATIVE_INFINITY;
    for (const id of workspace.sessionIds || []) if (sessions[id]) latest = Math.max(latest, sessions[id].updatedAt || 0);
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt) || 0;
    if (selected === undefined || latest > selectedTime) { selected = workspace.workspaceId; selectedTime = latest; }
  }
  return selected;
}
/** Additive shell entry keeps the panel mounted when a blank session becomes a conversation. */
export function apply(ctx) {
  let releaseDetails;
  let disposed = false;
  let request = 0;
  let sequence = 0;
  let pendingSelection;
  const listeners = new Set();
  const initial = ctx.sessions.list.getSnapshot();
  let state = {
    mainSessionId: initial.current,
    blank: initial.current === undefined || initial.byId[initial.current]?.blank !== false,
    visible: false, opened: false, busy: false, error: '', toolIntent: undefined,
  };
  const source = {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const publish = changes => {
    if (disposed) return;
    state = { ...state, ...changes };
    for (const listener of listeners) listener();
  };
  const api = Object.freeze({
    runtime: createRuntimeControls(ctx),
    async call(endpoint, payload = {}, signal) {
      const result = await ctx.connection.rpc.call('/sidecar-api', endpoint, payload, signal);
      if (!result.ok) {
        const error = new Error(result.error?.message || 'Sidecar request failed');
        error.code = result.error?.code; error.details = result.error?.details;
        throw error;
      }
      return result.value;
    },
  });
  const syncDetails = () => {
    const needsColumn = state.visible && !state.blank;
    if (needsColumn && releaseDetails === undefined) {
      releaseDetails = ctx.slots.inject('details', () => ctx.slots.register({
        name: 'details', priority: -100,
      }, DetailsSpacer));
      ctx.layout.openDetails();
    } else if (!needsColumn && releaseDetails !== undefined) {
      const dispose = releaseDetails; releaseDetails = undefined; dispose();
    }
  };
  const close = () => {
    request++;
    publish({ visible: false, busy: false, error: '', toolIntent: undefined });
    const hadColumn = releaseDetails !== undefined;
    syncDetails();
    if (hadColumn) ctx.layout.closeDetails();
  };
  const syncSelection = () => {
    if (disposed) return;
    const sessions = ctx.sessions.list.getSnapshot();
    const current = sessions.current;
    const blank = current === undefined || sessions.byId[current]?.blank !== false;
    if (current !== state.mainSessionId) {
      const ownSelection = pendingSelection === current && current !== undefined;
      if (!ownSelection) request++;
      publish({ mainSessionId: current, blank, toolIntent: undefined, error: '',
        ...(!ownSelection ? { visible: false, busy: false } : {}),
      });
      syncDetails();
    } else if (blank !== state.blank) { publish({ blank }); syncDetails(); }
  };
  const unsubscribeSessions = ctx.sessions.list.subscribe(syncSelection);
  const onTool = async (tool = 'browser', action) => {
    if (disposed || state.busy) return;
    const ticket = ++request;
    publish({ visible: true, opened: true, error: '', busy: true });
    try {
      let current = ctx.sessions.list.getSnapshot().current;
      if (current === undefined) {
        const workspaces = ctx.workspaces.list.getSnapshot();
        const sessions = ctx.sessions.list.getSnapshot();
        if (workspaces.phase !== 'ready' || sessions.phase !== 'ready') throw new Error('工作区正在加载，请稍后重试。');
        const workspaceId = recentWorkspace(workspaces.items, sessions.byId);
        if (workspaceId === undefined) throw new Error('尚未添加工作区。请在左侧添加项目文件夹，再打开 Sidecar。');
        const created = await ctx.uiWorkspace.connectWorkspace(workspaceId);
        if (disposed || ticket !== request || ctx.sessions.list.getSnapshot().current !== undefined) return;
        pendingSelection = created;
        // Reconcile immediately too: DSH may batch store listener notifications.
        try { ctx.sessions.open(created); syncSelection(); } finally { pendingSelection = undefined; }
        current = ctx.sessions.list.getSnapshot().current;
        if (current !== created) throw new Error('未能打开工作区会话，请在左侧选择会话后重试。');
      }
      if (disposed || ticket !== request) return;
      const sessions = ctx.sessions.list.getSnapshot();
      publish({ mainSessionId: current, blank: sessions.byId[current]?.blank !== false,
        toolIntent: { sequence: ++sequence, tool, ...(action ? { action } : {}) }, busy: false,
      });
      syncDetails();
    } catch (error) {
      if (!disposed && ticket === request) publish({ error: error?.message || '无法打开 Sidecar，请重试。' });
    } finally { if (!disposed && ticket === request && state.busy) publish({ busy: false }); }
  };
  const onToggle = () => state.visible ? close() : onTool('browser');
  const injectToolbar = () => ({ onToggle, onTool, hooks: { sidecarState: source } });
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'dsh-sidecar-overlay', order: 100,
    inject: () => ({ ...injectToolbar(), api, onClose: close }),
  }, Overlay));
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'dsh-sidecar-toolbar', order: 10000,
    inject: injectToolbar,
  }, HeaderToolbar));
  ctx.effect(() => () => {
    request++; disposed = true; unsubscribeSessions(); releaseDetails?.(); releaseDetails = undefined; listeners.clear();
  }, 'dsh-sidecar: client cleanup');
}
