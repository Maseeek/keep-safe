import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { readExistingConfig, type BridgeConfig } from '../../bridge/src/config';
import { stopTunnel } from '../../bridge/src/tunnel';
import { bridgeHealthy, localJson } from './local';
import { bridgeCli, packageRoot, tsxLoader } from './paths';
import { chooseRoute, stopTailscaleServe, type Route, type RouteChoice } from './routes';

export interface DaemonState { version: 1; pid: number; port: number; startedAt: string; route: Route; /** The Keep Safe release that started it. */ build?: string; /** The route the person asked for, kept across restarts. */ requested?: RouteChoice }
/** A background bridge from an older release is replaced on the next command. */
export const build = (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version;
export class CliError extends Error {}

const stateFile = (directory: string) => join(directory, 'daemon.json');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };

export async function readState(directory: string): Promise<DaemonState | undefined> {
  try {
    const value = JSON.parse(await readFile(stateFile(directory), 'utf8')) as DaemonState;
    return value?.version === 1 && Number.isInteger(value.pid) && Number.isInteger(value.port) && typeof value.route?.publicUrl === 'string' ? value : undefined;
  } catch { return undefined; }
}

export async function running(directory: string): Promise<DaemonState | undefined> {
  const state = await readState(directory);
  if (!state || !alive(state.pid) || !await bridgeHealthy(state.port)) return undefined;
  if (state.route.kind !== 'cloudflare') return state;
  // A tunnel address can change while the bridge runs: ask for the current one.
  const live = await bridgeStatus(directory, state.port);
  return { ...state, route: { ...state.route, publicUrl: live?.publicUrl ?? '' } };
}

/** A lock left by a crashed bridge on this computer is safe to clear once its process is gone. */
async function clearDeadLock(directory: string, port: number) {
  const file = join(directory, 'bridge.lock');
  try {
    const lock = JSON.parse(await readFile(file, 'utf8')) as { pid?: number; hostname?: string };
    if (typeof lock.pid === 'number' && lock.hostname === hostname() && !alive(lock.pid) && !await bridgeHealthy(port)) await unlink(file);
  } catch { /* No lock, or one that must be left for manual recovery. */ }
}

async function stopProcess(pid: number, patienceMs: number) {
  if (!alive(pid)) return true;
  try { process.kill(pid, 'SIGTERM'); } catch { return true; }
  for (let waited = 0; waited < patienceMs; waited += 200) {
    await new Promise(resolve => setTimeout(resolve, 200));
    if (!alive(pid)) return true;
  }
  return false;
}

export async function down(directory: string, options: { keepRoute?: boolean } = {}): Promise<boolean> {
  const state = await readState(directory);
  if (!state) return false;
  const stopped = await stopProcess(state.pid, 15_000);
  if (!stopped) throw new CliError('The bridge is still finishing a browser session. Try again in a moment.');
  if (!options.keepRoute) await stopTunnel(directory);
  if (state.route.servePort && !options.keepRoute) await stopTailscaleServe(state.route.servePort);
  await unlink(stateFile(directory)).catch(() => {});
  return true;
}

export interface UpOptions { directory: string; port?: number; route?: RouteChoice; restart?: boolean; allowLocalUrls?: boolean; log?: (line: string) => void }

/** Starts the bridge in the background, or returns the one already running. */
export async function up(options: UpOptions): Promise<{ state: DaemonState; started: boolean }> {
  const { directory } = options;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const previous = await readState(directory);
  const live = await running(directory);
  const sameSettings = live && live.build === build && (!options.port || options.port === live.port) && (!options.route || options.route === (live.requested ?? 'auto'));
  if (live && sameSettings && !options.restart) return { state: live, started: false };
  if (previous) await down(directory, { keepRoute: true });
  const port = options.port ?? previous?.port ?? Number(process.env.KEEP_SAFE_PORT ?? 4318);
  if (await bridgeHealthy(port)) throw new CliError(`Another Keep Safe bridge already uses port ${port}. Stop it first, or pick another port with --port.`);
  await clearDeadLock(directory, port);
  // Keep the previous kind of route across restarts unless asked to change.
  const preset = ['auto', 'tailscale', 'cloudflare', 'local'].includes(process.env.KEEP_SAFE_ROUTE ?? '') ? process.env.KEEP_SAFE_ROUTE as RouteChoice : undefined;
  const choice: RouteChoice = options.route ?? preset ?? previous?.requested ?? 'auto';
  const route = await chooseRoute(choice, port, directory, options.log);
  if (previous?.route.servePort && previous.route.servePort !== route.servePort) await stopTailscaleServe(previous.route.servePort);
  if (route.kind !== 'cloudflare') await stopTunnel(directory);
  const args = ['--import', tsxLoader(), bridgeCli, '--daemon', '--port', String(port), '--config-dir', directory, '--app-url', route.appUrl,
    ...(route.tunnelBinary ? ['--tunnel', route.tunnelBinary] : ['--public-url', route.publicUrl]),
    ...(route.listen.length ? ['--listen', route.listen.join(',')] : []),
    ...(route.allowOrigins.length ? ['--allow-origin', route.allowOrigins.join(',')] : []),
    ...(route.tailnetHttp ? ['--tailnet-http'] : []),
    ...(options.allowLocalUrls ? ['--allow-local-urls'] : [])];
  const logFile = join(directory, 'bridge.log');
  const log = openSync(logFile, 'w', 0o600);
  let pid: number | undefined;
  try {
    const child = spawn(process.execPath, args, { cwd: packageRoot, detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.unref();
    pid = child.pid;
  } finally { closeSync(log); }
  await chmod(logFile, 0o600).catch(() => {});
  if (!pid) throw new CliError('The bridge could not be started.');
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 200));
    if (await bridgeHealthy(port)) {
      if (route.kind === 'cloudflare') {
        // The tunnel opens a few seconds after the bridge. Wait for its address.
        for (let wait = 0; wait < 120 && alive(pid); wait++) {
          const live = await bridgeStatus(directory, port);
          if (live?.publicUrl) { route.publicUrl = live.publicUrl; break; }
          if (live?.link === 'failed') break;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (!route.publicUrl) route.notes = ['The secure link for the phone has not opened yet. Check the internet connection. Keep Safe keeps trying; run "keep-safe status" to see when it is ready.', ...route.notes];
      }
      const state: DaemonState = { version: 1, pid, port, startedAt: new Date().toISOString(), route, build, requested: choice };
      await writeFile(stateFile(directory), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      return { state, started: true };
    }
    if (!alive(pid)) break;
  }
  const reason = (await readFile(logFile, 'utf8').catch(() => '')).trim().split('\n').slice(-3).join(' ');
  if (alive(pid)) await stopProcess(pid, 5000);
  throw new CliError(`The bridge did not start. ${reason || 'Check that the port is free.'}`);
}

export async function ownerConfig(directory: string): Promise<BridgeConfig> {
  return readExistingConfig(directory);
}

export interface BridgeStatus { phones: number; notifications: number; browserAvailable: boolean; version?: string; link?: string; publicUrl?: string }
export async function bridgeStatus(directory: string, port: number): Promise<BridgeStatus | undefined> {
  try {
    const config = await ownerConfig(directory);
    const result = await localJson<BridgeStatus>(port, '/api/status', { token: config.agentToken });
    return result.status === 200 ? result.data : undefined;
  } catch { return undefined; }
}
