import React, { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { parsePropertyLabSummary } from './propertylab-summary.mjs';
import { terminalSessionStore } from './terminal-session-store.mjs';
import { previewUserMessage } from './message-preview.mjs';
import './panel.css';

const STALE = Symbol('stale-sidecar-request');
const POLL_MS = 1500;

function Icon({ name, size = 16, ...props }) {
  const paths = {
    files: <><path d="M3 6h6l2 2h10v12H3z"/><path d="M3 6V4h6l2 2h8v2"/></>,
    file: <><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4M9 12h6M9 16h6"/></>,
    terminal: <><path d="m5 6 5 5-5 5M13 17h6"/></>,
    browser: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18"/></>,
    chat: <path d="M4 4h16v12H9l-5 4z"/>,
    plus: <path d="M12 5v14M5 12h14"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    arrow: <path d="m5 12 14 0m-5-5 5 5-5 5"/>,
    up: <path d="M12 20V4m-6 6 6-6 6 6"/>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2"/></>,
    link: <><path d="m9 15 6-6M7 14l-2 2a4 4 0 0 0 6 5l3-3M10 6l3-3a4 4 0 0 1 6 5l-2 2"/></>,
    send: <><path d="m3 3 19 9-19 9 4-9zM7 12h15"/></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
    external: <><path d="M14 3h7v7M21 3l-11 11M10 4H4v16h16v-6"/></>,
    chevron: <path d="m9 5 7 7-7 7"/>,
    check: <path d="m4 12 5 5L20 6"/>,
    packet: <><path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name] || paths.file}</svg>;
}

function errorText(error) {
  return error?.message || String(error || '操作未完成，请重试。');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function byteLabel(size) {
  if (!Number.isFinite(size)) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function httpUrl(value) {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('请输入完整的 HTTP 或 HTTPS 地址。');
  return parsed.href;
}

function readLocalSelection(element, withLines = false) {
  const selection = element?.ownerDocument?.defaultView?.getSelection();
  if (!selection || !selection.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const result = { text };
  if (withLines) {
    const lineOf = (node) => Number((node.nodeType === 1 ? node : node.parentElement)?.closest('[data-line]')?.dataset.line);
    result.startLine = lineOf(range.startContainer) || 1;
    result.endLine = lineOf(range.endContainer) || result.startLine;
  }
  return result;
}

function wirePacket(packet) {
  const { _id, ...payload } = packet;
  return payload;
}

function EmptyState({ icon, title, children, compact = false }) {
  return <div className={`dsh-sc-empty${compact ? ' is-compact' : ''}`}><span className="dsh-sc-empty-icon"><Icon name={icon} size={23}/></span><strong>{title}</strong><p>{children}</p></div>;
}

function MessageBody({ message, expanded, onToggle, generating }) {
  const preview = message.role === 'user' ? previewUserMessage(message.text) : { text: message.text, truncated: false };
  const collapsed = preview.truncated && !expanded;
  return <><div className="dsh-sc-message-text">{collapsed ? `${preview.text}\n…` : message.text || (generating ? '正在生成…' : '')}</div>{preview.truncated && <button className="dsh-sc-message-expand" aria-expanded={expanded} onClick={onToggle}>{expanded ? '收起内容' : '展开完整内容'}<Icon name="chevron" size={11} className={expanded ? 'is-rotated' : ''}/></button>}</>;
}

function PropertyLabSummary({ text }) {
  const report = useMemo(() => parsePropertyLabSummary(text), [text]);
  if (!report) return null;
  return <details className="dsh-sc-property" open><summary><span className="dsh-sc-eyebrow">PROPERTYLAB</span><span>文件中的结果</span></summary><div className="dsh-sc-property-body"><div className="dsh-sc-property-stats"><span>状态 <b>{report.statusText}</b></span><span>Evaluations <b>{report.evaluationsText}</b></span></div><span className="dsh-sc-small-label">最小反例</span><pre>{report.hasCounterexample === false ? '未确认反例（请结合运行状态）。' : report.hasCounterexampleValue ? report.counterexampleRaw : '文件未提供最小反例。'}</pre><details><summary>查看 evaluations</summary><pre>{report.evaluationsRaw}</pre><p>评估次数可能包含生成与收缩，不等于不同输入数。</p></details></div></details>;
}

export default function Panel({ api, mainSessionId, onClose }) {
  if (!mainSessionId) {
    return <aside className="dsh-sidecar" aria-label="Sidecar 右栏"><PanelHeading onClose={onClose}/><EmptyState icon="chat" title="先选择一个主会话">在 DSH 中选择需要协作的主会话。文件、命令与侧聊会关联到该会话的工作区。</EmptyState></aside>;
  }
  return <PanelSession key={String(mainSessionId)} api={api} mainSessionId={mainSessionId} onClose={onClose}/>;
}

function PanelHeading({ onClose }) {
  return <header className="dsh-sc-heading"><div className="dsh-sc-brand"><span className="dsh-sc-brand-mark"><i/><i/><i/></span><span>Sidecar<small>工作台 · 独立侧聊</small></span></div>{onClose && <button className="dsh-sc-icon-button" aria-label="关闭 Sidecar" title="关闭右栏" onClick={onClose}><Icon name="close"/></button>}</header>;
}

function PanelSession({ api, mainSessionId, onClose }) {
  const identity = useRef(1);
  const alive = useRef(true);
  const apiRef = useRef(api);
  apiRef.current = api;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; identity.current += 1; };
  }, []);
  const call = useCallback(async (endpoint, payload = {}) => {
    const ticket = identity.current;
    try {
      const result = await apiRef.current.call(endpoint, { ...payload, mainSessionId });
      if (!alive.current || identity.current !== ticket) throw STALE;
      return result;
    } catch (error) {
      if (!alive.current || identity.current !== ticket) throw STALE;
      throw error;
    }
  }, [mainSessionId]);

  const [state, setState] = useState(null);
  const [connectionError, setConnectionError] = useState('');
  const [notice, setNotice] = useState(null);
  const notify = useCallback((text, type = 'success') => setNotice({ text, type }), []);
  const fail = useCallback((error) => { if (error !== STALE && alive.current) notify(errorText(error), 'error'); }, [notify]);
  useEffect(() => {
    if (!notice || notice.type === 'error') return undefined;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const [tab, setTab] = useState('files');
  const [split, setSplit] = useState(48);
  const splitRoot = useRef(null);
  const dragging = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const changeSplit = (clientY) => {
    const bounds = splitRoot.current?.getBoundingClientRect();
    if (bounds?.height) setSplit(Math.min(73, Math.max(25, ((clientY - bounds.top) / bounds.height) * 100)));
  };

  const [sideId, setSideId] = useState('');
  const activeSide = useRef(sideId);
  activeSide.current = sideId;
  const [sideTitle, setSideTitle] = useState('');
  const [includeContext, setIncludeContext] = useState(false);
  const [creating, setCreating] = useState(false);
  const [conversation, setConversation] = useState(null);
  const [conversationError, setConversationError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [showRuntimeContext, setShowRuntimeContext] = useState(false);
  const [expandedMessages, setExpandedMessages] = useState(new Set());
  const [packets, setPackets] = useState([]);
  const [packetsOpen, setPacketsOpen] = useState(false);
  const nextPacketId = useRef(1);
  const messageScroll = useRef(null);
  const followMessages = useRef(true);

  useEffect(() => {
    let disposed = false;
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await call('state');
        if (disposed) return;
        setState(value);
        setConnectionError('');
        if (!activeSide.current && value.sidechats?.length) {
          setSideId(value.sidechats[0].id);
          setSideTitle(value.sidechats[0].title || '独立侧聊');
        }
      } catch (error) { if (!disposed && error !== STALE) setConnectionError(errorText(error)); }
      finally { pending = false; }
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { disposed = true; clearInterval(timer); };
  }, [call]);

  useEffect(() => {
    setConversation(null);
    setConversationError('');
    setDraft('');
    setSelected(new Set());
    setShowRuntimeContext(false);
    setExpandedMessages(new Set());
    followMessages.current = true;
    if (!sideId) return undefined;
    let disposed = false;
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await call('conversation/get', { sessionId: sideId });
        if (disposed) return;
        setConversation(value);
        setSideTitle(value.title || '独立侧聊');
        setConversationError(value.error || '');
      } catch (error) { if (!disposed && error !== STALE) setConversationError(errorText(error)); }
      finally { pending = false; }
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { disposed = true; clearInterval(timer); };
  }, [call, sideId]);

  useEffect(() => {
    if (followMessages.current && messageScroll.current) messageScroll.current.scrollTop = messageScroll.current.scrollHeight;
  }, [conversation?.messages]);

  const addPacket = (packet) => {
    setPackets((current) => [...current, { ...packet, _id: nextPacketId.current++ }]);
    setPacketsOpen(true);
    notify('已加入上下文包，可在发送前审阅或移除。');
  };

  const createSidechat = async () => {
    setCreating(true);
    try {
      const result = await call('sidechat/create', { includeContext });
      setSideId(result.id);
      setSideTitle(result.title || '独立侧聊');
      setState((current) => current ? { ...current, sidechats: [...(current.sidechats || []).filter((item) => item.id !== result.id), result] } : current);
      notify(includeContext ? '已创建侧聊，并带入主任务上下文。' : '已创建独立侧聊。');
    } catch (error) { fail(error); }
    finally { if (alive.current) setCreating(false); }
  };

  const sendSidechat = async () => {
    if (!sideId || !draft.trim() || sending || conversation?.running) return;
    const targetId = sideId;
    const sentDraft = draft;
    const sentPackets = packets;
    setSending(targetId);
    try {
      await call('conversation/send', { sessionId: targetId, text: sentDraft.trim(), packets: sentPackets.map(wirePacket) });
      if (activeSide.current === targetId) {
        setDraft((current) => current === sentDraft ? '' : current);
        setConversation((current) => current ? { ...current, running: true } : current);
        followMessages.current = true;
      }
      const sentIds = new Set(sentPackets.map((packet) => packet._id));
      setPackets((current) => current.filter((packet) => !sentIds.has(packet._id)));
      notify('已发送至侧聊。');
    } catch (error) { fail(error); }
    finally { if (alive.current) setSending(''); }
  };

  const cancelSidechat = async () => {
    if (!sideId) return;
    setCancelling(true);
    try { await call('conversation/cancel', { sessionId: sideId }); notify('已请求停止侧聊。'); }
    catch (error) { fail(error); }
    finally { if (alive.current) setCancelling(false); }
  };

  const [directory, setDirectory] = useState({ path: '.', entries: [] });
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [file, setFile] = useState(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState('');
  const [fileSelection, setFileSelection] = useState(null);
  const [fileListOpen, setFileListOpen] = useState(true);
  const fileSource = useRef(null);
  const directoryRequest = useRef(0);
  const fileRequest = useRef(0);

  const loadDirectory = useCallback(async (path = '.') => {
    const request = ++directoryRequest.current;
    setDirectoryLoading(true);
    setDirectoryError('');
    try {
      const value = await call('files/list', { path });
      if (directoryRequest.current === request) setDirectory(value);
    } catch (error) { if (error !== STALE && directoryRequest.current === request) setDirectoryError(errorText(error)); }
    finally { if (alive.current && directoryRequest.current === request) setDirectoryLoading(false); }
  }, [call]);
  useEffect(() => { loadDirectory('.'); }, [loadDirectory]);

  const openFile = async (path) => {
    if (!path.trim()) return;
    const request = ++fileRequest.current;
    setFileLoading(true);
    setFileError('');
    setFileSelection(null);
    setPathInput(path);
    try {
      const value = await call('files/read', { path });
      if (fileRequest.current !== request) return;
      setFile(value);
      setPathInput(value.path);
      setFileListOpen(false);
    } catch (error) { if (error !== STALE && fileRequest.current === request) setFileError(errorText(error)); }
    finally { if (alive.current && fileRequest.current === request) setFileLoading(false); }
  };

  const [command, setCommand] = useState('');
  const terminalSession = useSyncExternalStore(
    useCallback((listener) => terminalSessionStore.subscribe(mainSessionId, listener), [mainSessionId]),
    useCallback(() => terminalSessionStore.getSnapshot(mainSessionId), [mainSessionId]),
    useCallback(() => terminalSessionStore.getSnapshot(mainSessionId), [mainSessionId]),
  );
  const terminalId = terminalSession.id;
  const terminalStarting = terminalSession.starting;
  const [terminal, setTerminal] = useState(null);
  const terminalRestoring = Boolean(terminalId && terminal?.id !== terminalId);
  const [terminalCancelling, setTerminalCancelling] = useState(false);
  const [terminalError, setTerminalError] = useState('');
  const [terminalSelection, setTerminalSelection] = useState(null);
  const terminalOutput = useRef(null);
  const terminalScroll = useRef(null);
  const followTerminal = useRef(true);

  useEffect(() => {
    if (!terminalId) return undefined;
    let disposed = false;
    let pending = false;
    let complete = false;
    const poll = async () => {
      if (pending || complete) return;
      pending = true;
      try {
        const result = await call('terminal/get', { id: terminalId });
        if (disposed) return;
        setTerminal(result);
        setCommand((current) => current || result.command || '');
        setTerminalError('');
        complete = !result.running;
      } catch (error) {
        if (!disposed && error !== STALE) {
          if (error.code === 'job-not-found') {
            terminalSessionStore.forget(mainSessionId, terminalId);
            setTerminal(null);
            setTerminalSelection(null);
            setTerminalError('上次命令记录已不可用（服务可能已重启），可以重新运行命令。');
          } else setTerminalError(errorText(error));
        }
      }
      finally { pending = false; }
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { disposed = true; clearInterval(timer); };
  }, [call, mainSessionId, terminalId]);
  useEffect(() => {
    if (followTerminal.current && terminalScroll.current) terminalScroll.current.scrollTop = terminalScroll.current.scrollHeight;
  }, [terminal?.output]);

  const runCommand = async () => {
    if (!command.trim() || terminalStarting || terminalRestoring || terminal?.running) return;
    const ticket = identity.current;
    const transport = apiRef.current;
    const submittedCommand = command.trim();
    setTerminalError('');
    setTerminalSelection(null);
    followTerminal.current = true;
    try {
      // Remember the returned handle even if this component closes while the
      // request is pending; only the original owning main session is notified.
      const result = await terminalSessionStore.start(mainSessionId, () => transport.call('terminal/run', { mainSessionId, command: submittedCommand }));
      if (!alive.current || identity.current !== ticket) return;
      setTerminal({ id: result.id, command: submittedCommand, output: '', running: true });
    } catch (error) { if (alive.current && identity.current === ticket && error !== STALE) setTerminalError(errorText(error)); }
  };
  const cancelTerminal = async () => {
    setTerminalCancelling(true);
    try { await call('terminal/cancel', { id: terminalId }); notify('已请求停止命令。'); }
    catch (error) { fail(error); }
    finally { if (alive.current) setTerminalCancelling(false); }
  };

  const [urlInput, setUrlInput] = useState('');
  const [browserUrl, setBrowserUrl] = useState('');
  const [browserVersion, setBrowserVersion] = useState(0);
  const [browserError, setBrowserError] = useState('');
  const [quoteUrl, setQuoteUrl] = useState('');
  const [quoteText, setQuoteText] = useState('');
  const navigateBrowser = () => {
    try {
      const url = httpUrl(urlInput);
      setBrowserUrl(url);
      setQuoteUrl(url);
      setBrowserVersion((value) => value + 1);
      setBrowserError('');
    } catch { setBrowserError('请输入完整的 HTTP(S) 地址，例如 http://localhost:3000。'); }
  };
  const addWebQuote = () => {
    if (!quoteText.trim()) return;
    try {
      const url = httpUrl(quoteUrl);
      addPacket({ kind: 'web', source: url, url, text: quoteText.trim() });
      setQuoteText('');
      setBrowserError('');
    } catch { setBrowserError('请为引用片段填写有效的 HTTP(S) 来源地址。'); }
  };

  const [returnOpen, setReturnOpen] = useState(false);
  const [returnText, setReturnText] = useState('');
  const [returnPackets, setReturnPackets] = useState([]);
  const [returnIncludeContext, setReturnIncludeContext] = useState(false);
  const [returnSending, setReturnSending] = useState(false);
  const [returnError, setReturnError] = useState('');
  const dialogRef = useRef(null);
  const dialogTitleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (returnOpen && !dialog.open) dialog.showModal();
    if (!returnOpen && dialog.open) dialog.close();
  }, [returnOpen]);
  const prepareReturn = (messages) => {
    if (!messages.length) return;
    setReturnText(`来自侧聊「${conversation?.title || sideTitle || '独立侧聊'}」的补充：\n\n${messages.map((message) => message.text).join('\n\n——\n\n')}`);
    setReturnPackets(packets.slice());
    setReturnIncludeContext(false);
    setReturnError('');
    setReturnOpen(true);
  };
  const sendToMain = async () => {
    if (!returnText.trim() || returnSending) return;
    setReturnSending(true);
    setReturnError('');
    try {
      await call('main/send', { text: returnText.trim(), packets: returnIncludeContext ? returnPackets.map(wirePacket) : [], mode: 'queue' });
      setReturnOpen(false);
      setSelected(new Set());
      notify('补充已排队送回主任务。');
    } catch (error) { if (error !== STALE) setReturnError(errorText(error)); }
    finally { if (alive.current) setReturnSending(false); }
  };

  const messages = conversation?.messages || [];
  const runtimeContextCount = messages.filter((message) => message.role === 'system').length;
  const visibleMessages = showRuntimeContext ? messages : messages.filter((message) => message.role !== 'system');
  const selectedMessages = messages.filter((message) => selected.has(message.id));
  const sidechats = state?.sidechats || [];
  const selectedMissing = sideId && !sidechats.some((item) => item.id === sideId);
  const mainTitle = state?.main?.title || '当前主会话';
  const sortedEntries = [...(directory.entries || [])].sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
  const tabId = useId();

  return <aside className={`dsh-sidecar${isDragging ? ' is-resizing' : ''}`} aria-label="Sidecar 右栏">
    <PanelHeading onClose={onClose}/>
    <div className="dsh-sc-main-context"><span className={`dsh-sc-status-dot${state?.main?.running ? ' is-running' : ''}`}/><span className="dsh-sc-eyebrow">主任务</span><strong title={mainTitle}>{mainTitle}</strong><span className="dsh-sc-status-label">{connectionError ? '连接异常' : !state ? '连接中' : state.main?.running ? '运行中' : '就绪'}</span></div>
    {connectionError && <div className="dsh-sc-inline-error" role="status">{connectionError}<small>正在自动重试连接。</small></div>}
    {notice && <div className={`dsh-sc-notice is-${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}><Icon name={notice.type === 'error' ? 'close' : 'check'}/><span>{notice.text}</span><button className="dsh-sc-icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}><Icon name="close" size={13}/></button></div>}
    <div className="dsh-sc-split-root" ref={splitRoot}>
      <section className="dsh-sc-workbench" style={{ flexBasis: `${split}%` }} aria-label="工作台">
        <div className="dsh-sc-tabs" role="tablist" aria-label="工作台工具">{[['files', 'files', '文件'], ['terminal', 'terminal', '终端'], ['browser', 'browser', '浏览器']].map(([key, icon, label], index, all) => <button key={key} id={`${tabId}-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`${tabId}-panel-${key}`} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const next = all[(index + (event.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length][0]; setTab(next); event.currentTarget.parentElement.querySelector(`[id="${tabId}-tab-${next}"]`)?.focus(); } }}><Icon name={icon}/>{label}{key === 'terminal' && terminal?.running && <span className="dsh-sc-live-dot"/>}</button>)}<span className="dsh-sc-workbench-label">WORKSPACE</span></div>
        <div role="tabpanel" id={`${tabId}-panel-files`} aria-labelledby={`${tabId}-tab-files`} hidden={tab !== 'files'} className="dsh-sc-tool dsh-sc-file-tool">
          <form className="dsh-sc-address" onSubmit={(event) => { event.preventDefault(); openFile(pathInput); }}><button type="button" className={`dsh-sc-icon-button${fileListOpen ? ' is-active' : ''}`} title="浏览文件目录" aria-label="浏览文件目录" aria-pressed={fileListOpen} onClick={() => setFileListOpen((value) => !value)}><Icon name="files"/></button><input aria-label="文件路径" value={pathInput} onChange={(event) => setPathInput(event.target.value)} placeholder="输入工作区内的文件路径" spellCheck={false}/><button type="submit" className="dsh-sc-icon-button" aria-label="读取文件" title="读取文件" disabled={!pathInput.trim() || fileLoading}><Icon name={fileLoading ? 'refresh' : 'arrow'} className={fileLoading ? 'is-spinning' : ''}/></button></form>
          {fileListOpen && <div className="dsh-sc-directory"><div className="dsh-sc-directory-heading"><button className="dsh-sc-icon-button" aria-label="上一级目录" disabled={directory.path === '.' || directory.path === '' || directoryLoading} onClick={() => { const normalized = directory.path.replace(/\\/g, '/').replace(/\/$/, ''); loadDirectory(normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) || '.' : '.'); }}><Icon name="up" size={13}/></button><span title={directory.path}>{directory.path || '.'}</span><button className="dsh-sc-icon-button" aria-label="刷新文件目录" disabled={directoryLoading} onClick={() => loadDirectory(directory.path || '.')}><Icon name="refresh" size={13} className={directoryLoading ? 'is-spinning' : ''}/></button></div>{directoryError ? <div className="dsh-sc-inline-error" role="alert">{directoryError}</div> : <div className="dsh-sc-file-list">{sortedEntries.map((entry) => <button key={entry.path} className={`dsh-sc-file-entry${file?.path === entry.path ? ' is-current' : ''}`} onClick={() => entry.type === 'directory' ? loadDirectory(entry.path) : openFile(entry.path)} title={entry.path}><Icon name={entry.type === 'directory' ? 'files' : 'file'} size={14}/><span>{entry.name}</span><small>{entry.type === 'directory' ? <Icon name="chevron" size={12}/> : byteLabel(entry.size)}</small></button>)}{!sortedEntries.length && <p className="dsh-sc-help">{directoryLoading ? '读取目录…' : '这个目录中还没有文件。'}</p>}</div>}</div>}
          {fileError && <div className="dsh-sc-inline-error" role="alert">{fileError}</div>}
          {file ? <><div className="dsh-sc-file-meta"><span title={file.path}>{file.path}</span><span>{file.text.split('\n').length} 行{file.truncated ? ' · 已截断' : ''}</span></div><div className="dsh-sc-file-content"><PropertyLabSummary text={file.text}/><div ref={fileSource} className="dsh-sc-source" aria-label="文件内容" tabIndex={0} onMouseUp={() => setFileSelection(readLocalSelection(fileSource.current, true))} onKeyUp={() => setFileSelection(readLocalSelection(fileSource.current, true))}>{file.text.split('\n').map((line, index) => <div className="dsh-sc-source-line" data-line={index + 1} key={index}><span className="dsh-sc-line-number" aria-hidden="true">{index + 1}</span><span className="dsh-sc-line-text">{line}{'\n'}</span></div>)}</div></div><div className="dsh-sc-source-actions"><span>{fileSelection ? `已选 L${fileSelection.startLine}–${fileSelection.endLine}` : '选中文字，加入侧聊上下文'}</span><button className="dsh-sc-small-button" disabled={!fileSelection || fileLoading} onClick={() => addPacket({ kind: 'file', source: file.path, sourceHash: file.sha256, ...fileSelection })}><Icon name="plus" size={12}/>引用选区</button><button className="dsh-sc-text-button" disabled={fileLoading || !file.text} title={file.truncated ? '只引用当前已读取的内容' : '引用当前文件全部内容'} onClick={() => addPacket({ kind: 'file', source: file.path, sourceHash: file.sha256, text: file.text, startLine: 1, endLine: file.text.split('\n').length })}>全文</button></div>{file.truncated && <div className="dsh-sc-footnote">此文件仅显示已读取的部分，引用全文也仅包含该部分。</div>}</> : <EmptyState icon="files" title={fileLoading ? '正在读取文件' : '把文件变成可追溯的上下文'} compact>打开文件后选择文字，即可连同路径与行号一起引用。</EmptyState>}
        </div>
        <div role="tabpanel" id={`${tabId}-panel-terminal`} aria-labelledby={`${tabId}-tab-terminal`} hidden={tab !== 'terminal'} className="dsh-sc-tool dsh-sc-terminal-tool">
          <div className="dsh-sc-command-box"><label className="dsh-sc-small-label" htmlFor={`${tabId}-command`}>手动命令台 <span>独立执行 · 非 PTY</span></label><textarea id={`${tabId}-command`} value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); runCommand(); } }} spellCheck={false} rows={2} placeholder="输入要在当前工作区运行的命令"/><div className="dsh-sc-command-actions"><span title={terminal?.cwd || state?.workspace || ''}>{terminal?.cwd || state?.workspace || '当前主会话的工作区'}</span>{terminal?.running ? <button className="dsh-sc-small-button is-danger" onClick={cancelTerminal} disabled={terminalCancelling}><Icon name="stop" size={12}/>{terminalCancelling ? '停止中' : '停止命令'}</button> : <button className="dsh-sc-small-button is-accent" onClick={runCommand} disabled={!command.trim() || terminalStarting || terminalRestoring}><Icon name="terminal" size={13}/>{terminalStarting ? '启动中' : terminalRestoring ? '恢复中' : '执行命令'}</button>}</div></div>
          {terminalError && <div className="dsh-sc-inline-error" role="alert">{terminalError}</div>}
          {terminal?.truncated && <div className="dsh-sc-terminal-warning" role="status"><strong>输出已截断</strong><span>已达到输出保留上限，后续内容未保留。引用仅包含当前可见的部分。</span></div>}
          {terminal ? <><div className="dsh-sc-terminal-meta"><span title={terminal.command}>$ {terminal.command}</span><span className={terminal.running ? 'dsh-sc-cyan' : terminal.exitCode ? 'dsh-sc-error-text' : ''}>{terminal.running ? '运行中' : `退出 ${terminal.exitCode ?? '—'}`}</span></div><div className="dsh-sc-terminal-scroll" ref={terminalScroll} onScroll={(event) => { const el = event.currentTarget; followTerminal.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}><pre ref={terminalOutput} className="dsh-sc-terminal-output" aria-label="命令输出" tabIndex={0} onMouseUp={() => setTerminalSelection(readLocalSelection(terminalOutput.current))} onKeyUp={() => setTerminalSelection(readLocalSelection(terminalOutput.current))}>{terminal.output || (terminal.running ? '等待命令输出…' : '命令没有产生输出。')}</pre></div><div className="dsh-sc-source-actions"><span>{terminalSelection ? '已选中输出片段' : '输出可选中引用'}</span><button className="dsh-sc-small-button" disabled={!terminalSelection || !terminal.output} onClick={() => addPacket({ kind: 'terminal', source: terminal.command, text: terminalSelection.text })}><Icon name="plus" size={12}/>引用选区</button><button className="dsh-sc-text-button" disabled={!terminal.output} onClick={() => addPacket({ kind: 'terminal', source: terminal.command, text: terminal.output })}>{terminal.truncated ? '已保留输出' : '全部'}</button></div></> : <EmptyState icon="terminal" title={terminalRestoring ? '正在恢复上次命令' : '让执行结果参与讨论'} compact>手动运行命令，输出持续更新。交互式程序请使用主应用终端。</EmptyState>}
        </div>
        <div role="tabpanel" id={`${tabId}-panel-browser`} aria-labelledby={`${tabId}-tab-browser`} hidden={tab !== 'browser'} className="dsh-sc-tool dsh-sc-browser-tool">
          <form className="dsh-sc-address" onSubmit={(event) => { event.preventDefault(); navigateBrowser(); }}><Icon name="browser" size={15}/><input aria-label="浏览器网址" value={urlInput} onChange={(event) => setUrlInput(event.target.value)} placeholder="https://… 或 http://localhost:3000" spellCheck={false}/><button className="dsh-sc-icon-button" aria-label="打开网址" title="打开网址" disabled={!urlInput.trim()}><Icon name="arrow"/></button>{browserUrl && <a className="dsh-sc-icon-button" href={browserUrl} target="_blank" rel="noopener noreferrer" aria-label="在外部打开网页" title="在外部打开网页"><Icon name="external" size={14}/></a>}</form>
          {browserError && <div className="dsh-sc-inline-error" role="alert">{browserError}</div>}
          {browserUrl ? <div className="dsh-sc-browser-frame"><iframe key={`${browserUrl}-${browserVersion}`} title="Sidecar 网页预览" src={browserUrl} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer"/><div className="dsh-sc-footnote">沙箱网页预览。若网站拒绝嵌入，请使用外部打开。</div></div> : <EmptyState icon="browser" title="在右栏查看页面" compact>输入网页或本地开发地址。网页片段由你明确选择并粘贴引用。</EmptyState>}
          <details className="dsh-sc-web-quote"><summary><Icon name="link" size={13}/><span>引用网页片段</span><span className="dsh-sc-muted">手动提供</span></summary><div><input aria-label="网页引用来源地址" value={quoteUrl} onChange={(event) => setQuoteUrl(event.target.value)} placeholder="来源 URL（HTTP / HTTPS）" spellCheck={false}/><textarea aria-label="网页引用片段" rows={3} value={quoteText} onChange={(event) => setQuoteText(event.target.value)} placeholder="粘贴需要引用的文字。右栏不会自动读取网页内容。"/><button className="dsh-sc-small-button" disabled={!quoteText.trim() || !quoteUrl.trim()} onClick={addWebQuote}><Icon name="plus" size={12}/>加入上下文包</button></div></details>
        </div>
      </section>
      <div className="dsh-sc-splitter" role="separator" aria-label="调整工作台与侧聊高度" aria-orientation="horizontal" aria-valuemin={25} aria-valuemax={73} aria-valuenow={Math.round(split)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setSplit((value) => Math.max(25, Math.min(73, value + (event.key === 'ArrowDown' ? 3 : -3)))); } }} onPointerDown={(event) => { dragging.current = true; setIsDragging(true); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (dragging.current) changeSplit(event.clientY); }} onPointerUp={() => { dragging.current = false; setIsDragging(false); }} onPointerCancel={() => { dragging.current = false; setIsDragging(false); }}><span/></div>
      <section className="dsh-sc-sidechat" aria-label="独立侧聊">
        <div className="dsh-sc-chat-heading"><div><Icon name="chat"/><strong>Sidechat</strong><span className="dsh-sc-tag">独立会话</span></div><button className="dsh-sc-small-button" onClick={createSidechat} disabled={creating} aria-label="新建侧聊"><Icon name="plus" size={13}/>{creating ? '创建中' : '新建'}</button></div>
        <div className="dsh-sc-chat-session"><select aria-label="选择侧聊会话" value={sideId} onChange={(event) => { setSideId(event.target.value); setSideTitle(sidechats.find((item) => item.id === event.target.value)?.title || '独立侧聊'); }} disabled={!sidechats.length && !sideId}><option value="" disabled>创建或选择独立侧聊</option>{sidechats.map((item) => <option value={item.id} key={item.id}>{item.title || '独立侧聊'}{item.running ? ' · 运行中' : ''}</option>)}{selectedMissing && <option value={sideId}>{sideTitle || '独立侧聊'}</option>}</select><label className="dsh-sc-context-option" title="仅影响下一次新建侧聊；由服务端复制主任务上下文。"><input type="checkbox" checked={includeContext} onChange={(event) => setIncludeContext(event.target.checked)}/>新建时带入主任务上下文</label></div>
        {conversationError && <div className="dsh-sc-inline-error" role="alert">{conversationError}</div>}
        {runtimeContextCount > 0 && <button className="dsh-sc-runtime-toggle" aria-expanded={showRuntimeContext} onClick={() => setShowRuntimeContext((value) => !value)}><Icon name="chevron" size={12} className={showRuntimeContext ? 'is-rotated' : ''}/>{showRuntimeContext ? '隐藏' : '显示'} {runtimeContextCount} 条运行上下文</button>}
        {selectedMessages.length > 0 && <div className="dsh-sc-selection-bar"><span>已选 {selectedMessages.length} 条消息</span><button className="dsh-sc-text-button" onClick={() => setSelected(new Set())}>清除</button><button className="dsh-sc-small-button is-accent" onClick={() => prepareReturn(selectedMessages)}><Icon name="up" size={12}/>送回主任务</button></div>}
        <div className="dsh-sc-messages" ref={messageScroll} onScroll={(event) => { const el = event.currentTarget; followMessages.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70; }} aria-label="侧聊消息">
          {!sideId ? <EmptyState icon="chat" title="主任务继续，思路在这里展开" compact>新建侧聊，用文件选区、命令输出或网页片段补充上下文。需要时，将选定消息审阅后送回主任务。</EmptyState> : !conversation && !conversationError ? <div className="dsh-sc-loading">正在读取侧聊…</div> : visibleMessages.length === 0 ? <EmptyState icon="chat" title="这是一段新的讨论" compact>在下方写下问题，或先从工作台加入上下文。</EmptyState> : visibleMessages.map((message, index) => <article key={message.id || index} className={`dsh-sc-message is-${message.role}${selected.has(message.id) ? ' is-selected' : ''}`}><div className="dsh-sc-message-heading"><span className={`dsh-sc-avatar is-${message.role}`}>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'S' : '·'}</span><strong>{({ user: '你', assistant: 'Sidechat', tool: '工具', system: '系统' })[message.role] || message.role}</strong><time>{formatTime(message.time)}</time><label className="dsh-sc-select-message"><input type="checkbox" aria-label={`选择第 ${index + 1} 条消息送回主任务`} checked={selected.has(message.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); event.target.checked ? next.add(message.id) : next.delete(message.id); return next; })}/><span>选择</span></label></div><MessageBody message={message} expanded={expandedMessages.has(message.id)} generating={conversation.running && index === visibleMessages.length - 1} onToggle={() => setExpandedMessages((current) => { const next = new Set(current); next.has(message.id) ? next.delete(message.id) : next.add(message.id); return next; })}/><div className="dsh-sc-message-actions"><button className="dsh-sc-text-button" disabled={!message.text} onClick={() => addPacket({ kind: 'message', source: `侧聊 ${conversation.title || sideTitle} · ${message.id}`, text: message.text })}><Icon name="plus" size={11}/>引用</button><button className="dsh-sc-text-button" disabled={!message.text} onClick={() => prepareReturn([message])}><Icon name="up" size={11}/>送回主任务</button></div></article>)}
          {conversation?.running && <div className="dsh-sc-generating"><span className="dsh-sc-live-dot"/>侧聊正在生成<span className="dsh-sc-muted">主任务保持独立</span></div>}
        </div>
        <div className="dsh-sc-compose-area">
          {packets.length > 0 && <div className="dsh-sc-packets"><button className="dsh-sc-packets-heading" aria-expanded={packetsOpen} onClick={() => setPacketsOpen((value) => !value)}><Icon name="packet" size={14}/><strong>上下文包</strong><span>{packets.length}</span><small>发送前可审阅</small><Icon name="chevron" size={12} className={packetsOpen ? 'is-rotated' : ''}/></button>{packetsOpen && <div className="dsh-sc-packet-list">{packets.map((packet) => <div className="dsh-sc-packet" key={packet._id}><details><summary><span className="dsh-sc-packet-kind">{({ file: '文件', terminal: '终端', web: '网页', message: '消息' })[packet.kind] || packet.kind}</span><span title={packet.source}>{packet.source}</span>{packet.startLine && <small>L{packet.startLine}–{packet.endLine}</small>}</summary><pre>{packet.text}</pre></details><button className="dsh-sc-icon-button" aria-label={`移除上下文 ${packet.source}`} title="移除此上下文" onClick={() => setPackets((current) => current.filter((item) => item._id !== packet._id))}><Icon name="close" size={12}/></button></div>)}</div>}</div>}
          <div className="dsh-sc-composer"><textarea aria-label="侧聊消息输入" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); sendSidechat(); } }} placeholder={sideId ? '向侧聊提问，整理思路…' : '先新建一个侧聊，即可开始讨论'} disabled={!sideId} rows={3}/><div className="dsh-sc-composer-actions"><span>Ctrl / ⌘ Enter 发送</span>{conversation?.running ? <button className="dsh-sc-small-button" onClick={cancelSidechat} disabled={cancelling}><Icon name="stop" size={12}/>{cancelling ? '停止中' : '停止侧聊'}</button> : <button className="dsh-sc-send-button" aria-label="发送到侧聊" onClick={sendSidechat} disabled={!sideId || !draft.trim() || Boolean(sending)}><Icon name="send" size={15}/>{sending && sending === sideId ? '发送中' : '发送'}</button>}</div></div>
          <p className="dsh-sc-compose-note"><span className="dsh-sc-status-dot"/>侧聊独立运行 · 仅在你确认后送回主任务</p>
        </div>
      </section>
    </div>
    <dialog className="dsh-sc-return-dialog" ref={dialogRef} aria-labelledby={dialogTitleId} onCancel={(event) => { event.preventDefault(); if (!returnSending) setReturnOpen(false); }} onClose={() => setReturnOpen(false)}><div className="dsh-sc-return-header"><div><span className="dsh-sc-eyebrow">REVIEW & SEND</span><h2 id={dialogTitleId}>送回主任务</h2></div><button className="dsh-sc-icon-button" aria-label="关闭发送预览" disabled={returnSending} onClick={() => setReturnOpen(false)}><Icon name="close"/></button></div><div className="dsh-sc-return-target"><span>目标</span><strong>{mainTitle}</strong><span className="dsh-sc-tag">排队发送</span></div><p className="dsh-sc-help">审阅并编辑下面的补充内容，确认后加入主任务队列。</p><textarea aria-label="送回主任务的内容" value={returnText} onChange={(event) => setReturnText(event.target.value)} rows={10} disabled={returnSending}/>{returnPackets.length > 0 && <div className="dsh-sc-return-context"><label><input type="checkbox" checked={returnIncludeContext} onChange={(event) => setReturnIncludeContext(event.target.checked)} disabled={returnSending}/>附上当前上下文包（{returnPackets.length} 条）</label>{returnIncludeContext && <div className="dsh-sc-packet-list">{returnPackets.map((packet) => <div className="dsh-sc-packet" key={packet._id}><details><summary><span>{packet.source}</span></summary><pre>{packet.text}</pre></details><button className="dsh-sc-icon-button" disabled={returnSending} aria-label={`从送回内容中移除 ${packet.source}`} onClick={() => setReturnPackets((current) => current.filter((item) => item._id !== packet._id))}><Icon name="close" size={12}/></button></div>)}</div>}</div>}{returnError && <div className="dsh-sc-inline-error" role="alert">{returnError}</div>}<div className="dsh-sc-return-footer"><button className="dsh-sc-small-button" disabled={returnSending} onClick={() => setReturnOpen(false)}>继续编辑侧聊</button><button className="dsh-sc-send-button" disabled={!returnText.trim() || returnSending} onClick={sendToMain}><Icon name="up" size={14}/>{returnSending ? '正在发送' : '确认排队发送'}</button></div></dialog>
  </aside>;
}
