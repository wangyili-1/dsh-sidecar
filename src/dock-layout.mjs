const PANEL_WIDTH = '--dsh-sc-panel-width';
const RESERVED_WIDTH = '--dsh-sc-reserved-width';
const CENTER_MARK = 'data-dsh-sc-center';
const DOCK_MARK = 'data-dsh-sc-docked';
const noopDock = () => ({ update() {}, dispose() {} });

/** Only the fixed DSH 0.1.2 three-track contract is accepted. */
export function parseNativeTracks(value) {
  const match = /^\s*(\d+(?:\.\d+)?)px\s+minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)\s+(\d+(?:\.\d+)?)px\s*$/.exec(value || '');
  if (!match) return undefined;
  return { sidebar: Number(match[1]), details: Number(match[2]) };
}

/** Reserve real content space, with a useful main column before a full-size dock. */
export function computeDockMetrics({ frameWidth, sidebarWidth, detailsWidth = 0, visible }) {
  const finite = value => Number.isFinite(value) && value >= 0 ? value : 0;
  const frame = finite(frameWidth);
  const sidebar = finite(sidebarWidth);
  const nativeDetails = finite(detailsWidth);
  const available = Math.max(0, frame - sidebar);
  const mainMinimum = frame <= 700 ? 240 : 320;
  // On very narrow windows split the remaining area instead of covering navigation.
  const maximum = available >= mainMinimum ? available - mainMinimum : available * .45;
  const panelWidth = Math.round(Math.min(maximum, Math.max(420, nativeDetails)) * 100) / 100;
  return {
    panelWidth,
    reservedWidth: visible ? Math.max(0, panelWidth - nativeDetails) : 0,
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
    rememberAttribute(center, CENTER_MARK), rememberAttribute(frame, DOCK_MARK),
  ];
  let visible = false;
  let disposed = false;
  let mutationObserver;
  let resizeObserver;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
    for (const restoreOne of restore) restoreOne();
  };
  const refresh = () => {
    if (disposed) return;
    const tracks = parseNativeTracks(frame.style.gridTemplateColumns);
    if (!structureMatches() || !tracks) { dispose(); return; }
    const frameWidth = frame.getBoundingClientRect().width;
    if (!Number.isFinite(frameWidth) || frameWidth <= 0) return;
    const metrics = computeDockMetrics({
      frameWidth,
      sidebarWidth: Math.max(tracks.sidebar, sidebar.getBoundingClientRect().width || 0),
      detailsWidth: tracks.details,
      visible,
    });
    overlayElement.style.setProperty(PANEL_WIDTH, `${metrics.panelWidth}px`);
    center.style.setProperty(RESERVED_WIDTH, `${metrics.reservedWidth}px`);
    center.setAttribute(CENTER_MARK, '');
    if (visible) frame.setAttribute(DOCK_MARK, '');
    else frame.removeAttribute(DOCK_MARK);
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
    update(next) { visible = Boolean(next?.visible); refresh(); },
    dispose,
  };
}
