import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const sameWindowsPath = (left, right) => typeof left === 'string' && typeof right === 'string'
  && win32.isAbsolute(left) && win32.isAbsolute(right)
  && win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();

/** A desktop launcher may only discover the exact runtime and home it owns. */
export function matchesDesktopLauncher(config, run) {
  return Boolean(config && run && run.host === '127.0.0.1' && run.port === 3080
    && config.Host === run.host && config.Port === run.port
    && sameWindowsPath(config.Node, run.node)
    && sameWindowsPath(config.Cli, run.cli)
    && sameWindowsPath(config.DshHome, run.home));
}

export async function findDesktopLauncher(run, { platform = process.platform, localAppData = process.env.LOCALAPPDATA } = {}) {
  if (platform !== 'win32' || !localAppData || run.port !== 3080) return null;
  const root = join(localAppData, 'Programs', 'DeepSeekHarness');
  const configPath = join(root, 'launcher-config.json');
  try {
    const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
    return matchesDesktopLauncher(config, run) ? { configPath, statePath: join(root, 'runtime-state.json'), run } : null;
  } catch { return null; }
}

/** Accept only DSH's startup announcement for this exact local authority. */
export function parseDshLaunchLine(line, run) {
  const match = /^dsh web: (http:\/\/\S+)\s*$/.exec(line);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    const tokens = url.searchParams.getAll('token');
    if (url.protocol !== 'http:' || url.hostname !== run.host || Number(url.port) !== run.port
      || url.username || url.password || url.pathname !== '/' || url.hash
      || [...url.searchParams.keys()].some(key => key !== 'token') || tokens.length !== 1
      || !/^[A-Za-z0-9_-]{16,512}$/.test(tokens[0])) return null;
    return url.href;
  } catch { return null; }
}

/** Bounded incremental scan; finish is explicit and never waits for pipe EOF. */
export function createLaunchUrlCapture(run, accept) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let dropping = false;
  let captured = false;
  const finishLine = () => {
    if (!dropping && !captured) {
      const url = parseDshLaunchLine(pending.replace(/\r$/, ''), run);
      if (url) { captured = true; accept(url); }
    }
    pending = ''; dropping = false;
  };
  const consume = text => {
    const parts = text.split('\n');
    for (let index = 0; index < parts.length; index++) {
      if (!dropping) {
        pending += parts[index];
        if (pending.length > 8192) { pending = ''; dropping = true; }
      }
      if (index < parts.length - 1) finishLine();
    }
  };
  return {
    write(chunk) { if (!captured) consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))); },
    finish() { if (!captured) { consume(decoder.end()); finishLine(); } },
  };
}

/** Atomically publish one matching child; never print its bootstrap URL. */
export async function saveDesktopRuntimeState(target, { pid, startedAt, launchUrl }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !parseDshLaunchLine(`dsh web: ${launchUrl}`, target.run)) return false;
  // Recheck before replacing state in case installation settings changed at boot.
  const config = JSON.parse((await readFile(target.configPath, 'utf8')).replace(/^\uFEFF/, ''));
  if (!matchesDesktopLauncher(config, target.run)) return false;
  const temporary = `${target.statePath}.${pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ pid, launchUrl, node: target.run.node, cli: target.run.cli, startedAt }, null, 2), { mode: 0o600 });
    await rename(temporary, target.statePath);
    return true;
  } finally { await unlink(temporary).catch(() => {}); }
}
