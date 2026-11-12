import { spawn } from 'node:child_process';
import type { PairingCode, PairingState } from '../../shared/src/protocol';
import { CliError, ownerConfig, type DaemonState } from './daemon';
import { localJson } from './local';

export interface Invitation { code: string; display: string; expiresAt: string; link: string; desktopUrl: string }

/** Asks the local bridge for a one-time code. The owner key stays on loopback. */
export async function invite(directory: string, state: DaemonState): Promise<Invitation> {
  const config = await ownerConfig(directory);
  const result = await localJson<PairingCode & { error?: string }>(state.port, '/api/pairing', { token: config.ownerToken, body: {} });
  if (result.status !== 201) throw new CliError(result.data.error ?? 'The bridge could not create a pairing code.');
  const { code, expiresAt } = result.data;
  const link = new URL(state.route.appUrl);
  // The phone already knows the bridge address when the bridge serves the app.
  link.hash = new URLSearchParams({ pair: code, ...(state.route.appUrl === state.route.publicUrl ? {} : { bridge: state.route.publicUrl }) }).toString();
  const desktop = new URL(`http://127.0.0.1:${state.port}/`);
  desktop.hash = new URLSearchParams({ desk: link.href }).toString();
  return { code, display: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt, link: link.href, desktopUrl: desktop.href };
}

export async function pairingState(state: DaemonState, code: string): Promise<{ state: PairingState; name?: string }> {
  const result = await localJson<{ state: PairingState; name?: string }>(state.port, '/api/pair/status', { body: { code } });
  return result.status === 200 ? result.data : { state: 'expired' };
}

export async function waitForPhone(state: DaemonState, invitation: Invitation, signal?: AbortSignal): Promise<{ state: PairingState; name?: string }> {
  while (!signal?.aborted && Date.now() < Date.parse(invitation.expiresAt)) {
    const current = await pairingState(state, invitation.code).catch(() => ({ state: 'waiting' as PairingState }));
    if (current.state !== 'waiting') return current;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  return { state: 'expired' };
}

/** Best effort: shows the QR page in the desktop browser. Never throws. */
export function openInBrowser(url: string): boolean {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url.replaceAll('&', '^&')]] : ['xdg-open', [url]];
  try {
    const child = spawn(command, args as string[], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}
