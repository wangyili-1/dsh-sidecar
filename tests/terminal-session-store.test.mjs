import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalSessionStore } from '../src/terminal-session-store.mjs';

test('retains a terminal handle when the panel unsubscribes and reopens', async () => {
  const store = createTerminalSessionStore();
  const close = store.subscribe('main-a', () => {});
  await store.start('main-a', async () => ({ id: 'job-a' }));
  close();
  assert.equal(store.getSnapshot('main-a').id, 'job-a');
  const reopen = store.subscribe('main-a', () => {});
  assert.equal(store.getSnapshot('main-a').id, 'job-a');
  reopen();
});

test('main sessions never inherit each other’s job handles or notifications', async () => {
  const store = createTerminalSessionStore();
  let notificationsA = 0;
  store.subscribe('main-a', () => { notificationsA += 1; });
  await store.start('main-a', async () => ({ id: 'job-a' }));
  const beforeB = notificationsA;
  assert.equal(store.getSnapshot('main-b').id, '');
  await store.start('main-b', async () => ({ id: 'job-b' }));
  assert.equal(store.getSnapshot('main-a').id, 'job-a');
  assert.equal(store.getSnapshot('main-b').id, 'job-b');
  assert.equal(notificationsA, beforeB);
});

test('recovers a command whose start response arrives after closing the panel', async () => {
  const store = createTerminalSessionStore();
  let finish;
  const close = store.subscribe('main-a', () => {});
  const pending = store.start('main-a', () => new Promise((resolve) => { finish = resolve; }));
  close();
  assert.equal(store.getSnapshot('main-a').starting, true);
  await assert.rejects(store.start('main-a', async () => ({ id: 'duplicate' })), /正在启动/);
  let reopenedId;
  store.subscribe('main-a', () => { reopenedId = store.getSnapshot('main-a').id; });
  finish({ id: 'late-job' });
  await pending;
  assert.equal(reopenedId, 'late-job');
  assert.equal(store.getSnapshot('main-a').starting, false);
});

test('a stale missing-job response cannot erase a newer job', async () => {
  const store = createTerminalSessionStore();
  await store.start('main-a', async () => ({ id: 'old-job' }));
  await store.start('main-a', async () => ({ id: 'new-job' }));
  assert.equal(store.forget('main-a', 'old-job'), false);
  assert.equal(store.getSnapshot('main-a').id, 'new-job');
  assert.equal(store.forget('main-a', 'new-job'), true);
  assert.equal(store.getSnapshot('main-a').id, '');
});

test('failed starts release the pending state and preserve the last known job', async () => {
  const store = createTerminalSessionStore();
  await store.start('main-a', async () => ({ id: 'existing-job' }));
  await assert.rejects(store.start('main-a', async () => { throw new Error('offline'); }), /offline/);
  assert.deepEqual(store.getSnapshot('main-a'), { id: 'existing-job', starting: false });
});
