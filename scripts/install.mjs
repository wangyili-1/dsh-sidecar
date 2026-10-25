import { access, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMap, isSeq, parseDocument } from 'yaml';

export const sidecarId = 'dsh-sidecar';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jsTag = { tag: 'tag:yaml.org,2002:js', resolve: value => value };

export function profilePatchPath(home) {
  return join(resolve(home), 'profiles', 'web', 'cordis.patch.yml');
}

function parsePatch(source) {
  const document = parseDocument(source, { customTags: [jsTag], uniqueKeys: true });
  // Parser diagnostics may quote arbitrary config values. Never expose them.
  if (document.errors.length || document.warnings.length || !isSeq(document.contents)) {
    throw new Error('The web profile patch must be a valid YAML array with supported DSH tags; it was not changed.');
  }
  if (document.contents.items.some(item => !isMap(item))) {
    throw new Error('Every web profile patch entry must be a mapping; the file was not changed.');
  }
  return document;
}

function findSidecar(document) {
  const entries = [];
  const overrides = [];
  const visitEntries = sequence => {
    if (!isSeq(sequence)) return;
    for (const entry of sequence.items) {
      if (!isMap(entry)) continue;
      if (entry.get('id') === sidecarId) entries.push({ sequence, entry });
      if (entry.get('group') === true) visitEntries(entry.get('config', true));
    }
  };
  for (const patch of document.contents.items) {
    if (patch.get('id') === sidecarId) overrides.push(patch);
    visitEntries(patch.get('insert', true));
  }
  return { entries, overrides };
}

async function readPatch(patchPath) {
  try {
    const info = await lstat(patchPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('The web profile patch must be a regular file.');
    return { source: await readFile(patchPath, 'utf8'), exists: true, mode: info.mode };
  } catch (error) {
    if (error.code === 'ENOENT') return { source: '[]\n', exists: false, mode: 0o600 };
    throw error;
  }
}

/** Inspect only plugin identities; credentials and other config values are never returned or evaluated. */
export async function readSidecarInstallation(home) {
  const patchPath = profilePatchPath(home);
  const original = await readPatch(patchPath);
  const { entries, overrides } = findSidecar(parsePatch(original.source));
  const entryName = entries.length === 1 ? entries[0].entry.get('name') : undefined;
  return {
    installed: entries.length > 0,
    count: entries.length,
    overrideCount: overrides.length,
    patchPath,
    entryName: typeof entryName === 'string' ? entryName : undefined,
  };
}

async function writeExclusive(filename, content, mode) {
  const handle = await open(filename, 'wx', mode);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function commitPatch(patchPath, original, next) {
  const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const backupPath = original.exists ? `${patchPath}.sidecar-backup-${suffix}` : undefined;
  const temporaryPath = `${patchPath}.sidecar-new-${suffix}`;
  if (backupPath) await writeExclusive(backupPath, original.source, original.mode);
  try {
    await writeExclusive(temporaryPath, next, original.mode);
    const current = await readPatch(patchPath);
    if (current.exists !== original.exists || current.source !== original.source) {
      throw new Error('The web profile patch changed during installation; no changes were applied. Run the command again.');
    }
    await rename(temporaryPath, patchPath);
  } finally {
    await unlink(temporaryPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return backupPath;
}

async function editProfile(home, operation) {
  const patchPath = profilePatchPath(home);
  await mkdir(dirname(patchPath), { recursive: true });
  const lockPath = `${patchPath}.sidecar-install.lock`;
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another Sidecar install operation holds the profile lock.');
    throw error;
  }
  try {
    const original = await readPatch(patchPath);
    const document = parsePatch(original.source);
    const changed = operation(document);
    if (!changed) return { changed: false, patchPath };
    const next = document.toString({ lineWidth: 0 });
    parsePatch(next);
    const backupPath = await commitPatch(patchPath, original, next);
    return { changed: true, patchPath, backupPath };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

/** Add a persistent web-profile entry. Existing Sidecar settings are preserved on repeat installs. */
export async function installDesktopPlugin({ home, project = projectRoot, workspace = project, dataDir = join(project, '.local', 'state') }) {
  const entryName = pathToFileURL(resolve(project, 'lib', 'index.js')).href;
  await access(fileURLToPath(entryName));
  if (!(await lstat(resolve(workspace))).isDirectory()) throw new Error('The Sidecar workspace must be a directory.');
  return editProfile(home, document => {
    const { entries, overrides } = findSidecar(document);
    if (entries.length > 1) throw new Error('The web profile contains duplicate Sidecar entries; it was not changed.');
    if (entries.length === 1) {
      if (entries[0].entry.get('name') !== entryName) {
        throw new Error('A different plugin path already uses the dsh-sidecar ID. Uninstall it before installing this checkout.');
      }
      return false;
    }
    if (overrides.length) throw new Error('The web profile already targets dsh-sidecar without inserting it; it was not changed.');
    document.contents.add(document.createNode({ insert: [{
      id: sidecarId,
      name: entryName,
      config: { dataDir: resolve(dataDir), defaultCwd: resolve(workspace) },
    }] }));
    return true;
  });
}

/** Remove only this plugin's insert rows and ID-targeted overrides; retain all other profile entries. */
export async function uninstallDesktopPlugin({ home }) {
  const patchPath = profilePatchPath(home);
  if (!(await readPatch(patchPath)).exists) return { changed: false, patchPath };
  return editProfile(home, document => {
    const { entries, overrides } = findSidecar(document);
    if (!entries.length && !overrides.length) return false;
    for (const { sequence, entry } of entries) sequence.items.splice(sequence.items.indexOf(entry), 1);
    const removedOverrides = new Set(overrides);
    document.contents.items = document.contents.items.filter(patch => {
      if (removedOverrides.has(patch)) return false;
      const insert = patch.get('insert', true);
      // An emptied insert patch no longer contributes anything. Preserve any other fields.
      return !(isSeq(insert) && insert.items.length === 0 && patch.items.length === 1);
    });
    return true;
  });
}

export function parseInstallArgs(args, env = process.env) {
  args = [...args];
  const result = { action: 'install', home: resolve(env.DSH_HOME || join(homedir(), '.dsh')), workspace: projectRoot };
  if (args[0] && !args[0].startsWith('--')) result.action = args.shift();
  if (!['install', 'uninstall', 'status'].includes(result.action)) throw new Error('Use install, uninstall, or status.');
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--dsh-home', '--workspace', '--dsh-cli', '--data-dir'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    result[{ '--dsh-home': 'home', '--workspace': 'workspace', '--dsh-cli': 'cli', '--data-dir': 'dataDir' }[flag]] = resolve(value);
  }
  return result;
}

export async function installCommand(args = process.argv.slice(2)) {
  const options = parseInstallArgs([...args]);
  const { assertNodeVersion, findDsh } = await import('./start.mjs');
  assertNodeVersion();
  await findDsh(options.cli);
  if (options.action === 'status') {
    const status = await readSidecarInstallation(options.home);
    console.log(JSON.stringify({ installed: status.installed, count: status.count, profilePatch: status.patchPath }, null, 2));
    return status;
  }
  const result = options.action === 'install'
    ? await installDesktopPlugin(options)
    : await uninstallDesktopPlugin(options);
  console.log(`${result.changed ? (options.action === 'install' ? 'Installed' : 'Uninstalled') : 'No changes needed'}: DSH Sidecar\nProfile patch: ${result.patchPath}`);
  if (result.backupPath) console.log(`Original patch backup: ${result.backupPath}`);
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  installCommand().catch(error => { console.error(error.message); process.exitCode = 1; });
}
