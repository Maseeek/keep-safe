import { connectionOrigin, hostedAppOrigin } from './connection-options';

export const quickTunnelDocs = 'https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const bridgeCommand = (args: string[]) => `npm run bridge -- ${args.map(quote).join(' ')}`;

/** Guidance only: no configuration reads, subprocesses, installations, or tunnel creation. */
export function connectionSetup(options: { port: number; configDirectory?: string; appUrl?: string; publicUrl?: string }) {
  const localOrigin = `http://127.0.0.1:${options.port}`;
  const appOrigin = connectionOrigin(options.appUrl ?? hostedAppOrigin);
  const publicOrigin = options.publicUrl ? connectionOrigin(options.publicUrl) : undefined;
  const shared = ['--port', String(options.port), '--app-url', appOrigin, ...(options.configDirectory ? ['--config-dir', options.configDirectory] : [])];
  const publicArgs = [...shared, '--public-url', publicOrigin ?? 'https://YOUR-TUNNEL.trycloudflare.com'];
  return {
    commands: {
      localStart: bridgeCommand(shared),
      tunnel: `cloudflared tunnel --url ${quote(localOrigin)}`,
      publicStart: bridgeCommand(publicArgs),
      doctor: bridgeCommand(['doctor', ...publicArgs]),
    },
    steps: [
      'Run commands from the Keep Safe repository on the computer whose browser the agent will use.',
      'Start the local bridge. If it is already running, check its port and keep its current keys.',
      'Choose your own HTTPS tunnel or private network. For a temporary development option, install cloudflared using the official guide, then run the tunnel command in a separate terminal. This helper installs and starts nothing.',
      `Keep the tunnel running. Copy its assigned HTTPS root origin. Stop the bridge with Ctrl+C in its terminal, then restart it with the public-start command. ${publicOrigin ? 'Confirm the supplied public origin matches the current tunnel address.' : 'Replace YOUR-TUNNEL with the actual address before running it.'}`,
      'Run the matching doctor command. Confirm the tunnel forwards to this computer’s loopback bridge. Open the bridge’s private pairing link on your phone, approve a test request and verify live control.',
    ],
    notes: [
      'Pairing links contain owner authority. Keep them private; diagnostic output contains no keys.',
      'Quick Tunnels are temporary development endpoints with no uptime guarantee; the hostname changes on restart. Update --public-url and pair again after an address change. The computer and tunnel must stay running.',
      'Tunnel login/protection pages can block cross-origin API or WebSocket requests. Diagnose the supported configuration before using real credentials.',
    ],
    documentation: quickTunnelDocs,
  };
}
