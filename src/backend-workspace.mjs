import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const FILE_LIMIT = 512 * 1024;
const OUTPUT_LIMIT = 256 * 1024;
const IGNORED = new Set(['.git', 'node_modules', 'venv', '.venv', '__pycache__', '.ssh', '.aws', '.azure', '.gnupg', '.codex', '.dsh']);
export function failure(code, message) { return Object.assign(new Error(message), { code }); }
export function sensitiveName(name) {
  return IGNORED.has(name.toLowerCase()) || /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|_netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?)$/i.test(name)
    || /\.(?:pem|key|p12|pfx|kdbx)$/i.test(name);
}
const inside = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };

async function resolveSafe(root, input = '.') {
  if (typeof input !== 'string' || input.length > 4096 || input.includes('\0') || path.isAbsolute(input) || /[:]/.test(input)
    || input.split(/[\\/]/).includes('..')) throw failure('invalid-path', 'Only workspace-relative paths without parent traversal are allowed.');
  if (input.split(/[\\/]/).some(sensitiveName)) throw failure('restricted-file', 'Credential and internal paths are excluded.');
  const canonicalRoot = await fs.realpath(root);
  const requested = path.resolve(canonicalRoot, input);
  if (!inside(canonicalRoot, requested)) throw failure('path-outside-workspace', 'Path escapes this workspace.');
  const real = await fs.realpath(requested);
  if (!inside(canonicalRoot, real)) throw failure('path-outside-workspace', 'Symlink or junction escapes this workspace.');
  if (path.relative(canonicalRoot, real).split(path.sep).some(sensitiveName)) throw failure('restricted-file', 'Credential and internal paths are excluded.');
  return { root: canonicalRoot, real, relative: path.relative(canonicalRoot, requested).split(path.sep).join('/') || '.' };
}

export async function listFiles(root, input) {
  const safe = await resolveSafe(root, input);
  const entries = [];
  for (const item of (await fs.readdir(safe.real, { withFileTypes: true })).slice(0, 3000)) {
    if (sensitiveName(item.name)) continue;
    const childPath = path.join(safe.relative === '.' ? '' : safe.relative, item.name);
    try {
      const child = await resolveSafe(safe.root, childPath);
      const stat = await fs.stat(child.real);
      if (!stat.isFile() && !stat.isDirectory()) continue;
      entries.push({ name: item.name, path: child.relative, type: stat.isDirectory() ? 'directory' : 'file', size: stat.size });
    } catch (error) { if (error.code !== 'ENOENT' && !['restricted-file', 'path-outside-workspace'].includes(error.code)) throw error; }
  }
  entries.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
  return { path: safe.relative, entries };
}

export async function readFile(root, input) {
  const safe = await resolveSafe(root, input);
  const handle = await fs.open(safe.real, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw failure('not-file', 'Select a regular text file.');
    const buffer = Buffer.alloc(Math.min(stat.size, FILE_LIMIT) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, Math.min(bytesRead, FILE_LIMIT));
    const again = await resolveSafe(root, input);
    if (again.real !== safe.real) throw failure('file-changed', 'The file path changed while reading.');
    if (bytes.includes(0)) throw failure('not-text', 'Binary files are not shown in the text viewer.');
    let text;
    // A final UTF-8 code point may cross the bounded read; TextDecoder streaming retains it safely.
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: stat.size > FILE_LIMIT }); }
    catch { throw failure('not-text', 'This viewer accepts UTF-8 text files.'); }
    if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/.test(text)) throw failure('restricted-file', 'Private key material is excluded.');
    return { path: safe.relative, text, sha256: createHash('sha256').update(Buffer.from(text)).digest('hex'), truncated: stat.size > FILE_LIMIT || bytesRead > FILE_LIMIT, hashScope: 'returned-text' };
  } finally { await handle.close(); }
}

async function shell() {
  if (process.platform !== 'win32') return { executable: '/bin/bash', args: ['-lc'], name: 'bash' };
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, 'pwsh.exe');
    try { if ((await fs.stat(candidate)).isFile()) return { executable: candidate, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'], name: 'pwsh' }; } catch {}
  }
  return { executable: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'], name: 'powershell' };
}

export function createTerminalManager() {
  const jobs = new Map();
  let closed = false;
  function owned(mainId, id) {
    const job = jobs.get(id);
    if (!job || job.mainId !== mainId) throw failure('job-not-found', 'No command job belongs to this main session with that ID.');
    return job;
  }
  async function stop(job, reason) {
    if (!job.running || job.stopping) return;
    job.stopping = true;
    job.reason = reason;
    if (!job.child.pid) return;
    if (process.platform === 'win32') {
      try {
        await new Promise((resolve, reject) => {
          const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(job.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', reject);
          killer.once('exit', code => code === 0 || !job.running ? resolve() : reject(failure('cancel-failed', 'Could not stop this command process tree.')));
        });
      } catch (error) { job.stopping = false; throw error; }
    } else {
      try { process.kill(-job.child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      const force = setTimeout(() => { if (job.running) { try { process.kill(-job.child.pid, 'SIGKILL'); } catch {} } }, 1000);
      force.unref();
    }
  }
  return {
    async run(mainId, root, command) {
      if (closed) throw failure('disposed', 'Command manager is closed.');
      if (typeof command !== 'string' || !command.trim() || command.length > 32000 || command.includes('\0')) throw failure('invalid-command', 'Command must be nonempty text of at most 32000 characters.');
      if ([...jobs.values()].filter(j => j.running).length >= 8) throw failure('too-many-jobs', 'Stop an existing command before starting another.');
      const cwd = await fs.realpath(root);
      const selected = await shell();
      if (closed) throw failure('disposed', 'Command manager is closed.');
      const shellCommand = process.platform === 'win32'
        ? '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding;\n' + command
        : command;
      const child = spawn(selected.executable, [...selected.args, shellCommand], { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      const job = { id: randomUUID(), mainId, command, output: '', running: true, exitCode: null, cwd, child, shell: selected.name, pty: false, bytes: 0, truncated: false, reason: null };
      jobs.set(job.id, job);
      function append(text) {
        const value = Buffer.from(text);
        const remaining = OUTPUT_LIMIT - job.bytes;
        if (remaining <= 0) { job.truncated = true; return; }
        const clipped = value.subarray(0, remaining);
        job.output += new TextDecoder().decode(clipped, { stream: true });
        job.bytes += clipped.length;
        if (clipped.length !== value.length) job.truncated = true;
      }
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder('utf8');
        stream.on('data', chunk => append(decoder.write(chunk)));
        stream.on('end', () => append(decoder.end()));
      }
      const timer = setTimeout(() => { void stop(job, 'timeout').catch(() => {}); }, 120000);
      timer.unref();
      child.once('error', error => { append(`\nCommand launch failed: ${error.message}`); job.running = false; job.reason = 'launch-error'; clearTimeout(timer); });
      child.once('close', (code, signal) => { job.running = false; job.exitCode = code; job.signal = signal; clearTimeout(timer); });
      // Retain a bounded set of completed jobs while preserving every live child.
      for (const [id, old] of jobs) { if (jobs.size <= 100) break; if (!old.running) jobs.delete(id); }
      return { id: job.id };
    },
    get(mainId, id) {
      const { command, output, running, exitCode, cwd, shell, pty, truncated, reason, signal } = owned(mainId, id);
      return { id, command, output, running, exitCode, cwd, shell, pty, truncated, reason, signal: signal ?? null };
    },
    async cancel(mainId, id) { await stop(owned(mainId, id), 'cancelled'); return { accepted: true }; },
    async dispose() { closed = true; await Promise.allSettled([...jobs.values()].map(job => stop(job, 'disposed'))); },
  };
}
