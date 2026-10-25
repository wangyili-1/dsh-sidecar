const GROUPS = ['top', 'bottom'];
const KINDS = new Set(['files', 'terminal', 'browser', 'chat', 'team']);
const isGroup = value => GROUPS.includes(value);
const isId = value => typeof value === 'string' && value.trim().length > 0;
const equalList = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

/** Catalog entries remain mounted after closing; groups contain only open tabs. */
export function createWorkspaceState() {
  return {
    tabs: [{ id: 'files', kind: 'files', title: '文件' }],
    groups: { top: ['files'], bottom: [] },
    active: { top: 'files', bottom: null },
    focused: 'top',
    split: 50,
  };
}

export function groupForTab(state, id) {
  if (!isId(id)) return undefined;
  return GROUPS.find(group => state.groups[group].includes(id));
}

export function openTabIds(state) {
  return [...state.groups.top, ...state.groups.bottom];
}

function validDescriptor(tab) {
  return tab && isId(tab.id) && KINDS.has(tab.kind) && typeof tab.title === 'string' &&
    tab.title.trim().length > 0 && (tab.sessionId === undefined || isId(tab.sessionId));
}

function finish(previous, { tabs = previous.tabs, groups = previous.groups, active = previous.active, focused = previous.focused, split = previous.split }) {
  // An empty upper group must not strand the remaining content below an empty pane.
  if (!groups.top.length && groups.bottom.length) {
    groups = { top: groups.bottom, bottom: [] };
    active = { top: active.bottom, bottom: null };
    focused = 'top';
  }
  const corrected = {};
  for (const group of GROUPS) corrected[group] = groups[group].includes(active[group]) ? active[group] : groups[group][0] ?? null;
  if (!groups[focused]?.length) focused = groups.top.length ? 'top' : groups.bottom.length ? 'bottom' : 'top';
  if (tabs === previous.tabs && equalList(groups.top, previous.groups.top) && equalList(groups.bottom, previous.groups.bottom) &&
      corrected.top === previous.active.top && corrected.bottom === previous.active.bottom && focused === previous.focused && split === previous.split) return previous;
  return { tabs, groups, active: corrected, focused, split };
}

/**
 * move.index addresses an insertion boundary in the target group BEFORE removal:
 * 0 means before its first tab; target.length means after its last. Moving a tab
 * forward in its own group subtracts one after removing the source. This matches
 * a pointer positioned before/after the tab visible during dragging.
 */
export function workspaceTabsReducer(state, action) {
  if (!action || typeof action !== 'object') return state;
  switch (action.type) {
    case 'open': {
      if (!validDescriptor(action.tab) || (action.group !== undefined && !isGroup(action.group))) return state;
      const oldTab = state.tabs.find(tab => tab.id === action.tab.id);
      // A stable tab ID must never be repurposed for another session or surface.
      if (oldTab && (oldTab.kind !== action.tab.kind ||
          (action.tab.sessionId !== undefined && action.tab.sessionId !== oldTab.sessionId))) return state;
      const group = groupForTab(state, action.tab.id) ?? action.group ?? state.focused;
      const open = state.groups[group].includes(action.tab.id);
      return finish(state, {
        tabs: oldTab ? state.tabs : [...state.tabs, { ...action.tab }],
        groups: open ? state.groups : { ...state.groups, [group]: [...state.groups[group], action.tab.id] },
        active: { ...state.active, [group]: action.tab.id },
        focused: group,
      });
    }
    case 'activate': {
      const group = groupForTab(state, action.id);
      if (!group) return state;
      return finish(state, { active: { ...state.active, [group]: action.id }, focused: group });
    }
    case 'move': {
      const from = groupForTab(state, action.id);
      if (!from || !isGroup(action.to)) return state;
      const target = state.groups[action.to];
      const boundary = action.index === undefined ? target.length : action.index;
      if (!Number.isInteger(boundary) || boundary < 0 || boundary > target.length) return state;
      const source = state.groups[from];
      const sourceIndex = source.indexOf(action.id);
      const groups = { ...state.groups, [from]: source.filter(id => id !== action.id) };
      const insertion = boundary - (from === action.to && sourceIndex < boundary ? 1 : 0);
      groups[action.to] = [...groups[action.to]];
      groups[action.to].splice(insertion, 0, action.id);
      const active = { ...state.active, [action.to]: action.id };
      if (from !== action.to && active[from] === action.id) active[from] = groups[from][Math.min(sourceIndex, groups[from].length - 1)] ?? null;
      return finish(state, { groups, active, focused: action.to });
    }
    case 'close': {
      const group = groupForTab(state, action.id);
      if (!group) return state;
      const index = state.groups[group].indexOf(action.id);
      const remaining = state.groups[group].filter(id => id !== action.id);
      return finish(state, {
        groups: { ...state.groups, [group]: remaining },
        active: state.active[group] === action.id ? { ...state.active, [group]: remaining[Math.min(index, remaining.length - 1)] ?? null } : state.active,
      });
    }
    case 'forget': {
      if (!state.tabs.some(tab => tab.id === action.id)) return state;
      const closed = workspaceTabsReducer(state, { type: 'close', id: action.id });
      return finish(closed, { tabs: closed.tabs.filter(tab => tab.id !== action.id) });
    }
    case 'merge': {
      if (!state.groups.bottom.length) return state;
      return finish(state, {
        groups: { top: [...state.groups.top, ...state.groups.bottom], bottom: [] },
        active: { top: state.focused === 'bottom' ? state.active.bottom : state.active.top, bottom: null },
        focused: 'top',
      });
    }
    case 'resize': {
      if (typeof action.percent !== 'number' || !Number.isFinite(action.percent)) return state;
      return finish(state, { split: Math.min(75, Math.max(25, action.percent)) });
    }
    case 'title': {
      if (!isId(action.id) || typeof action.title !== 'string' || !action.title.trim()) return state;
      const index = state.tabs.findIndex(tab => tab.id === action.id);
      if (index < 0 || state.tabs[index].title === action.title) return state;
      const tabs = [...state.tabs];
      tabs[index] = { ...tabs[index], title: action.title };
      return finish(state, { tabs });
    }
    default: return state;
  }
}
