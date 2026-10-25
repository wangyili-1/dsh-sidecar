import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createLaunchUrlCapture, findDesktopLauncher, matchesDesktopLauncher, parseDshLaunchLine, saveDesktopRuntimeState } from '../scripts/desktop-launch-state.mjs';

const run = Object.freeze({ node: 'C:\\Runtime\\node.exe', cli: 'C:\\Apps\\DeepSeekHarness\\runtime\\lib\\bin.js', home: 'C:\\Users\\Fixture\\.dsh', host: '127.0.0.1', port: 3080 });
const config = Object.freeze({ Node: run.node, Cli: run.cli, DshHome: run.home, Host: run.host, Port: run.port });
// Generated fixture only; never read or print the user's local authentication URL.
const launchUrl = 'http://127.0.0.1:3080/?token=fixture-bootstrap-token-123456789';

async function fixture(body) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sidecar-desktop-state-'));
  const installation = join(root, 'Programs', 'DeepSeekHarness');
  await mkdir(installation, { recursive: true });
  const configPath = join(installation, 'launcher-config.json');
  const statePath = join(installation, 'runtime-state.json');
  await writeFile(configPath, JSON.stringify(config));
  try { await body({ root, installation, configPath, statePath }); }
  finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.split(/[\\/]/).at(-1).startsWith('dsh-sidecar-desktop-state-'));
    await rm(root, { recursive: true, force: true });
  }
}

test('desktop state ownership requires the same runtime, home and loopback port', () => {
  assert.equal(matchesDesktopLauncher(config, run), true);
  assert.equal(matchesDesktopLauncher({ ...config, Node: 'c:/runtime/node.exe' }, run), true);
  assert.equal(matchesDesktopLauncher({ ...config, DshHome: `${run.home}\\` }, run), true);
  for (const [field, value] of [ ['Node', 'C:\\Other\\node.exe'], ['Cli', 'C:\\Other\\bin.js'], ['DshHome', 'C:\\Other\\.dsh'], ['Host', 'localhost'], ['Port', 3082], ['Node', 'node.exe'] ]) {
    assert.equal(matchesDesktopLauncher({ ...config, [field]: value }, run), false, `${field} mismatch must not replace desktop state`);
  }
  assert.equal(matchesDesktopLauncher(config, { ...run, port: 3082 }), false);
  assert.equal(matchesDesktopLauncher(null, run), false);
});

test('discovery is opt-in to the matching Windows installation and leaves files untouched', async () => {
  await fixture(async ({ root, configPath, statePath }) => {
    const before = await readFile(configPath, 'utf8');
    const target = await findDesktopLauncher(run, { platform: 'win32', localAppData: root });
    assert.equal(target.statePath, statePath);
    assert.equal(await findDesktopLauncher(run, { platform: 'linux', localAppData: root }), null);
    assert.equal(await findDesktopLauncher({ ...run, home: 'C:\\Other\\.dsh' }, { platform: 'win32', localAppData: root }), null);
    assert.equal(await readFile(configPath, 'utf8'), before);
    await assert.rejects(readFile(statePath), error => error.code === 'ENOENT');
    await writeFile(configPath, '\uFEFF' + before);
    const withBom = await findDesktopLauncher(run, { platform: 'win32', localAppData: root });
    assert.equal(withBom.statePath, statePath);
    assert.equal(await saveDesktopRuntimeState(withBom, { pid: 12345, startedAt: 'fixture', launchUrl }), true);
    await writeFile(configPath, '{broken');
    assert.equal(await findDesktopLauncher(run, { platform: 'win32', localAppData: root }), null);
  });
});

test('only the official matching bootstrap announcement is accepted', () => {
  assert.equal(parseDshLaunchLine(`dsh web: ${launchUrl}`, run), launchUrl);
  for (const candidate of [
    'DSH Sidecar: http://127.0.0.1:3080',
    `prefix dsh web: ${launchUrl}`,
    `dsh web: ${launchUrl.replace(':3080', ':3082')}`,
    `dsh web: ${launchUrl.replace('127.0.0.1', 'example.com')}`,
    `dsh web: ${launchUrl.replace('http:', 'https:')}`,
    `dsh web: ${launchUrl.replace('127.0.0.1', 'user@127.0.0.1')}`,
    `dsh web: ${launchUrl}&extra=value`,
    `dsh web: ${launchUrl}&token=another-fixture-token`,
    `dsh web: ${launchUrl}#other`,
    'dsh web: http://127.0.0.1:3080/',
  ]) assert.equal(parseDshLaunchLine(candidate, run), null);
});

test('capture accepts fragmented CRLF output once and can finish without pipe EOF', () => {
  const accepted = [];
  const capture = createLaunchUrlCapture(run, url => accepted.push(url));
  const line = Buffer.from(`startup message\r\ndsh web: ${launchUrl}\r\nmore output\n`);
  for (let index = 0; index < line.length; index += 7) capture.write(line.subarray(index, index + 7));
  capture.write(Buffer.from(`dsh web: ${launchUrl}\n`));
  capture.finish();
  assert.deepEqual(accepted, [launchUrl]);
  const unterminated = [];
  const tail = createLaunchUrlCapture(run, url => unterminated.push(url));
  tail.write(`dsh web: ${launchUrl}`);
  assert.equal(unterminated.length, 0);
  tail.finish();
  assert.deepEqual(unterminated, [launchUrl]);
});

test('overlong output cannot masquerade as a new announcement after the buffer limit', () => {
  const accepted = [];
  const capture = createLaunchUrlCapture(run, url => accepted.push(url));
  capture.write('x'.repeat(9000));
  capture.write(`dsh web: ${launchUrl}\n`);
  assert.equal(accepted.length, 0);
  capture.write(`dsh web: ${launchUrl}\n`);
  assert.deepEqual(accepted, [launchUrl]);
});

test('publishing atomically replaces stale desktop state using the current child identity', async () => {
  await fixture(async ({ root, statePath, installation }) => {
    await writeFile(statePath, JSON.stringify({ pid: 10, launchUrl: 'obsolete-fixture' }));
    const target = await findDesktopLauncher(run, { platform: 'win32', localAppData: root });
    const startedAt = '2026-10-25T15:00:00.000Z';
    assert.equal(await saveDesktopRuntimeState(target, { pid: 12345, startedAt, launchUrl }), true);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), { pid: 12345, launchUrl, node: run.node, cli: run.cli, startedAt });
    assert.deepEqual((await readdir(installation)).sort(), ['launcher-config.json', 'runtime-state.json']);
  });
});

test('invalid child data or changed launcher settings cannot overwrite a previous state', async () => {
  await fixture(async ({ root, configPath, statePath }) => {
    const previous = '{"pid":10,"launchUrl":"obsolete-fixture"}';
    await writeFile(statePath, previous);
    const target = await findDesktopLauncher(run, { platform: 'win32', localAppData: root });
    for (const invalid of [{ pid: 0, launchUrl }, { pid: undefined, launchUrl }, { pid: 99, launchUrl: 'http://127.0.0.1:3080/' }]) {
      assert.equal(await saveDesktopRuntimeState(target, { startedAt: 'fixture', ...invalid }), false);
    }
    await writeFile(configPath, JSON.stringify({ ...config, DshHome: 'C:\\Other\\.dsh' }));
    assert.equal(await saveDesktopRuntimeState(target, { pid: 99, startedAt: 'fixture', launchUrl }), false);
    assert.equal(await readFile(statePath, 'utf8'), previous);
  });
});
