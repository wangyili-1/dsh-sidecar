import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Compile only the integration layer. The actual Panel is tested separately; this stub
// prevents UI implementation details from hiding a broken native DSH registration.
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/client.jsx', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  plugins: [{
    name: 'native-contract-panel-stub',
    setup(builder) {
      builder.onResolve({ filter: /\.\/Panel\.jsx$/ }, () => ({ path: 'Panel', namespace: 'test-panel' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-panel' }, () => ({
        loader: 'js', contents: 'export default function Panel(){return null}',
      }));
    },
  }],
});

function harness() {
  const module = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(compiled.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: specifier => {
      assert(['react', 'react/jsx-runtime'].includes(specifier), `Unexpected runtime import: ${specifier}`);
      return { jsx, jsxs: jsx };
    },
  });

  const originalDetails = { options: { name: 'details', priority: 0 }, component: () => null };
  const entries = new Set([originalDetails]);
  const cleanups = [];
  const calls = [];
  let opened = 0;
  let response = { ok: true, value: { accepted: true } };
  const ctx = {
    slots: {
      inject: (_key, install) => install(),
      register(options, component) {
        const entry = { options, component };
        entries.add(entry);
        return () => entries.delete(entry);
      },
    },
    layout: { openDetails: () => opened++ },
    connection: { rpc: { call: async (...args) => { calls.push(args); return response; } } },
    effect: body => cleanups.push(body()),
  };
  // No sessions/open method exists in this harness: a coupling to main selection fails here.
  module.exports.apply(ctx);
  const header = [...entries].find(entry => entry.options.id === 'dsh-sidecar');
  assert(header, 'Sidecar must provide a native header control');
  const headerFace = header.options.inject();
  const activeDetails = () => [...entries]
    .filter(entry => entry.options.name === 'details')
    .sort((a, b) => (a.options.priority || 0) - (b.options.priority || 0))[0];
  return {
    entries, originalDetails, headerFace, activeDetails, calls,
    opened: () => opened,
    setResponse: value => { response = value; },
    cleanup: async () => { for (const dispose of cleanups.toReversed()) await dispose(); },
  };
}

test('opening Sidecar temporarily replaces details and closing restores the original tool view', async () => {
  const h = harness();
  assert.equal(h.activeDetails(), h.originalDetails, 'activation must not seize tool details');
  assert.equal(h.headerFace.hooks.sidecarVisibility.getSnapshot(), false);
  h.headerFace.onToggle();
  assert.equal(h.opened(), 1);
  assert.notEqual(h.activeDetails(), h.originalDetails);
  assert(h.entries.has(h.originalDetails), 'the original registration must survive');
  assert.equal(h.headerFace.hooks.sidecarVisibility.getSnapshot(), true);
  h.activeDetails().options.inject().onClose();
  assert.equal(h.activeDetails(), h.originalDetails);
  assert.equal(h.headerFace.hooks.sidecarVisibility.getSnapshot(), false);
  h.headerFace.onToggle();
  h.headerFace.onToggle();
  assert.equal(h.activeDetails(), h.originalDetails, 'the header is also a reversible toggle');
  await h.cleanup();
});

test('the native panel receives the selected main identity without selecting another session', async () => {
  const h = harness();
  h.headerFace.onToggle();
  const details = h.activeDetails();
  const tree = details.component({ sessionId: 'main-current', ...details.options.inject() });
  assert.equal(tree.props.children.props.mainSessionId, 'main-current');
  h.headerFace.onToggle();
  h.headerFace.onToggle();
  await h.cleanup();
  assert.equal(h.activeDetails(), h.originalDetails, 'plugin cleanup must restore tool details');
});

test('RPC calls use the authenticated sidecar channel and preserve caller cancellation', async () => {
  const h = harness();
  h.headerFace.onToggle();
  const { api } = h.activeDetails().options.inject();
  const controller = new AbortController();
  const payload = { mainSessionId: 'main-current', sessionId: 'side-separate' };
  const value = { id: 'side-separate', messages: [] };
  h.setResponse({ ok: true, value });
  assert.equal(await api.call('conversation/get', payload, controller.signal), value);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], '/sidecar-api');
  assert.equal(h.calls[0][1], 'conversation/get');
  assert.equal(h.calls[0][2], payload);
  assert.equal(h.calls[0][3], controller.signal);
  await h.cleanup();
});

test('RPC failures preserve the backend message and code instead of showing a success value', async () => {
  const h = harness();
  h.headerFace.onToggle();
  const { api } = h.activeDetails().options.inject();
  const details = { sessionId: 'side-separate' };
  h.setResponse({ ok: false, error: { code: 'sidecar/session-not-found', message: 'Side conversation no longer exists.', details } });
  await assert.rejects(api.call('conversation/get', {}), error => {
    assert.equal(error.message, 'Side conversation no longer exists.');
    assert.equal(error.code, 'sidecar/session-not-found');
    assert.equal(error.details, details);
    return true;
  });
  await h.cleanup();
});
