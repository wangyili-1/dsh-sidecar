import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import { installDesktopPlugin, uninstallDesktopPlugin, readSidecarInstallation, profilePatchPath, parseInstallArgs } from '../scripts/install.mjs';

async function fixture(t, source = '# Original user comment\n[]\n') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sidecar-installer-'));
  const home = join(root, 'home');
  const project = join(root, 'plugin with spaces');
  const workspace = join(root, 'user workspace');
  const patchPath = profilePatchPath(home);
  await mkdir(join(project, 'lib'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(project, 'lib', 'index.js'), '// Test fixture; never executed.\n');
  if (source !== null) {
    await mkdir(dirname(patchPath), { recursive: true });
    await writeFile(patchPath, source);
  }
  // A credentials fixture verifies that the installer never changes that file.
  await mkdir(home, { recursive: true });
  const credentialsPath = join(home, '.credentials.yaml');
  await writeFile(credentialsPath, 'fixture-only: keep-exactly\n');
  t.after(async () => {
    assert.equal(await readFile(credentialsPath, 'utf8'), 'fixture-only: keep-exactly\n');
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.split(/[\\/]/).at(-1).startsWith('dsh-sidecar-installer-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, home, project, workspace, patchPath };
}

const load = text => parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] }).toJS();

test('persistent installation backs up the exact original and preserves settings on repeat', async t => {
  const original = '# Original user comment\n[]\n';
  const f = await fixture(t, original);
  const installed = await installDesktopPlugin(f);
  assert.equal(installed.changed, true);
  assert.equal(await readFile(installed.backupPath, 'utf8'), original);
  const once = await readFile(f.patchPath, 'utf8');
  assert.match(once, /Original user comment/);
  assert.deepEqual(load(once), [{ insert: [{
    id: 'dsh-sidecar', name: pathToFileURL(join(f.project, 'lib', 'index.js')).href,
    config: { dataDir: join(f.project, '.local', 'state'), defaultCwd: f.workspace },
  }] }]);
  const status = await readSidecarInstallation(f.home);
  assert.equal(status.installed, true);
  assert.equal(status.count, 1);
  const second = await installDesktopPlugin({ ...f, workspace: f.project });
  assert.equal(second.changed, false);
  assert.equal(await readFile(f.patchPath, 'utf8'), once);
  assert.equal((await readdir(dirname(f.patchPath))).filter(name => name.includes('.sidecar-backup-')).length, 1);
});

test('installation creates a missing profile patch and uninstall is idempotent', async t => {
  const f = await fixture(t, null);
  assert.deepEqual(await uninstallDesktopPlugin(f), { changed: false, patchPath: f.patchPath });
  const installed = await installDesktopPlugin(f);
  assert.equal(installed.changed, true);
  assert.equal(installed.backupPath, undefined);
  assert.equal((await readSidecarInstallation(f.home)).installed, true);
  const removed = await uninstallDesktopPlugin(f);
  assert.equal(removed.changed, true);
  assert.equal((await readSidecarInstallation(f.home)).installed, false);
  assert.equal((await uninstallDesktopPlugin(f)).changed, false);
});

test('unrelated overrides, comments and DSH !!js expressions survive install and uninstall', async t => {
  const original = '# Keep this comment\n- id: existing-plugin\n  config:\n    expression: !!js process.env.FIXTURE_ONLY\n    url: https://example.invalid/value\n- insert:\n    - id: another-plugin\n      name: ./another/index.js\n      config: { preserved: yes }\n';
  const f = await fixture(t, original);
  await installDesktopPlugin(f);
  const installed = await readFile(f.patchPath, 'utf8');
  assert.match(installed, /!!js/);
  assert.match(installed, /Keep this comment/);
  assert.deepEqual(load(installed).slice(0, 2), load(original));
  const removed = await uninstallDesktopPlugin(f);
  assert.equal(await readFile(removed.backupPath, 'utf8'), installed);
  assert.deepEqual(load(await readFile(f.patchPath, 'utf8')), load(original));
});

test('uninstall removes only matching rows from shared insert lists and own overrides', async t => {
  const f = await fixture(t, '- insert:\n    - { id: keep, name: keep-package }\n    - { id: dsh-sidecar, name: old-package }\n- id: keep\n  disabled: false\n- id: dsh-sidecar\n  disabled: true\n');
  await uninstallDesktopPlugin(f);
  assert.deepEqual(load(await readFile(f.patchPath, 'utf8')), [
    { insert: [{ id: 'keep', name: 'keep-package' }] }, { id: 'keep', disabled: false },
  ]);
});

test('installer refuses duplicate IDs and conflicting plugin paths without modifying the patch', async t => {
  for (const source of [
    '- insert: [{ id: dsh-sidecar, name: first }, { id: dsh-sidecar, name: second }]\n',
    '- insert: [{ id: dsh-sidecar, name: another-checkout }]\n',
    '- id: dsh-sidecar\n  disabled: true\n',
  ]) {
    const f = await fixture(t, source);
    await assert.rejects(installDesktopPlugin(f), /duplicate|different plugin path|without inserting/);
    assert.equal(await readFile(f.patchPath, 'utf8'), source);
    assert.deepEqual(await readdir(dirname(f.patchPath)), ['cordis.patch.yml']);
  }
});

test('malformed patches and unsupported tags fail without echoing private config snippets', async t => {
  for (const source of [
    'fixture-private-value: [broken\n',
    '- { config: !unrecognized fixture-private-value }\n',
    'not-an-array: fixture-private-value\n',
    '- fixture-private-value\n',
  ]) {
    const f = await fixture(t, source);
    await assert.rejects(installDesktopPlugin(f), error => {
      assert.doesNotMatch(error.message, /fixture-private-value/);
      return /valid YAML array|must be a mapping/.test(error.message);
    });
    assert.equal(await readFile(f.patchPath, 'utf8'), source);
  }
});

test('status finds nested group entries and does not return arbitrary plugin configuration', async t => {
  const f = await fixture(t, '- insert:\n    - id: group\n      group: true\n      config:\n        - id: dsh-sidecar\n          name: sidecar-package\n          disabled: true\n          config: { fixture-private-value: hidden }\n');
  const status = await readSidecarInstallation(f.home);
  assert.equal(status.installed, true);
  assert.equal(status.count, 1);
  assert.equal(status.entryName, 'sidecar-package');
  assert.doesNotMatch(JSON.stringify(status), /fixture-private-value|hidden/);
  await uninstallDesktopPlugin(f);
  assert.deepEqual(load(await readFile(f.patchPath, 'utf8')), [{ insert: [{ id: 'group', group: true, config: [] }] }]);
});

test('installer command arguments support a separate home and reject ambiguous input', () => {
  const value = parseInstallArgs(['status', '--dsh-home', './test home'], {});
  assert.equal(value.action, 'status');
  assert.equal(value.home, resolve('./test home'));
  assert.throws(() => parseInstallArgs(['--dsh-home']), /Missing value/);
  assert.throws(() => parseInstallArgs(['upgrade']), /install, uninstall, or status/);
  assert.throws(() => parseInstallArgs(['--force']), /Unknown option/);
});
