import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The public address a phone uses when it is not on the computer's own network. */
export type TunnelState = 'starting' | 'ready' | 'failed';
export interface Tunnel { url(): string | undefined; state(): TunnelState; ready(timeoutMs: number): Promise<boolean>; stop(): void }
interface Stored { version: 1; pid: number; port: number; url: string; startedAt: string }

const addressPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const stateFile = (directory: string) => join(directory, 'tunnel.json');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };

/** A recorded process ID can belong to something else after a reboot. Only a
 * process that really is the tunnel program may be reused or stopped. */
function isTunnelProcess(pid: number): Promise<boolean> {
  if (!alive(pid)) return Promise.resolve(false);
  const [command, args] = process.platform === 'win32' ? ['tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']] : ['ps', ['-p', String(pid), '-o', 'args=']];
  return new Promise(resolve => {
    execFile(command, args as string[], { timeout: 4000, windowsHide: true }, (error, stdout) => resolve(!error && /cloudflared/i.test(String(stdout))));
  });
}

async function readStored(directory: string): Promise<Stored | undefined> {
  try {
    const value = JSON.parse(await readFile(stateFile(directory), 'utf8')) as Stored;
    return value?.version === 1 && Number.isInteger(value.pid) && Number.isInteger(value.port) && addressPattern.test(value.url) ? value : undefined;
  } catch { return undefined; }
}

/** Stops the tunnel a previous run left behind. Used by "keep-safe down". */
export async function stopTunnel(directory: string): Promise<void> {
  const stored = await readStored(directory);
  if (stored && await isTunnelProcess(stored.pid)) { try { process.kill(stored.pid); } catch { /* Already gone. */ } }
  await unlink(stateFile(directory)).catch(() => {});
}

async function reachable(url: string, attempts: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(4000), cache: 'no-store' });
      if (response.ok && (await response.json() as { ok?: boolean }).ok === true) return true;
    } catch { /* The address takes a few seconds to appear. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

export interface TunnelOptions {
  binary: string;
  port: number;
  directory: string;
  /** Skipped in tests, where the address is not real. */
  verify?: boolean;
  onAddress?: (url: string) => void;
}

/** Keeps one free Cloudflare quick tunnel alive for the bridge. The tunnel
 * process is detached on purpose: it outlives a bridge restart, so the phone's
 * address only changes when the computer restarts or the tunnel itself ends. */
export function startTunnel(options: TunnelOptions): Tunnel {
  const { binary, port, directory } = options;
  const verify = options.verify !== false;
  let url: string | undefined;
  let state: TunnelState = 'starting';
  let pid: number | undefined;
  let stopped = false;
  let failures = 0;
  let watch: ReturnType<typeof setTimeout> | undefined;
  const waiters = new Set<() => void>();
  const settle = (next: TunnelState, address?: string) => {
    state = next; url = address;
    if (address) options.onAddress?.(address);
    for (const waiter of [...waiters]) waiter();
  };

  async function launch(): Promise<boolean> {
    const logFile = join(directory, 'tunnel.log');
    const log = openSync(logFile, 'w', 0o600);
    try {
      const child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { detached: true, stdio: ['ignore', log, log], windowsHide: true });
      child.on('error', () => {});
      child.unref();
      pid = child.pid;
    } finally { closeSync(log); }
    if (!pid) return false;
    for (let attempt = 0; attempt < 80 && !stopped; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const match = addressPattern.exec(await readFile(logFile, 'utf8').catch(() => ''));
      if (match) {
        const stored: Stored = { version: 1, pid, port, url: match[0], startedAt: new Date().toISOString() };
        await writeFile(stateFile(directory), `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
        // Phones should not be sent to an address that does not answer yet.
        if (verify) await reachable(match[0], 25);
        if (stopped) return false;
        settle('ready', match[0]);
        return true;
      }
      if (!alive(pid)) break;
    }
    if (pid && alive(pid)) { try { process.kill(pid); } catch { /* Already gone. */ } }
    pid = undefined;
    return false;
  }

  async function start() {
    const stored = await readStored(directory);
    if (stored && stored.port === port && await isTunnelProcess(stored.pid) && (!verify || await reachable(stored.url, 4))) {
      pid = stored.pid;
      settle('ready', stored.url);
    } else {
      if (stored && await isTunnelProcess(stored.pid)) { try { process.kill(stored.pid); } catch { /* Already gone. */ } }
      await unlink(stateFile(directory)).catch(() => {});
      if (!await launch()) { failures++; settle('failed'); }
      else failures = 0;
    }
    schedule();
  }

  function schedule() {
    if (stopped) return;
    // A failed start is retried with growing pauses; a running tunnel is checked often.
    const delay = state === 'ready' ? 5000 : Math.min(120_000, 5000 * 2 ** Math.min(failures, 5));
    watch = setTimeout(() => {
      if (stopped) return;
      if (state === 'ready' && pid && alive(pid)) { schedule(); return; }
      settle('starting');
      void start().catch(() => { failures++; settle('failed'); schedule(); });
    }, delay);
    watch.unref();
  }

  void start().catch(() => { failures++; settle('failed'); schedule(); });
  return {
    url: () => url,
    state: () => state,
    ready(timeoutMs) {
      if (state !== 'starting') return Promise.resolve(state === 'ready');
      return new Promise(resolve => {
        const done = () => { if (state === 'starting') return; clearTimeout(timer); waiters.delete(done); resolve(state === 'ready'); };
        const timer = setTimeout(() => { waiters.delete(done); resolve(false); }, timeoutMs);
        timer.unref();
        waiters.add(done);
      });
    },
    // The tunnel process is left running so the address survives a restart.
    stop() { stopped = true; clearTimeout(watch); for (const waiter of [...waiters]) waiter(); },
  };
}
