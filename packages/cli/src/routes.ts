import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostedAppOrigin } from '../../bridge/src/connection-options';

export type RouteKind = 'tailscale-https' | 'tailscale' | 'cloudflare' | 'local';
export type RouteChoice = 'auto' | 'tailscale' | 'cloudflare' | 'local';

/** How a phone reaches this computer. */
export interface Route {
  kind: RouteKind;
  /** The address the phone uses for the bridge. */
  publicUrl: string;
  /** Where the phone loads the app from. Equals publicUrl when the bridge serves it. */
  appUrl: string;
  listen: string[];
  allowOrigins: string[];
  tailnetHttp: boolean;
  /** False when the address changes on restart, so phones must pair again. */
  stable: boolean;
  notes: string[];
  tunnelPid?: number;
  servePort?: number;
}

function run(command: string, args: string[], timeoutMs = 8000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4_000_000 }, (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) }));
  });
}

async function findBinary(names: string[]): Promise<string | undefined> {
  for (const name of names) {
    if (name.includes('/') || name.includes('\\')) { if (existsSync(name)) return name; continue; }
    if ((await run(name, ['--version'], 4000)).ok) return name;
  }
  return undefined;
}

export interface TailscaleState { binary: string; dnsName: string; shortName: string; ip: string; magicDns: boolean; https: boolean }

export async function tailscaleState(): Promise<TailscaleState | undefined> {
  const binary = await findBinary(['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']);
  if (!binary) return undefined;
  const status = await run(binary, ['status', '--json']);
  if (!status.ok) return undefined;
  try {
    const value = JSON.parse(status.stdout) as { BackendState?: string; TailscaleIPs?: string[]; CertDomains?: string[] | null; CurrentTailnet?: { MagicDNSEnabled?: boolean }; Self?: { DNSName?: string; HostName?: string } };
    const ip = value.TailscaleIPs?.find(address => /^\d+\.\d+\.\d+\.\d+$/.test(address));
    const dnsName = value.Self?.DNSName?.replace(/\.$/, '') ?? '';
    if (value.BackendState !== 'Running' || !ip) return undefined;
    return { binary, dnsName, shortName: dnsName.split('.')[0] || value.Self?.HostName || '', ip, magicDns: value.CurrentTailnet?.MagicDNSEnabled === true && !!dnsName, https: !!value.CertDomains?.length && !!dnsName };
  } catch { return undefined; }
}

/** Tailscale's own HTTPS proxy: a stable, private address with a real certificate. */
async function tailscaleHttps(state: TailscaleState, port: number): Promise<Route | undefined> {
  const target = `http://127.0.0.1:${port}`;
  let existing: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> = {};
  const current = await run(state.binary, ['serve', 'status', '--json']);
  try { existing = (JSON.parse(current.stdout || '{}') as { Web?: typeof existing }).Web ?? {}; } catch { /* Treat as no configuration. */ }
  const taken = (httpsPort: number) => existing[`${state.dnsName}:${httpsPort}`]?.Handlers;
  const ours = (httpsPort: number) => taken(httpsPort)?.['/']?.Proxy === target;
  // Reuse our own entry; otherwise take the first port nobody else is serving on.
  const httpsPort = [443, 8443, 10000].find(ours) ?? [443, 8443, 10000].find(candidate => !taken(candidate));
  if (!httpsPort) return undefined;
  if (!ours(httpsPort)) {
    const started = await run(state.binary, ['serve', '--bg', '--yes', `--https=${httpsPort}`, target], 20_000);
    if (!started.ok) return undefined;
  }
  return {
    kind: 'tailscale-https', publicUrl: `https://${state.dnsName}${httpsPort === 443 ? '' : `:${httpsPort}`}`, appUrl: hostedAppOrigin,
    listen: [], allowOrigins: [], tailnetHttp: false, stable: true, servePort: httpsPort,
    notes: ['Your phone needs Tailscale connected to the same tailnet.'],
  };
}

function tailscaleDirect(state: TailscaleState, port: number, reason: string): Route {
  const names = [...new Set([state.magicDns ? state.dnsName : '', state.ip, state.magicDns ? state.shortName : ''].filter(Boolean))];
  const publicUrl = `http://${names[0]}:${port}`;
  return {
    kind: 'tailscale', publicUrl, appUrl: publicUrl, listen: [state.ip], allowOrigins: names.map(name => `http://${name}:${port}`),
    tailnetHttp: true, stable: true,
    notes: [
      'Your phone needs Tailscale connected to the same tailnet.',
      `${reason} Until then the phone uses Keep Safe straight from this computer over your tailnet. Notifications and Home Screen install need the HTTPS address.`,
    ],
  };
}

export async function stopTailscaleServe(servePort: number): Promise<void> {
  const state = await tailscaleState();
  if (state) await run(state.binary, ['serve', `--https=${servePort}`, 'off'], 10_000);
}

export async function cloudflaredBinary(directory: string): Promise<string | undefined> {
  return findBinary(['cloudflared', join(directory, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')]);
}

/** A free temporary tunnel. Its address changes on every start. */
async function cloudflare(binary: string, port: number, directory: string): Promise<Route | undefined> {
  const logFile = join(directory, 'tunnel.log');
  const log = openSync(logFile, 'w', 0o600);
  let pid: number | undefined;
  try {
    const child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.unref();
    pid = child.pid;
  } finally { closeSync(log); }
  if (!pid) return undefined;
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(await readFile(logFile, 'utf8').catch(() => ''));
    if (match) return {
      kind: 'cloudflare', publicUrl: match[0], appUrl: hostedAppOrigin, listen: [], allowOrigins: [], tailnetHttp: false, stable: false, tunnelPid: pid,
      notes: ['This is a temporary Cloudflare address. It changes whenever Keep Safe restarts, and phones pair again after that. Use Tailscale for an address that stays.'],
    };
  }
  try { process.kill(pid); } catch { /* Already gone. */ }
  return undefined;
}

function local(port: number, notes: string[]): Route {
  const publicUrl = `http://127.0.0.1:${port}`;
  return { kind: 'local', publicUrl, appUrl: publicUrl, listen: [], allowOrigins: [], tailnetHttp: false, stable: true, notes };
}

export async function chooseRoute(choice: RouteChoice, port: number, directory: string): Promise<Route> {
  if (choice === 'local') return local(port, ['Only this computer can open Keep Safe. Choose Tailscale or Cloudflare to reach it from a phone.']);
  if (choice === 'auto' || choice === 'tailscale') {
    const state = await tailscaleState();
    if (state) {
      if (state.https) {
        const route = await tailscaleHttps(state, port);
        if (route) return route;
        return tailscaleDirect(state, port, 'Tailscale Serve could not start. On Linux, run "sudo tailscale set --operator=$USER" once, then "keep-safe up --restart".');
      }
      return tailscaleDirect(state, port, 'Turn on HTTPS certificates for your tailnet (Tailscale admin console, DNS page), then run "keep-safe up --restart".');
    }
    if (choice === 'tailscale') throw new Error('Tailscale is not running on this computer. Install it from https://tailscale.com/download, sign in, then try again.');
  }
  const binary = await cloudflaredBinary(directory);
  if (binary) {
    const route = await cloudflare(binary, port, directory);
    if (route) return route;
    if (choice === 'cloudflare') throw new Error('The Cloudflare tunnel did not start. Check tunnel.log in the Keep Safe folder.');
  } else if (choice === 'cloudflare') throw new Error('cloudflared is not installed. See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
  return local(port, ['No way to reach this computer from a phone was found. Install Tailscale on this computer and your phone (free, https://tailscale.com/download), then run "keep-safe up --restart".']);
}
