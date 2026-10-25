import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertNodeVersion, findDsh, parseArgs, pluginLoadMode, supportedDshVersion } from '../scripts/start.mjs';

test('launcher reuses a persistent plugin, preserves disabled entries, and rejects duplicate or conflicting installs', () => {
  const entryName = 'file:///plugin/lib/index.js';
  assert.equal(pluginLoadMode({ installed: false, count: 0, overrideCount: 0 }, entryName), 'overlay');
  assert.equal(pluginLoadMode({ installed: true, count: 1, overrideCount: 0, entryName }, entryName), 'profile');
  assert.equal(pluginLoadMode({ installed: true, count: 1, overrideCount: 1, entryName }, entryName), 'profile');
  assert.throws(() => pluginLoadMode({ installed: true, count: 2, entryName }, entryName), /Multiple/);
  assert.throws(() => pluginLoadMode({ installed: true, count: 1, entryName: 'file:///different/lib/index.js' }, entryName), /different/);
  assert.throws(() => pluginLoadMode({ installed: false, count: 0, overrideCount: 1 }, entryName), /without installing/);
});

test('launcher rejects unsupported Node versions before discovering or starting DSH', () => {
  for (const version of ['18.20.0', '20.19.0', 'invalid']) assert.throws(() => assertNodeVersion(version), /Node.js 22/);
  for (const version of ['22.0.0', '24.1.0', 'v22.12.0']) assert.doesNotThrow(() => assertNodeVersion(version));
});

test('launcher preserves a workspace path containing spaces and pins the adapter version', () => {
  const value = parseArgs(['--workspace', './directory with spaces', '--port', '4092', '--open']);
  assert.ok(value.workspace.endsWith('directory with spaces'));
  assert.equal(value.port, 4092);
  assert.equal(value.open, true);
  assert.equal(supportedDshVersion, '0.1.2-rc.1');
});

test('invalid ports and unsupported flags are rejected before launching a process', () => {
  for (const value of ['0', '22', '65536', 'NaN', '3092.5']) {
    assert.throws(() => parseArgs(['--port', value]));
  }
  assert.throws(() => parseArgs(['--workspace']));
  assert.throws(() => parseArgs(['--dangerously-upgrade']));
});

test('existing DSH discovery validates package identity and refuses a version upgrade', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-sidecar-launcher-'));
  const cli = join(temporaryRoot, 'runtime with spaces', 'lib', 'bin.js');
  const metadata = resolve(dirname(cli), '../package.json');
  try {
    await mkdir(dirname(cli), { recursive: true });
    await writeFile(cli, '// Fixture: this file is never executed.\n');
    await writeFile(metadata, JSON.stringify({ name: '@deepseek-ai/dsh', version: supportedDshVersion }));
    assert.deepEqual(await findDsh(cli, {}), { cli, version: supportedDshVersion });
    await writeFile(metadata, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0' }));
    await assert.rejects(findDsh(cli, {}), error => error.code === 'VERSION_MISMATCH');
    assert.equal(JSON.parse(await readFile(metadata, 'utf8')).version, '0.2.0', 'discovery must never rewrite an installation');
  } finally {
    // The only recursive cleanup target is the unique directory allocated by this test.
    assert.equal(dirname(resolve(temporaryRoot)), resolve(tmpdir()));
    assert.ok(temporaryRoot.split(/[\\/]/).at(-1).startsWith('dsh-sidecar-launcher-'));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
