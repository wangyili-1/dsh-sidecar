import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Panel from './WorkspacePanel.jsx';
import { attachDockLayout } from './dock-layout.mjs';
import { createRuntimeControls } from './runtime-controls.mjs';
import './toolbar.css';

export const inject = ['slots', 'layout', 'connection', 'sessions', 'workspaces', 'uiWorkspace', 'modelDirectories', 'remote', 'remote.session'];
function Toolbar({ state, onToggle }) {
  return <div className="dsh-sc-toolbar" role="group" aria-label="Sidecar 插件工具">
    <button className="dsh-sc-toolbar-button" type="button" aria-label={state.visible ? '关闭 Sidecar 侧栏' : '打开 Sidecar 侧栏'} title={state.visible ? '关闭侧栏' : '打开侧栏'} aria-pressed={state.visible} onClick={() => void onToggle()}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 6h10M4 12h8M18 12h2M4 18h3M13 18h7"/><circle cx="6" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></svg>
    </button>
  </div>;
}
function HeaderToolbar({ useSidecarState, onToggle }) {
  const state = useSidecarState(value => value);
  if (state.visible || state.blank) return null;
  return <Toolbar state={state} onToggle={onToggle}/>;
}
function ResizeHandle({ dock, visible }) {
  const [snapshot, setSnapshot] = useState({ panelWidth: 420, minWidth: 320, maxWidth: 960, ready: false, resizing: false });
  const handle = useRef(null);
  const pointer = useRef(null);
  const releasePointer = (cancelled, clientX) => {
    const active = pointer.current;
    if (!active) return;
    pointer.current = null;
    active.binding.endResize(active.id, clientX, cancelled);
    try { if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id); } catch { /* Removed or lost capture. */ }
  };
  useEffect(() => {
    // Parent layout effects attach the adapter before this passive subscription.
    const binding = dock.current;
    if (!binding) return undefined;
    const refresh = () => setSnapshot(binding.getSnapshot());
    const unsubscribe = binding.subscribe(refresh);
    refresh();
    const view = handle.current?.ownerDocument?.defaultView;
    const blur = () => releasePointer(true);
    view?.addEventListener('blur', blur);
    return () => { releasePointer(true); unsubscribe(); view?.removeEventListener('blur', blur); };
  }, [dock]);
  useEffect(() => { if (!visible) releasePointer(true); }, [visible]);
  return <div ref={handle} className={`dsh-sc-resize-handle${snapshot.resizing ? ' is-dragging' : ''}`} role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" aria-valuemin={Math.round(snapshot.minWidth)} aria-valuemax={Math.round(snapshot.maxWidth)} aria-valuenow={Math.round(snapshot.panelWidth)} aria-valuetext={`${Math.round(snapshot.panelWidth)} 像素`} aria-disabled={!snapshot.ready || snapshot.maxWidth <= snapshot.minWidth} tabIndex={visible && snapshot.ready ? 0 : -1} title="拖动调整侧栏宽度；方向键微调，双击恢复默认" onPointerDown={event => {
    if (!visible || event.button !== 0 || event.isPrimary === false || pointer.current) return;
    const binding = dock.current;
    const element = event.currentTarget;
    if (!binding?.startResize(event.pointerId, event.clientX, element.parentElement.getBoundingClientRect().width)) return;
    event.preventDefault();
    pointer.current = { id: event.pointerId, element, binding };
    try { element.setPointerCapture(event.pointerId); element.focus({ preventScroll: true }); }
    catch { releasePointer(true); }
  }} onPointerMove={event => { if (pointer.current?.id === event.pointerId) pointer.current.binding.moveResize(event.pointerId, event.clientX); }} onPointerUp={event => { if (pointer.current?.id === event.pointerId) releasePointer(false, event.clientX); }} onPointerCancel={event => { if (pointer.current?.id === event.pointerId) releasePointer(true); }} onLostPointerCapture={event => { if (pointer.current?.id === event.pointerId) releasePointer(true); }} onDoubleClick={() => dock.current?.resetWidth()} onKeyDown={event => {
    if (event.key === 'Escape' && pointer.current) { event.preventDefault(); releasePointer(true); return; }
    if (dock.current?.resizeByKey(event.key, event.shiftKey)) event.preventDefault();
  }}><span/></div>;
}
function Overlay({ api, useSidecarState, onToggle }) {
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
    {(state.visible || state.blank) && <div className="dsh-sc-floating-toolbar"><Toolbar state={state} onToggle={onToggle}/></div>}
    <div className="dsh-sc-global-panel" data-open={state.visible ? 'true' : 'false'} aria-hidden={!state.visible} inert={state.visible ? undefined : ''}>
      {state.error && <div className="dsh-sc-launcher-notice" role="status">{state.error}</div>}
      {state.opened && (state.mainSessionId ? <Panel key={state.mainSessionId} api={api} mainSessionId={state.mainSessionId} toolIntent={state.toolIntent}/> : <aside className="dsh-sc-launcher-empty" aria-label="Sidecar 右栏"><strong>{state.busy ? '连接中…' : '选择工作区'}</strong></aside>)}
      <ResizeHandle dock={dock} visible={state.visible}/>
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
