import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSidecarInstallation } from './install.mjs';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const supportedDshVersion = '0.1.2-rc.1';

export function pluginLoadMode(installation, entryName) {
  if (installation.count > 1) throw new Error('Multiple persistent Sidecar entries were found. Repair the web profile before starting.');
  if (installation.installed) {
    if (installation.entryName !== entryName) throw new Error('A different Sidecar checkout is installed in DSH. Use that checkout or uninstall it before switching.');
    return 'profile';
  }
  if (installation.overrideCount) throw new Error('The DSH profile targets Sidecar without installing it. Resolve that profile entry before starting.');
  return 'overlay';
}

export function assertNodeVersion(version = process.versions.node) {
  const major = Number(String(version).replace(/^v/, '').split('.')[0]);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Node.js 22 or later is required; found ${version}. Use a supported Node installation or the Windows launcher.`);
  }
}

export function parseArgs(args) {
  const result = { port: 3082, workspace: projectRoot, doctor: false, open: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--doctor') result.doctor = true;
    else if (arg === '--open') result.open = true;
    else if (['--port', '--workspace', '--dsh-cli'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--port') result.port = Number(value);
      if (arg === '--workspace') result.workspace = resolve(value);
      if (arg === '--dsh-cli') result.cli = resolve(value);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(result.port) || result.port < 1024 || result.port > 65535) {
    throw new Error('Port must be an integer between 1024 and 65535.');
  }
  return result;
}

export async function findDsh(explicit, env = process.env) {
  const candidates = [explicit, env.DSH_SIDECAR_CLI,
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs/DeepSeekHarness/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    join(projectRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    join(homedir(), '.local/share/deepseek-harness/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      const metadata = JSON.parse(await readFile(resolve(dirname(candidate), '../package.json'), 'utf8'));
      if (metadata.name !== '@deepseek-ai/dsh') continue;
      if (metadata.version !== supportedDshVersion) throw Object.assign(new Error(
        `DSH ${metadata.version} is not the supported ${supportedDshVersion}. Use --dsh-cli with a matching runtime; this launcher does not upgrade DSH.`), { code: 'VERSION_MISMATCH' });
      return { cli: resolve(candidate), version: metadata.version };
    } catch (error) {
      if (error.code === 'VERSION_MISMATCH') throw error;
      if (candidate === explicit || candidate === env.DSH_SIDECAR_CLI) throw new Error(`Invalid DSH CLI path: ${candidate}`);
    }
  }
  throw new Error('DSH 0.1.2-rc.1 was not found. Set DSH_SIDECAR_CLI or pass --dsh-cli PATH/TO/@deepseek-ai/dsh/lib/bin.js.');
}

async function requireFreePort(port) {
  await new Promise((done, fail) => {
    const server = createServer();
    server.once('error', () => fail(new Error(`127.0.0.1:${port} is already in use. Open the running instance or choose --port.`)));
    server.listen(port, '127.0.0.1', () => server.close(done));
  });
}

export async function start(args = process.argv.slice(2)) {
  assertNodeVersion();
  const options = parseArgs(args);
  const runtime = await findDsh(options.cli);
  await access(options.workspace);
  const home = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
  const entryName = pathToFileURL(join(projectRoot, 'lib/index.js')).href;
  const pluginMode = pluginLoadMode(await readSidecarInstallation(home), entryName);
  if (options.doctor) {
    console.log(JSON.stringify({ node: process.version, dsh: runtime.version, cli: runtime.cli,
      workspace: options.workspace, dshHome: home, pluginMode, url: `http://127.0.0.1:${options.port}`,
      credentialHandling: 'Existing DSH configuration; Sidecar does not read or copy API keys.' }, null, 2));
    return;
  }
  await access(join(projectRoot, 'lib/index.js')).catch(() => { throw new Error('Run npm install and npm run build first.'); });
  await requireFreePort(options.port);
  const stateRoot = join(projectRoot, '.local');
  await mkdir(stateRoot, { recursive: true });
  const patch = join(stateRoot, `sidecar-${options.port}.patch.json`);
  const command = [runtime.cli, '--profile', 'web'];
  if (pluginMode === 'overlay') {
    await writeFile(patch, JSON.stringify([{ insert: [{ id: 'dsh-sidecar', name: entryName,
      config: { dataDir: join(stateRoot, 'state'), defaultCwd: options.workspace } }] }], null, 2));
    command.push('--patch', patch);
  }
  command.push('--host', '127.0.0.1', '--port', String(options.port));
  if (!options.open) command.push('--no-open');
  console.log(`DSH Sidecar: http://127.0.0.1:${options.port}\nWorkspace: ${options.workspace}\nUsing DSH ${runtime.version}; plugin source: ${pluginMode}.`);
  const child = spawn(process.execPath, command, {
    cwd: options.workspace, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, DSH_HOME: home, DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || 'workspace-write' },
  });
  await writeFile(join(stateRoot, `process-${options.port}.json`), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), url: `http://127.0.0.1:${options.port}`, workspace: options.workspace }, null, 2));
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise((done, fail) => {
    child.once('error', fail);
    child.once('exit', (code) => { process.exitCode = code ?? 0; done(); });
  });
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  start().catch(error => { console.error(error.message); process.exitCode = 1; });
}
