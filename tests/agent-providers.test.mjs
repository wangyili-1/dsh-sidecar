import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAgentProviderStore } from '../src/agent-providers.mjs';
import { RESOURCE_PRESETS, isAgentReady, isLoopbackAgentUrl, isManualWebUrl } from '../src/agent-resources.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=';
const reply = (value, init = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const answer = (content = 'Final answer') => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });
const profile = (extra = {}) => ({ id: 'fixture-agent', name: 'Fixture agent', role: '', protocol: 'chat-completions', baseUrl: 'https://provider.example/v1', model: 'explicit-fixture-model', apiKeyEnv: 'FIXTURE_KEY', enabled: true, timeoutMs: 1000, maxOutputTokens: 2048, ...extra });
const rejected = (code, status) => error => {
  assert.equal(error.code, code);
  if (status !== undefined) assert.equal(error.status, status);
  assert.equal(error.cause, undefined);
  return true;
};

async function fixture(work, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-sidecar-agent-providers-'));
  const env = options.env ?? {};
  const fetchImpl = options.fetchImpl ?? (() => { throw new Error('Unexpected provider request in fixture'); });
  const store = createAgentProviderStore({ dataDir, env, fetchImpl });
  try { await work({ store, dataDir, env, filename: join(dataDir, 'agent-providers', 'profiles.json') }); }
  finally {
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    assert.ok(dataDir.split(/[\\/]/).at(-1).startsWith('dsh-sidecar-agent-providers-'));
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('presets are disabled and list returns only detached public configuration', async () => {
  await fixture(async ({ store }) => {
    const profiles = await store.list();
    assert.deepEqual(profiles.map(value => value.id), ['glm', 'qwen', 'openai-image', 'claude']);
    assert.ok(profiles.every(value => !value.enabled));
    assert.equal(profiles.find(value => value.id === 'openai-image').hasKey, true);
    assert.equal(profiles.find(value => value.id === 'claude').model, '');
    assert.ok(profiles.every(value => !Object.hasOwn(value, 'apiKey')));
    profiles[0].name = 'Modified by a caller';
    assert.equal((await store.list())[0].name, 'GLM');
    await assert.rejects(store.execute({ agentId: 'openai-image', prompt: 'Fixture' }), rejected('agent-disabled'));
  }, { env: { OPENAI_API_KEY: 'fixture-env-value' } });
});

test('local keys persist privately, blank saves preserve them, and removal survives a new store', async () => {
  await fixture(async ({ store, filename, dataDir }) => {
    const saved = await store.save(profile({ apiKey: 'fixture-local-only' }));
    assert.equal(saved.hasKey, true);
    assert.equal(saved.apiKey, undefined);
    assert.ok(!JSON.stringify(saved).includes('fixture-local-only'));
    await store.save({ id: saved.id, name: 'Updated role', apiKey: '' });
    assert.ok((await readFile(filename, 'utf8')).includes('fixture-local-only'));
    const fresh = createAgentProviderStore({ dataDir, env: {} });
    assert.equal((await fresh.list()).find(value => value.id === saved.id).hasKey, true);
    assert.deepEqual(await fresh.remove(saved.id), { removed: true });
    assert.deepEqual(await fresh.remove(saved.id), { removed: false });
    assert.ok(!(await readFile(filename, 'utf8')).includes('fixture-local-only'));
    await fresh.remove('glm');
    assert.ok(!(await store.list()).some(value => value.id === 'glm'));
    await assert.rejects(store.execute({ agentId: saved.id, prompt: 'Fixture' }), rejected('agent-not-found'));
  });
});

test('credential storage uses owner-only POSIX modes or a current-user Windows DACL', async () => {
  await fixture(async ({ store, dataDir, filename }) => {
    await store.save(profile({ apiKey: 'fixture-permissions-only' }));
    if (process.platform === 'win32') {
      const script = "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=[System.IO.File]::GetAccessControl($env:DSH_FIXTURE_CREDENTIAL_PATH); $rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); [bool](@($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -ne $sid }).Count -eq 0 -and $rules.Count -gt 0)";
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, env: { ...process.env, DSH_FIXTURE_CREDENTIAL_PATH: filename },
      });
      assert.equal(stdout.trim(), 'True');
    } else {
      assert.equal((await stat(join(dataDir, 'agent-providers'))).mode & 0o777, 0o700);
      assert.equal((await stat(filename)).mode & 0o777, 0o600);
    }
  });
});

test('profile validation rejects unknown fields, unsafe endpoints and invalid env identifiers', async () => {
  await fixture(async ({ store }) => {
    for (const baseUrl of ['http://remote.example/v1', 'https://user:password@provider.example/v1', 'https://provider.example/v1?token=fixture', 'https://provider.example/v1#token', 'https://provider.example/v1?', 'file:///tmp/model', 'http://2130706433/v1', 'https://provider.example\\@elsewhere.example/v1']) {
      await assert.rejects(store.save(profile({ baseUrl })), rejected('invalid-endpoint'));
    }
    for (const extra of [{ apiKeyEnv: 'KEY WITH SPACES' }, { apiKeyEnv: '1KEY' }, { id: '../outside' }, { protocol: 'workbuddy' }, { model: '' }, { timeoutMs: 0 }, { maxOutputTokens: Infinity }, { apiVersion: 'version\r\nInjected' }, { headers: { secret: 'fixture' } }]) {
      await assert.rejects(store.save(profile(extra)), rejected('invalid-profile'));
    }
    await assert.rejects(store.save(profile({ apiKey: 'fixture\r\nheader' })), rejected('invalid-api-key'));
    for (const baseUrl of ['http://127.0.0.1:8080/v1/', 'http://localhost:8080/v1', 'http://[::1]:8080/v1']) {
      const saved = await store.save(profile({ baseUrl, enabled: false }));
      assert.ok(!saved.baseUrl.endsWith('/'));
    }
  });
});

test('changing endpoint does not silently transfer a local key or copied environment binding', async () => {
  let received;
  await fixture(async ({ store }) => {
    const original = await store.save(profile({ apiKey: 'fixture-official-key' }));
    await assert.rejects(store.save({ ...original, baseUrl: 'https://relay.example/v1', apiKey: '' }), rejected('missing-api-key'));
    const changed = await store.save({ ...original, enabled: false, baseUrl: 'https://relay.example/v1', apiKey: '' });
    assert.equal(changed.hasKey, false);
    assert.equal(changed.apiKeyEnv, '');
    await assert.rejects(store.execute({ agentId: original.id, prompt: 'Fixture' }), rejected('agent-disabled'));
    await store.save({ id: original.id, enabled: true, apiKeyEnv: 'RELAY_KEY' });
    await store.execute({ agentId: original.id, prompt: 'Fixture' });
    assert.equal(received.headers.Authorization, 'Bearer fixture-relay-key');
    const movedAgain = await store.save({ id: original.id, baseUrl: 'https://relay.example/other-tenant', apiKey: 'fixture-explicit-new-key' });
    assert.equal(movedAgain.hasKey, true);
    assert.equal(movedAgain.apiKeyEnv, '');
  }, { env: { FIXTURE_KEY: 'fixture-original-env', RELAY_KEY: 'fixture-relay-key' }, fetchImpl: async (url, options) => { received = options; return reply(answer()); } });
});

test('GLM and Qwen requests use explicit models and only final message content', async () => {
  const requests = [];
  await fixture(async ({ store }) => {
    await store.save({ id: 'glm', role: 'Review code carefully.', enabled: true, maxOutputTokens: 1234 });
    const result = await store.execute({ agentId: 'glm', prompt: 'Find the bug.' });
    assert.deepEqual(result, { text: 'Final answer', images: [], usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } });
    assert.equal(requests[0].url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
    assert.equal(requests[0].options.redirect, 'error');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer fixture-glm-key');
    assert.deepEqual(requests[0].body, { model: 'glm-4.7', messages: [{ role: 'system', content: 'Review code carefully.' }, { role: 'user', content: 'Find the bug.' }], max_tokens: 1234, stream: false });
    await store.save({ id: 'qwen', enabled: true, model: 'explicit-qwen-fixture-id' });
    await store.execute({ agentId: 'qwen', prompt: 'Review this result.' });
    assert.equal(requests[1].url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    assert.equal(requests[1].body.model, 'explicit-qwen-fixture-id');
    assert.equal(requests[1].options.headers.Authorization, 'Bearer fixture-qwen-key');
  }, { env: { ZHIPU_API_KEY: 'fixture-glm-key', DASHSCOPE_API_KEY: 'fixture-qwen-key' }, fetchImpl: async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    const value = answer();
    value.choices[0].message.reasoning_content = 'Never show private reasoning';
    value.usage = { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10, diagnostic: 'Do not copy raw usage' };
    return reply(value);
  } });
});

test('Responses extracts assistant final output and refuses to expose reasoning or commentary', async () => {
  let request;
  await fixture(async ({ store }) => {
    await store.save(profile({ protocol: 'responses', role: 'Be concise.' }));
    const result = await store.execute({ agentId: 'fixture-agent', prompt: 'A question' });
    assert.equal(request.url, 'https://provider.example/v1/responses');
    assert.deepEqual(request.body, { model: 'explicit-fixture-model', input: 'A question', instructions: 'Be concise.', max_output_tokens: 2048, store: false, stream: false });
    assert.deepEqual(result, { text: 'Part one\nPart two', images: [], usage: { inputTokens: 12, outputTokens: 5 } });
  }, { env: { FIXTURE_KEY: 'fixture-response-key' }, fetchImpl: async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return reply({ status: 'completed', output_text: 'Do not trust the SDK-only shortcut', output: [
      { type: 'reasoning', summary: [{ text: 'Private reasoning' }] },
      { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Working...' }] },
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Part one' }] },
      { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Part two' }] },
    ], usage: { input_tokens: 12, output_tokens: 5, total_tokens: -2, secret: 'Do not expose' } });
  } });
});

test('Anthropic Messages uses its own headers and excludes thinking/tool blocks', async () => {
  let request;
  await fixture(async ({ store }) => {
    await store.save({ id: 'claude', enabled: true, model: 'explicit-claude-fixture-id', role: 'Check assumptions.', apiVersion: '2023-06-01' });
    const result = await store.execute({ agentId: 'claude', prompt: 'A question' });
    assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(request.options.headers['x-api-key'], 'fixture-claude-key');
    assert.equal(request.options.headers['anthropic-version'], '2023-06-01');
    assert.equal(request.options.headers.Authorization, undefined);
    assert.deepEqual(request.body, { model: 'explicit-claude-fixture-id', messages: [{ role: 'user', content: 'A question' }], system: 'Check assumptions.', max_tokens: 4096, stream: false });
    assert.deepEqual(result, { text: 'Checked answer', images: [], usage: { inputTokens: 9, outputTokens: 3 } });
  }, { env: { ANTHROPIC_API_KEY: 'fixture-claude-key' }, fetchImpl: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return reply({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'Not final' }, { type: 'text', text: 'Checked answer' }], usage: { input_tokens: 9, output_tokens: 3 } });
  } });
});

test('Images requests one base64 image without the legacy response_format field', async () => {
  let request;
  await fixture(async ({ store }) => {
    await store.save({ id: 'openai-image', enabled: true, role: 'Use a clean composition.' });
    const result = await store.execute({ agentId: 'openai-image', prompt: 'A fixture prompt' });
    assert.equal(request.url, 'https://api.openai.com/v1/images/generations');
    assert.deepEqual(request.body, { model: 'gpt-image-2.5-flare', prompt: 'Use a clean composition.\n\nA fixture prompt', n: 1, output_format: 'png' });
    assert.deepEqual(result, { text: '', images: [{ mimeType: 'image/png', dataBase64: PNG }], usage: { totalTokens: 42 } });
  }, { env: { OPENAI_API_KEY: 'fixture-image-key' }, fetchImpl: async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return reply({ data: [{ b64_json: PNG, url: 'https://ignored.example/image', revised_prompt: 'Not a final answer' }], usage: { total_tokens: 42 } });
  } });
});

test('image URL-only, SVG, noncanonical base64 and unexpected batches are rejected without fetching URLs', async () => {
  let calls = 0;
  let result;
  await fixture(async ({ store }) => {
    await store.save({ id: 'openai-image', enabled: true });
    for (const data of [[{ url: 'https://private.example/image?key=fixture' }], [{ b64_json: Buffer.from('<svg/>').toString('base64') }], [{ b64_json: PNG.replace(/=$/, '!') }], [{ b64_json: PNG }, { b64_json: PNG }]]) {
      result = { data };
      await assert.rejects(store.execute({ agentId: 'openai-image', prompt: 'Fixture' }), rejected('unsupported-image'));
    }
    assert.equal(calls, 4);
  }, { env: { OPENAI_API_KEY: 'fixture-image-key' }, fetchImpl: async () => { calls++; return reply(result); } });
});

test('missing authentication and invalid prompts never reach the provider', async () => {
  let calls = 0;
  await fixture(async ({ store, env }) => {
    await assert.rejects(store.save(profile()), rejected('missing-api-key'));
    await store.save(profile({ enabled: false }));
    env.FIXTURE_KEY = 'fixture-key';
    await store.save({ id: 'fixture-agent', enabled: true });
    delete env.FIXTURE_KEY;
    await assert.rejects(store.execute({ agentId: 'fixture-agent', prompt: 'Fixture' }), rejected('missing-api-key'));
    env.FIXTURE_KEY = 'invalid\nfixture';
    await assert.rejects(store.execute({ agentId: 'fixture-agent', prompt: 'Fixture' }), rejected('invalid-api-key'));
    env.FIXTURE_KEY = 'fixture-key';
    for (const prompt of ['', ' ', 'x'.repeat(256 * 1024 + 1), {}]) await assert.rejects(store.execute({ agentId: 'fixture-agent', prompt }), rejected('invalid-prompt'));
    await assert.rejects(store.execute({ agentId: 'fixture-agent', prompt: 'Fixture', signal: {} }), rejected('invalid-signal'));
    assert.equal(calls, 0);
  }, { fetchImpl: async () => { calls++; return reply(answer()); } });
});

test('HTTP, invalid JSON and network failures expose only fixed safe messages and status codes', async () => {
  let mode;
  const sensitive = 'fixture-private-provider-content';
  await fixture(async ({ store }) => {
    await store.save(profile({ apiKey: 'fixture-auth-key' }));
    for (const [value, expected] of [[401, 'provider-auth'], [403, 'provider-auth'], [429, 'provider-rate-limit'], [500, 'provider-http'], [302, 'provider-redirect'], ['json', 'invalid-response'], ['network', 'network-error']]) {
      mode = value;
      await assert.rejects(store.execute({ agentId: 'fixture-agent', prompt: 'Fixture' }), error => {
        rejected(expected, typeof value === 'number' && value !== 302 ? value : undefined)(error);
        assert.ok(!String(error).includes(sensitive));
        assert.ok(!String(error).includes('fixture-auth-key'));
        assert.equal(error.response, undefined);
        return true;
      });
    }
  }, { fetchImpl: async () => {
    if (mode === 'network') throw new Error(`https://provider.example/?key=${sensitive} fixture-auth-key`);
    if (mode === 'json') return new Response(`invalid JSON ${sensitive}`);
    return new Response(sensitive, { status: mode, statusText: sensitive, headers: { location: `https://redirect.example/?key=${sensitive}` } });
  } });
});

test('incomplete results and provider errors cannot masquerade as completed answers', async () => {
  let raw;
  await fixture(async ({ store }) => {
    await store.save(profile({ apiKey: 'fixture-key' }));
    for (const [value, code] of [[{ error: { message: 'private-error' } }, 'provider-error'], [{ choices: [{ ...answer().choices[0], finish_reason: 'length' }] }, 'provider-incomplete'], [{ choices: [{ message: { role: 'assistant', reasoning_content: 'Only reasoning' } }] }, 'invalid-response']]) {
      raw = value;
      await assert.rejects(store.execute({ agentId: 'fixture-agent', prompt: 'Fixture' }), rejected(code));
    }
    await store.save({ id: 'fixture-agent', protocol: 'responses' });
    raw = { status: 'incomplete', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Partial' }] }] };
    await assert.rejects(store.execute({ agentId: 'fixture-agent', prompt: 'Fixture' }), rejected('provider-incomplete'));
    await store.save({ id: 'fixture-agent', protocol: 'anthropic-messages' });
    raw = { type: 'message', role: 'assistant', stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Partial' }] };
    await assert.rejects(store.execute({ agentId: 'fixture-agent', prompt: 'Fixture' }), rejected('provider-incomplete'));
  }, { fetchImpl: async () => reply(raw) });
});

test('response size is bounded with or without Content-Length', async () => {
  let mode;
  await fixture(async ({ store }) => {
    await store.save(profile({ apiKey: 'fixture-key' }));
    for (mode of ['length', 'stream', 'text']) await assert.rejects(store.execute({ agentId: 'fixture-agent', prompt: 'Fixture' }), rejected('response-too-large'));
  }, { fetchImpl: async () => {
    if (mode === 'length') return new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } });
    if (mode === 'text') return reply(answer('x'.repeat(1024 * 1024 + 1)));
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close(); } }));
  } });
});

test('cancellation aborts the exact request and never exposes the caller cancellation reason', async () => {
  let entered;
  const started = new Promise(resolveStarted => { entered = resolveStarted; });
  let requestSignal;
  let calls = 0;
  await fixture(async ({ store }) => {
    await store.save(profile({ apiKey: 'fixture-key' }));
    const stopped = new AbortController();
    stopped.abort(new Error('private cancellation details'));
    await assert.rejects(store.execute({ agentId: 'fixture-agent', prompt: 'Fixture', signal: stopped.signal }), rejected('aborted'));
    assert.equal(calls, 0);
    const controller = new AbortController();
    const running = store.execute({ agentId: 'fixture-agent', prompt: 'Fixture', signal: controller.signal });
    await started;
    controller.abort(new Error('private cancellation details'));
    await assert.rejects(running, error => {
      assert.ok(!String(error).includes('private cancellation details'));
      return rejected('aborted')(error);
    });
    assert.equal(requestSignal.aborted, true);
  }, { fetchImpl: (url, options) => { calls++; requestSignal = options.signal; entered(); return new Promise(() => {}); } });
});

test('the time limit also covers a response body that never finishes', async () => {
  let cancelled = false;
  await fixture(async ({ store }) => {
    await store.save(profile({ apiKey: 'fixture-key', timeoutMs: 1000 }));
    await assert.rejects(store.execute({ agentId: 'fixture-agent', prompt: 'Fixture' }), rejected('timeout'));
    assert.equal(cancelled, true);
  }, { fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } })) });
});

test('stores in the same host serialize changes without losing independent profiles', async () => {
  await fixture(async ({ store, dataDir }) => {
    const other = createAgentProviderStore({ dataDir, env: {} });
    await Promise.all([
      store.save(profile({ id: 'first', enabled: false })),
      other.save(profile({ id: 'second', enabled: false })),
      store.save(profile({ id: 'third', enabled: false })),
    ]);
    const ids = (await other.list()).map(value => value.id);
    for (const id of ['first', 'second', 'third']) assert.ok(ids.includes(id));
  });
});

test('new profiles receive stable IDs and cannot be enabled with incomplete configuration', async () => {
  await fixture(async ({ store, dataDir }) => {
    const input = profile({ enabled: false });
    delete input.id;
    const saved = await store.save(input);
    assert.match(saved.id, /^agent-[0-9a-f-]{36}$/);
    const updated = await store.save({ id: saved.id, name: 'Renamed fixture' });
    assert.equal(updated.id, saved.id);
    const fresh = createAgentProviderStore({ dataDir, env: {} });
    assert.equal((await fresh.list()).find(value => value.name === 'Renamed fixture').id, saved.id);
    await assert.rejects(store.save({ id: saved.id, enabled: true }), rejected('missing-api-key'));
    await assert.rejects(store.save({ id: 'claude', enabled: true, apiKey: 'fixture-key' }), rejected('invalid-profile'));
    assert.equal((await store.list()).find(value => value.id === saved.id).enabled, false);
  });
});

test('an in-flight request keeps its own credential and endpoint snapshot during reconfiguration', async () => {
  const requests = [];
  let entered;
  let finish;
  const started = new Promise(resolveStarted => { entered = resolveStarted; });
  await fixture(async ({ store }) => {
    await store.save(profile({ apiKey: 'fixture-key-before', timeoutMs: 10000 }));
    const running = store.execute({ agentId: 'fixture-agent', prompt: 'First question' });
    await started;
    await store.save({ id: 'fixture-agent', baseUrl: 'https://new-provider.example/v1', apiKey: 'fixture-key-after', model: 'new-explicit-model' });
    finish(reply(answer('First completed')));
    assert.equal((await running).text, 'First completed');
    await store.execute({ agentId: 'fixture-agent', prompt: 'Second question' });
    assert.equal(requests[0].url, 'https://provider.example/v1/chat/completions');
    assert.equal(requests[0].headers.Authorization, 'Bearer fixture-key-before');
    assert.equal(requests[0].body.model, 'explicit-fixture-model');
    assert.equal(requests[1].url, 'https://new-provider.example/v1/chat/completions');
    assert.equal(requests[1].headers.Authorization, 'Bearer fixture-key-after');
    assert.equal(requests[1].body.model, 'new-explicit-model');
  }, { fetchImpl: (url, options) => {
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    if (requests.length === 1) { entered(); return new Promise(resolveResponse => { finish = resolveResponse; }); }
    return Promise.resolve(reply(answer('Second completed')));
  } });
});

test('corrupt local data is not overwritten or echoed in errors', async () => {
  await fixture(async ({ store, filename }) => {
    await store.save(profile({ apiKey: 'fixture-key' }));
    const broken = '{ "secret": "fixture-corrupt-secret",';
    await writeFile(filename, broken);
    for (const operation of [() => store.list(), () => store.save(profile()), () => store.remove('fixture-agent')]) {
      await assert.rejects(operation(), error => {
        assert.ok(!String(error).includes('fixture-corrupt-secret'));
        return rejected('store-invalid')(error);
      });
    }
    assert.equal(await readFile(filename, 'utf8'), broken);
  });
});

test('resource catalog describes manual websites and opt-in local models without changing existing agents', async () => {
  assert.equal(RESOURCE_PRESETS.length, 5);
  assert.equal(new Set(RESOURCE_PRESETS.map(value => value.id)).size, 5);
  const websites = RESOURCE_PRESETS.filter(value => value.profile.protocol === 'manual-web');
  assert.equal(websites.length, 4);
  for (const resource of websites) {
    assert.equal(resource.profile.authMode, 'none');
    assert.equal(resource.profile.model, '');
    assert.equal(isAgentReady(resource.profile), true);
    assert.equal(isManualWebUrl(resource.docsUrl), true);
    assert.equal(Object.hasOwn(resource.profile, 'apiKey'), false);
  }
  const local = RESOURCE_PRESETS.find(value => value.id === 'ollama-local');
  assert.equal(local.profile.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(local.profile.enabled, false);
  assert.equal(local.profile.model, '');
  assert.equal(isAgentReady({ ...local.profile, enabled: true }), false);
  assert.equal(isAgentReady({ ...local.profile, enabled: true, model: 'installed-local-model' }), true);
  await fixture(async ({ store }) => assert.deepEqual((await store.list()).map(value => value.id), ['glm', 'qwen', 'openai-image', 'claude']));
});

test('readiness validates configuration independently of claimed ready state and supports legacy API profiles', () => {
  const legacy = profile({ hasKey: true });
  assert.equal(isAgentReady(legacy), true);
  assert.equal(isAgentReady({ ...legacy, ready: true }), true);
  for (const extra of [{ enabled: false }, { ready: false }, { ready: 'true' }, { hasKey: false, ready: true }, { model: '' }, { protocol: 'unknown' }, { authMode: 'unknown' }, { baseUrl: 'http://remote.example/v1' }, { baseUrl: 'https://@provider.example/v1' }, { baseUrl: 'https://provider.example/v1?' }]) {
    assert.equal(isAgentReady({ ...legacy, ...extra }), false, JSON.stringify(extra));
  }
  const local = { ...legacy, authMode: 'none', hasKey: false, baseUrl: 'http://127.0.0.1:11434/v1' };
  assert.equal(isAgentReady(local), true);
  assert.equal(isAgentReady({ ...local, protocol: 'responses' }), true);
  for (const extra of [{ protocol: 'images' }, { protocol: 'anthropic-messages' }, { baseUrl: 'https://remote.example/v1' }, { baseUrl: 'http://2130706433/v1' }, { baseUrl: 'https://127.1/v1' }, { baseUrl: 'http://localhost.evil.example/v1' }]) {
    assert.equal(isAgentReady({ ...local, ready: true, ...extra }), false, JSON.stringify(extra));
  }
  const manual = { enabled: true, protocol: 'manual-web', authMode: 'none', baseUrl: 'https://another-resource.example/chat/', model: '', hasKey: false };
  assert.equal(isAgentReady(manual), true);
  for (const baseUrl of ['http://localhost/chat', 'https://user:secret@example.com/', 'https://@example.com/', 'https://example.com/?q=1', 'https://example.com/#x', 'https://example.com\\@other.example/', 'javascript:alert(1)']) {
    assert.equal(isAgentReady({ ...manual, ready: true, baseUrl }), false);
    assert.equal(isManualWebUrl(baseUrl), false);
  }
  for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'https://[::1]:11434/v1']) assert.equal(isLoopbackAgentUrl(url), true);
  for (const url of ['http://127.1/v1', 'http://2130706433/v1', 'https://0x7f000001/v1', 'http://127.0.0.999/v1', 'http://127.0.0.1@remote.example/v1']) assert.equal(isLoopbackAgentUrl(url), false);
});

test('manual web resources save without a model, clear credentials and never call an API', async () => {
  let calls = 0;
  let envReads = 0;
  const env = Object.defineProperty({}, 'FIXTURE_KEY', { get() { envReads++; throw new Error('No-key resource must not read credentials'); } });
  await fixture(async ({ store, filename, dataDir }) => {
    const created = await store.save({ name: 'Another manual resource', protocol: 'manual-web', baseUrl: 'https://another-resource.example/chat/', enabled: true, apiKey: 'unused\r\nvalue', apiKeyEnv: 'FIXTURE_KEY' });
    assert.equal(created.model, '');
    assert.equal(created.authMode, 'none');
    assert.equal(created.apiKeyEnv, '');
    assert.equal(created.hasKey, false);
    assert.equal(created.ready, true);
    assert.equal(created.executionMode, 'web-manual');
    assert.equal(isAgentReady(created), true);
    assert.equal(created.apiKey, undefined);
    await assert.rejects(store.execute({ agentId: created.id, prompt: 'Do not send this anywhere' }), rejected('manual-web-only'));
    await store.save(profile({ apiKey: 'fixture-before-manual', apiKeyEnv: '' }));
    const converted = await store.save({ id: 'fixture-agent', protocol: 'manual-web', baseUrl: 'https://another-resource.example/chat', model: '', apiKeyEnv: 'FIXTURE_KEY' });
    assert.equal(converted.hasKey, false);
    const source = await readFile(filename, 'utf8');
    assert.ok(!source.includes('fixture-before-manual'));
    assert.ok(!source.includes('FIXTURE_KEY'));
    assert.ok(!source.includes('unused'));
    const fresh = createAgentProviderStore({ dataDir, env });
    const saved = (await fresh.list()).find(value => value.id === converted.id);
    assert.equal(saved.ready, true);
    assert.equal(saved.hasKey, false);
    await assert.rejects(store.save({ id: converted.id, protocol: 'chat-completions', authMode: 'api-key', baseUrl: 'https://provider.example/v1', model: 'explicit-fixture-model' }), rejected('missing-api-key'));
    assert.equal(calls, 0);
    assert.equal(envReads, 0);
  }, { env, fetchImpl: async () => { calls++; return reply(answer()); } });
});

test('no-key local Chat Completions and Responses omit credentials and use the configured model', async () => {
  let envReads = 0;
  const env = Object.defineProperty({}, 'FIXTURE_KEY', { get() { envReads++; throw new Error('Local API must not read credentials'); } });
  const requests = [];
  await fixture(async ({ store, filename }) => {
    for (const protocol of ['chat-completions', 'responses']) {
      const saved = await store.save(profile({ protocol, baseUrl: 'http://127.0.0.1:11434/v1', authMode: 'none', apiKey: 'discard-this-fixture-key', model: 'installed-local-model' }));
      assert.equal(saved.hasKey, false);
      assert.equal(saved.apiKeyEnv, '');
      assert.equal(saved.ready, true);
      assert.equal(saved.executionMode, 'local-api');
      assert.equal((await store.execute({ agentId: saved.id, prompt: 'Local fixture question' })).text, 'Local final');
      assert.equal((await store.list()).find(value => value.id === saved.id).ready, true);
    }
    assert.equal(envReads, 0);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(requests[1].url, 'http://127.0.0.1:11434/v1/responses');
    for (const request of requests) {
      assert.deepEqual(request.headers, { 'Content-Type': 'application/json' });
      assert.equal(request.body.model, 'installed-local-model');
      assert.equal(request.redirect, 'error');
    }
    assert.ok(!(await readFile(filename, 'utf8')).includes('discard-this-fixture-key'));
    await assert.rejects(store.save({ id: 'fixture-agent', authMode: 'api-key' }), rejected('missing-api-key'));
  }, { env, fetchImpl: async (url, options) => {
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body), redirect: options.redirect });
    return reply(url.endsWith('/responses') ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Local final' }] }] } : answer('Local final'));
  } });
});

test('no-key mode cannot enable remote API access or unsupported local protocols', async () => {
  await fixture(async ({ store }) => {
    for (const extra of [{ baseUrl: 'https://provider.example/v1' }, { baseUrl: 'https://127.1/v1' }, { baseUrl: 'https://2130706433/v1' }, { protocol: 'images', baseUrl: 'http://localhost:11434/v1' }, { protocol: 'anthropic-messages', baseUrl: 'http://localhost:11434/v1' }]) {
      await assert.rejects(store.save(profile({ authMode: 'none', ready: true, hasKey: true, ...extra })), rejected('invalid-auth-mode'));
    }
    for (const baseUrl of ['http://localhost:11434/chat', 'https://user:password@example.com/', 'https://@example.com/', 'https://example.com/?q=1', 'https://example.com/#x']) {
      await assert.rejects(store.save(profile({ protocol: 'manual-web', model: '', baseUrl })), rejected('invalid-endpoint'));
    }
    await assert.rejects(store.save(profile({ authMode: 'none', baseUrl: 'http://localhost:11434/v1', model: '' })), rejected('invalid-profile'));
    await assert.rejects(store.save(profile({ ready: true, hasKey: true })), rejected('missing-api-key'));
  });
});

test('public readiness excludes enablement while hasKey keeps its literal credential meaning', async () => {
  await fixture(async ({ store, env }) => {
    const configured = await store.save(profile({ enabled: false, apiKey: 'fixture-configured' }));
    assert.equal(configured.hasKey, true);
    assert.equal(configured.ready, true);
    assert.equal(configured.executionMode, 'api');
    assert.equal(isAgentReady(configured), false);
    const manual = await store.save({ name: 'Disabled manual', protocol: 'manual-web', baseUrl: 'https://example.com/chat', enabled: false });
    assert.equal(manual.ready, true);
    assert.equal(manual.hasKey, false);
    assert.equal(isAgentReady(manual), false);
    const local = await store.save(profile({ id: 'local', authMode: 'none', baseUrl: 'http://localhost:11434/v1', enabled: false, model: '' }));
    assert.equal(local.ready, false);
    assert.equal(local.hasKey, false);
    env.OPENAI_API_KEY = 'fixture\r\ninvalid';
    const invalidKey = (await store.list()).find(value => value.id === 'openai-image');
    assert.equal(invalidKey.hasKey, true);
    assert.equal(invalidKey.ready, false);
    assert.equal(isAgentReady({ ...invalidKey, enabled: true }), false);
  });
});
