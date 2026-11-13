#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { isIP } from 'node:net';
import { ConfigError, loadConfig } from './config';
import { acquireConfigLock } from './config-lock';
import { rotateKeys, type KeyScope } from './key-rotation';
import { createBridge } from './server';
import { connectionOrigin, connectionPort, hostedAppOrigin } from './connection-options';
import { diagnoseConnection } from './doctor';
import { connectionSetup } from './setup';
import { RehearsalError, runRehearsal } from './rehearsal';
import { startTunnel, type Tunnel } from './tunnel';

class UsageError extends Error {}

function argumentsOf(args: string[], command: string) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const rotation = command === 'rotate-keys';
  const rehearsal = command === 'rehearse';
  const connection = command === 'doctor' || command === 'setup';
  const allowed = new Set(rotation ? ['--config-dir'] : rehearsal ? ['--port', '--config-dir'] : ['--port', '--config-dir', '--app-url', '--public-url', ...(connection ? [] : ['--static-dir', '--listen', '--allow-origin', '--name', '--tunnel'])]);
  const booleans = new Set(rotation ? ['--owner', '--agent', '--all', '--help'] : connection ? ['--json', '--help'] : rehearsal ? ['--help'] : ['--allow-local-urls', '--no-static', '--tailnet-http', '--daemon', '--help']);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (booleans.has(flag)) { flags.add(flag); continue; }
    if (!allowed.has(flag) || !args[index + 1] || args[index + 1].startsWith('--')) throw new UsageError('Unknown or missing option. Run npm run bridge -- --help for usage.');
    values.set(flag, args[++index]);
  }
  return { values, flags };
}

async function main() {
  const args = process.argv.slice(2);
  const command = ['rotate-keys', 'doctor', 'setup', 'rehearse'].includes(args[0]) ? args.shift()! : 'start';
  const { values, flags } = argumentsOf(args, command);
  if (flags.has('--help') && command === 'rehearse') {
    console.log('Usage: npm run --silent bridge -- rehearse [--port NUMBER] [--config-dir PATH]\n\nStart and pair your bridge first, then run this on the agent computer in another terminal.\nApprove Practice browser handoff on your phone, type only PRACTICE, choose Practice sign-in, then Done, hand back.\nThe request expires after five minutes. The check verifies synthetic sign-in after reload. It does not test a real account or physical push.\nOnly existing local agent authority is used. No keys, browser endpoints or typed values are printed.\nCtrl+C closes the practice browser; an unfinished request can remain until its original expiry.\nPort/configuration environment defaults match bridge startup. No tunnel or bridge is started by this command.');
    return;
  }
  if (flags.has('--help')) {
    console.log(`Keep Safe local browser bridge\n\nUsage: npm run bridge -- [options]\n\n--port NUMBER          Loopback port (default 4318; KEEP_SAFE_PORT)\n--config-dir PATH      Local keys directory (default .keep-safe; KEEP_SAFE_CONFIG_DIR)\n--public-url URL       HTTPS tunnel root origin (KEEP_SAFE_PUBLIC_URL)\n--app-url URL          Allowed frontend root origin (KEEP_SAFE_APP_URL)\n--static-dir PATH      Built frontend directory (default apps/web/dist)\n--no-static            Disable built frontend hosting\n--allow-local-urls     Allow explicit loopback HTTP test/development websites\n--listen ADDRESSES     Also listen on these private IP addresses, comma separated (for example a Tailscale IP)\n--allow-origin URLS    Further app origins allowed to call the bridge, comma separated\n--tailnet-http         Accept plain HTTP origins on Tailscale addresses (Tailscale encrypts that traffic)\n--name TEXT            Computer name shown on the phone (default: this computer's hostname)\n--tunnel PATH          Keep a free Cloudflare quick tunnel open with this cloudflared program, so any phone can reach the bridge\n--daemon               Print no pairing link; phones pair with one-time codes from "keep-safe pair"\n\nConnection help (same port/config/app/public options; optional --json):\n  npm run --silent bridge -- setup\n  npm run --silent bridge -- doctor --app-url https://keep-safe-eight.vercel.app --public-url https://YOUR-TUNNEL.trycloudflare.com\n  setup prints commands without reading keys or starting a tunnel.\n  doctor reads existing config without changing it; keys go only to local loopback.\n\nSynthetic phone rehearsal (start and pair the bridge first):\n  npm run --silent bridge -- rehearse [--port NUMBER] [--config-dir PATH]\n  Use only the fixed practice phrase, never real credentials.\n  Verify the returned practice browser after explicit handback.\n\nOffline key replacement (stop every bridge first):\n  npm run bridge -- rotate-keys --owner|--agent|--all [--config-dir PATH]\n  --owner replaces the owner key and revokes remembered phones and notifications.\n  --agent replaces the agent key; restart connected MCP clients after rotation.\n  --all performs both. No keys are printed by this command.\n\nThe bridge binds only to 127.0.0.1. Use a trusted HTTPS tunnel to reach it from a phone.\nKeep pairing links private. Passwords, browser frames and cookies are never written by the bridge.\nCompleted managed browsers stay available to the agent until the request expiry time.`);
    return;
  }
  const configDirectory = resolve(values.get('--config-dir') ?? process.env.KEEP_SAFE_CONFIG_DIR ?? '.keep-safe');
  if (command === 'rotate-keys') {
    const scopes = ['owner', 'agent', 'all'].filter(scope => flags.has(`--${scope}`));
    if (scopes.length !== 1) throw new UsageError('Choose exactly one rotation scope: --owner, --agent, or --all.');
    try { await rotateKeys(configDirectory, scopes[0] as KeyScope); }
    catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new UsageError('Key rotation could not be confirmed. Keep the bridge stopped and check local files and permissions. Some phones may already have been revoked.');
    }
    console.log(scopes[0] === 'agent'
      ? 'Agent key replaced. Restart the bridge and connected MCP clients to load it.'
      : `${scopes[0] === 'all' ? 'Owner and agent keys' : 'Owner key'} replaced. Remembered phones and notifications revoked. Restart the bridge and pair phones with its new private link.${scopes[0] === 'all' ? ' Restart connected MCP clients too.' : ''}`);
    return;
  }
  const port = connectionPort(values.get('--port') ?? process.env.KEEP_SAFE_PORT ?? '4318');
  if (command === 'rehearse') {
    const controller = new AbortController();
    let interrupted = 0;
    const stop = (code: number) => {
      if (interrupted) return;
      interrupted = code;
      console.log('Stopping practice. Waiting for browser cleanup.');
      controller.abort();
    };
    const interrupt = () => stop(130);
    const terminate = () => stop(143);
    const hangup = () => stop(129);
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate); process.on('SIGHUP', hangup);
    try {
      const result = await runRehearsal({ configDirectory, port, signal: controller.signal, log: message => console.log(message) });
      console.log(result === 'passed'
        ? 'Practice handoff verified. The returned browser stayed signed in after reload.'
        : result === 'cancelled' ? 'Practice stopped.' : `Practice ${result === 'timed-out' ? 'timed out' : result}. The login/resume check did not complete.`);
      process.exitCode = interrupted || (result === 'passed' ? 0 : 1);
    } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.off('SIGHUP', hangup); }
    return;
  }
  const selectedPublicUrl = values.get('--public-url') ?? process.env.KEEP_SAFE_PUBLIC_URL;
  const tailnetHttp = flags.has('--tailnet-http');
  const publicUrl = connectionOrigin(selectedPublicUrl ?? `http://127.0.0.1:${port}`, { tailnetHttp });
  const appUrl = connectionOrigin(values.get('--app-url') ?? process.env.KEEP_SAFE_APP_URL ?? (command === 'setup' || (selectedPublicUrl && publicUrl.startsWith('https:')) ? hostedAppOrigin : publicUrl), { tailnetHttp });
  const listed = (flag: string) => (values.get(flag) ?? '').split(',').map(item => item.trim()).filter(Boolean);
  const extraOrigins = listed('--allow-origin').map(item => connectionOrigin(item, { tailnetHttp }));
  const listenHosts = listed('--listen');
  if (listenHosts.some(host => !isIP(host))) throw new UsageError('--listen takes IP addresses of this computer, comma separated.');
  if (command === 'setup') {
    const report = connectionSetup({ port, configDirectory, appUrl, publicUrl: selectedPublicUrl ? publicUrl : undefined });
    if (flags.has('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Keep Safe phone connection setup\n\n${report.steps.map((step, index) => `${index + 1}. ${step}`).join('\n\n')}\n\nLocal start:\n${report.commands.localStart}\n\nOptional temporary tunnel (separate terminal):\n${report.commands.tunnel}\n\nRestart with your tunnel origin:\n${report.commands.publicStart}\n\nCheck the connection:\n${report.commands.doctor}\n\n${report.notes.join('\n\n')}\n\nOfficial tunnel guide: ${report.documentation}`);
    }
    return;
  }
  if (command === 'doctor') {
    const report = await diagnoseConnection({ port, configDirectory, appUrl, publicUrl: selectedPublicUrl ? publicUrl : undefined });
    if (flags.has('--json')) console.log(JSON.stringify(report, null, 2));
    else console.log(`Keep Safe connection diagnostics\n\n${report.checks.map(check => `${check.status.toUpperCase()}  ${check.label}: ${check.message}`).join('\n')}\n\n${report.notes.join('\n\n')}`);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  const lock = await acquireConfigLock(configDirectory, 'bridge');
  let tunnel: Tunnel | undefined;
  let bridge: Awaited<ReturnType<typeof createBridge>>;
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(configDirectory);
    if (values.get('--tunnel')) tunnel = startTunnel({ binary: values.get('--tunnel')!, port, directory: configDirectory, verify: process.env.KEEP_SAFE_TUNNEL_CHECK !== 'off', onAddress: address => console.log(`Phone address: ${address}`) });
    bridge = await createBridge({
      ...config, port, appUrl, publicUrl,
      subscriptionsFile: join(configDirectory, 'subscriptions.json'),
      devicesFile: join(configDirectory, 'devices.json'),
      staticDir: flags.has('--no-static') ? undefined : values.get('--static-dir') ? resolve(values.get('--static-dir')!) : fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)),
      allowLocalUrls: flags.has('--allow-local-urls'),
      listenHosts, extraOrigins,
      computerName: values.get('--name') ?? hostname(),
      ...(tunnel ? { link: tunnel } : {}),
    });
  } catch (error) { tunnel?.stop(); await lock.release(); throw error; }
  const pairing = new URL(appUrl);
  pairing.hash = new URLSearchParams({ bridge: publicUrl, token: config.ownerToken }).toString();
  const unreachable = listenHosts.filter(host => !bridge.listening.includes(host));
  if (unreachable.length) console.error(`Could not listen on ${unreachable.join(', ')}. The bridge is still available on this computer.`);
  // A background bridge writes to a log file, so it never prints owner authority.
  if (flags.has('--daemon')) console.log(`Keep Safe bridge listening at ${bridge.url}\n${tunnel ? 'Opening a secure link for the phone.' : `Phone address: ${publicUrl}`}\nBrowser installed: ${bridge.info.browserAvailable ? 'yes' : 'no'}`);
  else console.log(`Keep Safe bridge listening at ${bridge.url}\nPair your phone (private owner link):\n${pairing.href}\n\nAgent credentials are in ${join(configDirectory, 'config.json')}. Do not share them.\nBrowser installed: ${bridge.info.browserAvailable ? 'yes' : 'no — run npx playwright install chromium'}\nPhone notifications: ${bridge.info.pushEnabled ? 'available after pairing' : 'disabled'}`);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    tunnel?.stop();
    void bridge.close().then(() => lock.release()).then(() => process.exit(0)).catch(() => {
      console.error('Bridge cleanup did not finish. Check that it stopped, then follow README lock recovery instructions.');
      process.exit(1);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(error => { console.error(error instanceof UsageError || error instanceof ConfigError || error instanceof RehearsalError ? error.message : 'Keep Safe could not start. Check the options, port availability, and local configuration. Use --help for setup.'); process.exitCode = 1; });
