const PANEL_WIDTH = '--dsh-sc-panel-width';
const RESERVED_WIDTH = '--dsh-sc-reserved-width';
const CENTER_MARK = 'data-dsh-sc-center';
const DOCK_MARK = 'data-dsh-sc-docked';
const RESIZE_MARK = 'data-dsh-sc-resizing';
export const DOCK_WIDTH_KEY = 'dsh-sidecar.panel-width.v1';
export const DEFAULT_DOCK_WIDTH = 420;
const PREFERRED_MINIMUM = 320;
const PREFERRED_MAXIMUM = 960;
const initialSnapshot = Object.freeze({ panelWidth: DEFAULT_DOCK_WIDTH, minWidth: PREFERRED_MINIMUM, maxWidth: PREFERRED_MAXIMUM, preferredWidth: DEFAULT_DOCK_WIDTH, resizing: false, visible: false, ready: false });
const noopDock = () => ({ update() {}, dispose() {}, getSnapshot: () => initialSnapshot, subscribe: () => () => {}, startResize: () => false, moveResize() {}, endResize() {}, resizeByKey: () => false, resetWidth() {} });
const validSize = value => Number.isFinite(value) && value >= 0 ? value : 0;
const normalizePreference = value => Number.isFinite(value) ? Math.min(PREFERRED_MAXIMUM, Math.max(PREFERRED_MINIMUM, Math.round(value))) : DEFAULT_DOCK_WIDTH;

export function readDockWidth(storage) {
  try {
    const value = storage?.getItem(DOCK_WIDTH_KEY);
    return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) && Number.isFinite(Number(value)) && Number(value) > 0 ? normalizePreference(Number(value)) : DEFAULT_DOCK_WIDTH;
  } catch { return DEFAULT_DOCK_WIDTH; }
}

function saveDockWidth(storage, value) {
  try { storage?.setItem(DOCK_WIDTH_KEY, String(normalizePreference(value))); } catch { /* Private/blocked/full storage must not disable resizing. */ }
}

/** Only the fixed DSH 0.1.2 three-track contract is accepted. */
export function parseNativeTracks(value) {
  const match = /^\s*(\d+(?:\.\d+)?)px\s+minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)\s+(\d+(?:\.\d+)?)px\s*$/.exec(value || '');
  if (!match) return undefined;
  return { sidebar: Number(match[1]), details: Number(match[2]) };
}

/** Reserve real content space, with a useful main column before a full-size dock. */
export function dockWidthRange({ frameWidth, sidebarWidth, detailsWidth = 0 }) {
  const frame = validSize(frameWidth);
  const sidebar = validSize(sidebarWidth);
  const nativeDetails = validSize(detailsWidth);
  const available = Math.max(0, frame - sidebar);
  const mainMinimum = frame <= 700 ? 240 : 320;
  // On very narrow windows split the remaining area instead of covering navigation.
  const maximum = available >= mainMinimum ? available - mainMinimum : available * .45;
  const maxWidth = Math.floor(Math.min(PREFERRED_MAXIMUM, maximum) * 100) / 100;
  return { minWidth: Math.min(maxWidth, Math.max(PREFERRED_MINIMUM, nativeDetails)), maxWidth };
}

export function computeDockMetrics({ frameWidth, sidebarWidth, detailsWidth = 0, visible, preferredWidth = DEFAULT_DOCK_WIDTH }) {
  const range = dockWidthRange({ frameWidth, sidebarWidth, detailsWidth });
  const panelWidth = Math.min(range.maxWidth, Math.max(range.minWidth, normalizePreference(preferredWidth)));
  return {
    panelWidth,
    reservedWidth: visible ? Math.max(0, panelWidth - validSize(detailsWidth)) : 0,
  };
}

function rememberAttribute(element, name) {
  const value = element.getAttribute(name);
  return () => value === null ? element.removeAttribute(name) : element.setAttribute(name, value);
}

function rememberProperty(element, name) {
  const value = element.style.getPropertyValue(name);
  const priority = element.style.getPropertyPriority(name);
  return () => value ? element.style.setProperty(name, value, priority) : element.style.removeProperty(name);
}

/**
 * DSH's public overlay seat is adjacent to its center/details columns. The pinned
 * layout has no public API to reserve details width for an empty conversation.
 * Mark only those verified columns; native tracks and all unrelated styles stay
 * owned by DSH. Padding supplies the reservation its native details track lacks.
 */
export function attachDockLayout(overlayElement) {
  const shellOverlay = overlayElement?.closest?.('[data-shell-overlay]');
  const frame = shellOverlay?.parentElement;
  const details = shellOverlay?.previousElementSibling;
  const center = details?.previousElementSibling;
  const sidebar = center?.previousElementSibling;
  const view = overlayElement?.ownerDocument?.defaultView;
  const structureMatches = () => Boolean(
    frame && sidebar && center && details && shellOverlay &&
    shellOverlay.parentElement === frame && details.parentElement === frame &&
    center.parentElement === frame && sidebar.parentElement === frame &&
    sidebar.previousElementSibling === null &&
    center.previousElementSibling === sidebar && details.previousElementSibling === center &&
    shellOverlay.previousElementSibling === details &&
    shellOverlay.contains(overlayElement) && view?.getComputedStyle(frame).display === 'grid'
  );
  if (!structureMatches() || !parseNativeTracks(frame.style.gridTemplateColumns)) return noopDock();

  const restore = [
    rememberProperty(overlayElement, PANEL_WIDTH), rememberProperty(center, RESERVED_WIDTH),
    rememberAttribute(center, CENTER_MARK), rememberAttribute(frame, DOCK_MARK), rememberAttribute(frame, RESIZE_MARK),
  ];
  let storage;
  try { storage = view.localStorage; } catch { /* Sandboxed/blocked storage. */ }
  let preferredWidth = readDockWidth(storage);
  let snapshot = initialSnapshot;
  const listeners = new Set();
  let visible = false;
  let disposed = false;
  let mutationObserver;
  let resizeObserver;
  let drag;
  let dragFrame;
  const cancelFrame = () => { if (dragFrame !== undefined) { view.cancelAnimationFrame?.(dragFrame); dragFrame = undefined; } };
  const publish = next => {
    if (Object.keys(next).every(key => next[key] === snapshot[key])) return;
    snapshot = Object.freeze(next);
    for (const listener of [...listeners]) listener();
  };
  const dispose = () => {
    if (disposed) return;
    if (drag) preferredWidth = drag.previousWidth;
    drag = undefined;
    cancelFrame();
    disposed = true;
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
    for (const restoreOne of restore) restoreOne();
    listeners.clear();
  };
  const refresh = () => {
    if (disposed) return;
    const tracks = parseNativeTracks(frame.style.gridTemplateColumns);
    if (!structureMatches() || !tracks) { dispose(); return; }
    const frameWidth = frame.getBoundingClientRect().width;
    if (!Number.isFinite(frameWidth) || frameWidth <= 0) return;
    const geometry = {
      frameWidth,
      sidebarWidth: Math.max(tracks.sidebar, sidebar.getBoundingClientRect().width || 0),
      detailsWidth: tracks.details,
    };
    const metrics = computeDockMetrics({ ...geometry, visible, preferredWidth });
    overlayElement.style.setProperty(PANEL_WIDTH, `${metrics.panelWidth}px`);
    center.style.setProperty(RESERVED_WIDTH, `${metrics.reservedWidth}px`);
    center.setAttribute(CENTER_MARK, '');
    if (visible) frame.setAttribute(DOCK_MARK, '');
    else frame.removeAttribute(DOCK_MARK);
    if (drag) frame.setAttribute(RESIZE_MARK, '');
    else frame.removeAttribute(RESIZE_MARK);
    publish({ ...dockWidthRange(geometry), panelWidth: metrics.panelWidth, preferredWidth, resizing: Boolean(drag), visible, ready: true });
  };
  const changeWidth = (width, persist = false) => {
    if (disposed || !snapshot.ready || !Number.isFinite(width)) return;
    preferredWidth = normalizePreference(Math.min(snapshot.maxWidth, Math.max(snapshot.minWidth, width)));
    refresh();
    if (persist) saveDockWidth(storage, preferredWidth);
  };
  const flushDrag = () => {
    cancelFrame();
    if (!drag || disposed) return;
    changeWidth(drag.startWidth + drag.startX - drag.latestX);
  };
  const endResize = (pointerId, clientX, cancelled = false) => {
    if (!drag || drag.pointerId !== pointerId || disposed) return;
    if (Number.isFinite(clientX)) drag.latestX = clientX;
    if (cancelled || Math.abs(drag.latestX - drag.startX) < .5) { cancelFrame(); preferredWidth = drag.previousWidth; }
    else { flushDrag(); saveDockWidth(storage, preferredWidth); }
    drag = undefined;
    refresh();
  };
  if (view.MutationObserver) {
    mutationObserver = new view.MutationObserver(refresh);
    // Only native target-track writes matter; our data attributes cannot feed back.
    mutationObserver.observe(frame, { attributes: true, attributeFilter: ['style'] });
  }
  if (view.ResizeObserver) {
    resizeObserver = new view.ResizeObserver(refresh);
    resizeObserver.observe(frame);
    // During a sidebar transition reserve against both its target and actual box.
    resizeObserver.observe(sidebar);
  }
  refresh();
  return {
    update(next) {
      visible = Boolean(next?.visible);
      if (!visible && drag) endResize(drag.pointerId, undefined, true);
      refresh();
    },
    getSnapshot: () => snapshot,
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
    startResize(pointerId, clientX, renderedWidth = snapshot.panelWidth) {
      if (disposed || !visible || !snapshot.ready || snapshot.maxWidth <= snapshot.minWidth || drag || !Number.isFinite(clientX) || !Number.isFinite(renderedWidth)) return false;
      drag = { pointerId, startX: clientX, latestX: clientX, startWidth: renderedWidth, previousWidth: preferredWidth };
      // Start from the actually rendered size, including a currently clamped window.
      changeWidth(renderedWidth);
      return true;
    },
    moveResize(pointerId, clientX) {
      if (!drag || drag.pointerId !== pointerId || !Number.isFinite(clientX) || disposed) return;
      drag.latestX = clientX;
      if (dragFrame !== undefined) return;
      if (view.requestAnimationFrame) dragFrame = view.requestAnimationFrame(() => { dragFrame = undefined; flushDrag(); });
      else flushDrag();
    },
    endResize,
    resizeByKey(key, shift = false) {
      if (disposed || !visible || !snapshot.ready) return false;
      if (key === 'Escape' && drag) { endResize(drag.pointerId, undefined, true); return true; }
      if (drag) return false;
      const step = shift ? 48 : 16;
      const target = key === 'ArrowLeft' ? snapshot.panelWidth + step : key === 'ArrowRight' ? snapshot.panelWidth - step : key === 'Home' ? snapshot.minWidth : key === 'End' ? snapshot.maxWidth : undefined;
      if (target === undefined) return false;
      changeWidth(target, true);
      return true;
    },
    resetWidth() { if (!disposed && visible && !drag) { preferredWidth = DEFAULT_DOCK_WIDTH; refresh(); saveDockWidth(storage, preferredWidth); } },
    dispose,
  };
}
