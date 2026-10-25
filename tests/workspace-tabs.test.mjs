import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceState, workspaceTabsReducer as reduce, groupForTab, openTabIds } from '../src/workspace-tabs.mjs';

const tab = (id, kind = 'browser') => ({ id, kind, title: id, ...(kind === 'chat' ? { sessionId: `session-${id}` } : {}) });
const withTabs = (...ids) => ids.reduce((state, id) => reduce(state, { type: 'open', tab: tab(id) }), createWorkspaceState());
function assertInvariant(state) {
  const allIds = state.tabs.map(item => item.id);
  const openIds = openTabIds(state);
  assert.equal(new Set(allIds).size, allIds.length, 'catalog identities stay unique');
  assert.equal(new Set(openIds).size, openIds.length, 'a tab can only occupy one pane');
  for (const id of openIds) assert(allIds.includes(id), 'every open tab has a catalog identity');
  for (const group of ['top', 'bottom']) {
    if (state.groups[group].length) assert(state.groups[group].includes(state.active[group]));
    else assert.equal(state.active[group], null);
  }
  assert(state.groups.top.length || !state.groups.bottom.length, 'lower-only panes are promoted');
  if (openIds.length) assert(state.groups[state.focused].length);
  assert(state.split >= 25 && state.split <= 75);
}

test('opening existing and cached tabs preserves identity without duplicates or moving groups', () => {
  const original = createWorkspaceState();
  const chat = tab('chat-a', 'chat');
  let state = reduce(original, { type: 'open', tab: chat, group: 'bottom' });
  const descriptor = state.tabs.find(item => item.id === chat.id);
  assert.equal(groupForTab(state, chat.id), 'bottom');
  state = reduce(state, { type: 'open', tab: { ...chat, title: 'stale default title' }, group: 'top' });
  assert.equal(groupForTab(state, chat.id), 'bottom');
  assert.equal(state.tabs.find(item => item.id === chat.id), descriptor);
  state = reduce(state, { type: 'close', id: chat.id });
  assert.equal(groupForTab(state, chat.id), undefined);
  assert.equal(state.tabs.find(item => item.id === chat.id), descriptor, 'closed tabs retain their mounted content descriptor');
  state = reduce(state, { type: 'open', tab: chat });
  assert.deepEqual(openTabIds(state), ['files', 'chat-a']);
  assert.equal(state.tabs.find(item => item.id === chat.id), descriptor);
  assert.equal(state.tabs.length, 2);
  assert.deepEqual(original.groups.top, ['files'], 'input state was not mutated');
  assertInvariant(state);
});

test('same-pane drag boundaries reorder forward and backward without off-by-one shifts', () => {
  let state = withTabs('a', 'b', 'c');
  state = reduce(state, { type: 'move', id: 'a', to: 'top', index: 4 });
  assert.deepEqual(state.groups.top, ['files', 'b', 'c', 'a']);
  state = reduce(state, { type: 'move', id: 'a', to: 'top', index: 1 });
  assert.deepEqual(state.groups.top, ['files', 'a', 'b', 'c']);
  assert.equal(reduce(state, { type: 'move', id: 'a', to: 'top', index: 1 }), state, 'its own leading boundary is unchanged');
  assert.equal(reduce(state, { type: 'move', id: 'a', to: 'top', index: 2 }), state, 'its own trailing boundary is unchanged');
  state = reduce(state, { type: 'move', id: 'files', to: 'top' });
  assert.deepEqual(state.groups.top, ['a', 'b', 'c', 'files']);
  assertInvariant(state);
});

test('dragging across panes preserves all tab contents and chooses adjacent source tabs', () => {
  let state = withTabs('a', 'b', 'c');
  const catalog = state.tabs;
  state = reduce(state, { type: 'move', id: 'c', to: 'bottom' });
  assert.deepEqual(state.groups, { top: ['files', 'a', 'b'], bottom: ['c'] });
  assert.deepEqual(state.active, { top: 'b', bottom: 'c' });
  state = reduce(state, { type: 'move', id: 'a', to: 'bottom', index: 0 });
  assert.deepEqual(state.groups.bottom, ['a', 'c']);
  assert.equal(state.active.top, 'b');
  assert.equal(state.active.bottom, 'a');
  assert.equal(state.focused, 'bottom');
  assert.equal(state.tabs, catalog);
  assertInvariant(state);
});

test('closing active tabs chooses next then previous, and lower-only pane is promoted', () => {
  let state = withTabs('a', 'b');
  state = reduce(state, { type: 'activate', id: 'a' });
  state = reduce(state, { type: 'close', id: 'a' });
  assert.equal(state.active.top, 'b');
  state = reduce(state, { type: 'close', id: 'b' });
  assert.equal(state.active.top, 'files');
  state = reduce(state, { type: 'open', tab: tab('a'), group: 'bottom' });
  state = reduce(state, { type: 'close', id: 'files' });
  assert.deepEqual(state.groups, { top: ['a'], bottom: [] });
  assert.deepEqual(state.active, { top: 'a', bottom: null });
  assert.equal(state.focused, 'top');
  state = reduce(state, { type: 'close', id: 'a' });
  assert.deepEqual(openTabIds(state), []);
  assert.equal(state.tabs.length, 3, 'closing all panes never deletes persisted conversations');
  assertInvariant(state);
});

test('merge keeps group order and the focused lower conversation selected', () => {
  let state = withTabs('a', 'b');
  state = reduce(state, { type: 'move', id: 'a', to: 'bottom' });
  state = reduce(state, { type: 'open', tab: tab('c'), group: 'bottom' });
  state = reduce(state, { type: 'merge' });
  assert.deepEqual(state.groups, { top: ['files', 'b', 'a', 'c'], bottom: [] });
  assert.equal(state.active.top, 'c');
  assert.equal(state.focused, 'top');
  assert.equal(reduce(state, { type: 'merge' }), state);
  assertInvariant(state);
});

test('titles can refresh closed tabs without changing their session identity and resize is bounded', () => {
  let state = reduce(createWorkspaceState(), { type: 'open', tab: tab('chat', 'chat') });
  state = reduce(state, { type: 'close', id: 'chat' });
  state = reduce(state, { type: 'title', id: 'chat', title: '问题分析' });
  const chat = state.tabs.find(item => item.id === 'chat');
  assert.equal(chat.sessionId, 'session-chat');
  assert.equal(chat.title, '问题分析');
  assert.equal(reduce(state, { type: 'title', id: 'chat', title: '问题分析' }), state);
  state = reduce(state, { type: 'resize', percent: 500 });
  assert.equal(state.split, 75);
  state = reduce(state, { type: 'resize', percent: -500 });
  assert.equal(state.split, 25);
  state = reduce(state, { type: 'resize', percent: 42.5 });
  assert.equal(state.split, 42.5);
  assertInvariant(state);
});

test('invalid targets and identity collisions do not alter the current workspace', () => {
  const state = withTabs('a');
  for (const action of [null, {}, { type: 'unknown' }, { type: 'activate', id: 'missing' },
    { type: 'close', id: 'missing' }, { type: 'move', id: 'missing', to: 'top' },
    { type: 'move', id: 'a', to: 'sideways' }, { type: 'move', id: 'a', to: 'top', index: -1 },
    { type: 'move', id: 'a', to: 'top', index: 9 }, { type: 'move', id: 'a', to: 'top', index: .5 },
    { type: 'open', tab: tab('a', 'chat') }, { type: 'open', tab: tab('b'), group: 'left' },
    { type: 'open', tab: { id: 'new', kind: 'unknown', title: 'new' } },
    { type: 'open', tab: { id: '', kind: 'browser', title: 'new' } },
    { type: 'title', id: 'missing', title: 'hello' }, { type: 'title', id: 'a', title: '' },
    { type: 'resize', percent: NaN }, { type: 'resize', percent: Infinity }, { type: 'resize', percent: '50' },
  ]) assert.equal(reduce(state, action), state);
  let chatState = reduce(state, { type: 'open', tab: tab('chat', 'chat') });
  assert.equal(reduce(chatState, { type: 'open', tab: { ...tab('chat', 'chat'), sessionId: 'different' } }), chatState);
  assertInvariant(state);
});

test('mixed drag, close, reopen and merge sequences preserve one owner for every open tab', () => {
  let state = createWorkspaceState();
  let seed = 137;
  const next = max => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max; };
  for (let step = 0; step < 500; step++) {
    const id = `page-${next(8)}`;
    const group = next(2) ? 'top' : 'bottom';
    const actions = [
      { type: 'open', tab: tab(id), group }, { type: 'close', id },
      { type: 'move', id, to: group, index: next(state.groups[group].length + 1) },
      { type: 'activate', id }, { type: 'merge' }, { type: 'resize', percent: next(120) },
    ];
    state = reduce(state, actions[next(actions.length)]);
    assertInvariant(state);
  }
});
