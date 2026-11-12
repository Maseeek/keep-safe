import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { browserAvailable } from '../../bridge/src/browser';
import { ConfigError } from '../../bridge/src/config';
import { connectionPort } from '../../bridge/src/connection-options';
import { BridgeClient } from '../../mcp/src/client';
import { createMcpServer, type LoginClient } from '../../mcp/src/server';
import { mcpSnippet, registerAgents, type Registration } from './agents';
import { bridgeStatus, CliError, down, ownerConfig, readState, running, up, type DaemonState } from './daemon';
import { invite, openInBrowser, waitForPhone, type Invitation } from './pairing';
import { bridgeCli, configDirectory, tsxLoader } from './paths';
import { terminalQr } from './qr';
import type { RouteChoice } from './routes';

const help = `Keep Safe: sign in to websites for your coding agents, from your phone.

Usage: keep-safe <command> [options]

Getting started
  setup            Install the browser, start Keep Safe, add it to your agents, and show a pairing QR code
  pair             Show a new QR code to pair a phone (or another phone)

Running
  up               Start Keep Safe in the background (also happens automatically)
  down             Stop it
  status           Show whether it is running, the phone address and paired phones
  mcp              Run the MCP server for an agent (starts Keep Safe if needed)

Checks
  doctor           Diagnose the connection
  rehearse         Practise a handoff with a harmless test page
  rotate-keys      Replace keys (stop Keep Safe first)

Options
  --route auto|tailscale|cloudflare|local   How your phone reaches this computer (default auto)
  --port NUMBER          Local port (default 4318)
  --config-dir PATH      Where keys and state live (default ~/.keep-safe)
  --restart              Restart even if already running
  --no-open              Do not open the QR page in a desktop browser
  --no-wait              Print the QR code and return without waiting for the phone
  --no-agents            setup: do not register the MCP server with agent CLIs
  --agents LIST          setup: only these agent CLIs (claude,codex)
  --json                 Machine-readable output

Tailscale is used when it is running: private, encrypted, and the address never changes.
Docs: https://github.com/Maseeek/keep-safe#readme`;

const valued = new Set(['--route', '--port', '--config-dir', '--agents']);
const switches = new Set(['--restart', '--no-open', '--no-wait', '--no-agents', '--json', '--allow-local-urls', '--help', '-h']);

function parse(args: string[]) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (switches.has(flag)) flags.add(flag);
    else if (valued.has(flag) && args[index + 1] && !args[index + 1].startsWith('--')) values.set(flag, args[++index]);
    else throw new CliError(`Unknown or incomplete option ${flag}. Run keep-safe help.`);
  }
  const route = values.get('--route');
  if (route && !['auto', 'tailscale', 'cloudflare', 'local'].includes(route)) throw new CliError('Choose a route: auto, tailscale, cloudflare or local.');
  return {
    directory: configDirectory(values.get('--config-dir')),
    port: values.has('--port') ? connectionPort(values.get('--port')!) : undefined,
    route: route as RouteChoice | undefined,
    agents: values.get('--agents')?.split(',').map(item => item.trim()).filter(Boolean),
    flags,
  };
}
type Options = ReturnType<typeof parse>;

const routeLabel = (state: DaemonState) => ({
  'tailscale-https': 'Tailscale (private, HTTPS)', tailscale: 'Tailscale (private)', cloudflare: 'Cloudflare temporary tunnel', local: 'this computer only',
})[state.route.kind];

async function ensureBrowser(log: (line: string) => void): Promise<boolean> {
  if (await browserAvailable()) return true;
  log('Installing the Chromium browser Keep Safe drives (one time, about 150 MB)...');
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
  const code = await new Promise<number>(resolve => {
    // Installer output goes to stderr so --json output stays clean.
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: ['ignore', 2, 2] });
    child.on('error', () => resolve(1));
    child.on('exit', status => resolve(status ?? 1));
  });
  return code === 0 && browserAvailable();
}

function printInvitation(invitation: Invitation, state: DaemonState, opened: boolean) {
  const minutes = Math.max(1, Math.round((Date.parse(invitation.expiresAt) - Date.now()) / 60_000));
  console.log(`\nPair your phone\n\n${terminalQr(invitation.link)}\n`);
  console.log(`  Scan the QR code with your phone camera, or open this link on the phone:\n  ${invitation.link}\n`);
  console.log(`  Pairing code: ${invitation.display}   (single use, valid ${minutes} minutes)`);
  if (state.route.appUrl !== state.route.publicUrl) console.log(`  Typing it in instead? Computer address: ${state.route.publicUrl}`);
  if (opened) console.log('\n  The same QR code is open in a browser window on this computer.');
  else console.log(`\n  To show the QR code in a browser on this computer, open:\n  ${invitation.desktopUrl}`);
}

async function pairFlow(options: Options, state: DaemonState, wait: boolean) {
  const invitation = await invite(options.directory, state);
  const opened = !options.flags.has('--no-open') && openInBrowser(invitation.desktopUrl);
  if (options.flags.has('--json')) return { invitation, opened };
  printInvitation(invitation, state, opened);
  if (wait) {
    console.log('\nWaiting for your phone... (Ctrl+C to stop waiting; the code stays valid)');
    const result = await waitForPhone(state, invitation);
    console.log(result.state === 'claimed' ? `\nPaired: ${result.name ?? 'your phone'}. You can close this.` : '\nThe code expired before a phone used it. Run keep-safe pair for a new one.');
  }
  return { invitation, opened };
}

function agentLine(result: Registration) {
  return `${result.agent}: ${result.status === 'added' ? 'added' : result.status === 'present' ? 'already set up' : result.status === 'missing' ? 'not installed' : `could not be added${result.detail ? ` (${result.detail})` : ''}`}`;
}

async function setup(options: Options) {
  const json = options.flags.has('--json');
  const say = (line: string) => { if (!json) console.log(line); };
  const browser = await ensureBrowser(line => (json ? console.error(line) : console.log(line)));
  const { state, started } = await up({ directory: options.directory, port: options.port, route: options.route, restart: options.flags.has('--restart'), allowLocalUrls: options.flags.has('--allow-local-urls') });
  say(`Keep Safe ${started ? 'is now running' : 'was already running'} in the background.\n`);
  say(`  Phone address   ${state.route.publicUrl}   (${routeLabel(state)})`);
  if (!browser) say('  Browser         Chromium could not be installed. Run: npx playwright install chromium');
  const agents = options.flags.has('--no-agents') ? [] : await registerAgents(options.directory, options.agents);
  if (agents.length) say(`  Agents          ${agents.map(agentLine).join(' · ')}`);
  const snippet = await mcpSnippet(options.directory);
  const status = await bridgeStatus(options.directory, state.port);
  const { invitation, opened } = await pairFlow(options, state, false);
  if (json) { console.log(JSON.stringify({ running: true, started, port: state.port, route: state.route, browser, agents, phones: status?.phones ?? 0, invitation, opened, mcp: JSON.parse(snippet) }, null, 2)); return; }
  for (const note of state.route.notes) console.log(`\n  Note: ${note}`);
  console.log(`\nOther MCP clients (Cursor, T3 Code, Antigravity and so on) can use this configuration:\n${snippet}`);
  console.log('\nNext: scan the QR code. Then ask an agent to "use Keep Safe to sign in to a website" to try it, or run: keep-safe rehearse');
  console.log('If you are an AI agent running this for someone: show them the link and pairing code above, or point them at the browser window with the QR code.');
}

async function status(options: Options) {
  const state = await running(options.directory);
  const phones = state ? await bridgeStatus(options.directory, state.port) : undefined;
  if (options.flags.has('--json')) { console.log(JSON.stringify({ running: !!state, ...(state ? { port: state.port, route: state.route, startedAt: state.startedAt, ...phones } : {}) }, null, 2)); return; }
  if (!state) { console.log('Keep Safe is not running. Start it with: keep-safe up'); return; }
  console.log(`Keep Safe is running (since ${new Date(state.startedAt).toLocaleString()}).\n\n  Phone address   ${state.route.publicUrl}   (${routeLabel(state)})\n  Local address   http://127.0.0.1:${state.port}\n  Paired phones   ${phones?.phones ?? 'unknown'}${phones && !phones.phones ? '   (run keep-safe pair)' : ''}\n  Notifications   ${phones ? `${phones.notifications} phone${phones.notifications === 1 ? '' : 's'}` : 'unknown'}\n  Browser         ${phones?.browserAvailable === false ? 'missing (run keep-safe setup)' : 'ready'}`);
  for (const note of state.route.notes) console.log(`\n  Note: ${note}`);
}

/** Tools keep working after a reboot: the first call that finds no bridge starts one. */
async function mcp(options: Options) {
  const start = async () => {
    const { state } = await up({ directory: options.directory, port: options.port });
    const config = await ownerConfig(options.directory);
    return new BridgeClient({ url: `http://127.0.0.1:${state.port}`, token: config.agentToken });
  };
  let client: BridgeClient | undefined;
  let starting: Promise<BridgeClient> | undefined;
  const ready = async (fresh = false) => {
    if (fresh) client = undefined;
    if (client) return client;
    starting ??= start().finally(() => { starting = undefined; });
    client = await starting;
    return client;
  };
  const attempt = async <T>(call: (bridge: BridgeClient) => Promise<T>): Promise<T> => {
    try { return await call(await ready()); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('Cannot reach')) throw error;
      return call(await ready(true));
    }
  };
  const login: LoginClient = {
    create: input => attempt(bridge => bridge.create(input)),
    get: id => attempt(bridge => bridge.get(id)),
    wait: (id, seconds, signal) => attempt(bridge => bridge.wait(id, seconds, signal)),
    status: () => attempt(bridge => bridge.status()),
  };
  void ready().catch(error => process.stderr.write(`Keep Safe: ${error instanceof Error ? error.message : 'could not start the bridge.'}\n`));
  await createMcpServer(login).connect(new StdioServerTransport());
}

async function passThrough(command: string, rest: string[], directory: string) {
  const state = await readState(directory);
  const has = (flag: string) => rest.includes(flag);
  const args = [command, ...rest,
    ...(has('--config-dir') ? [] : ['--config-dir', directory]),
    ...(command !== 'rotate-keys' && !has('--port') && state ? ['--port', String(state.port)] : []),
    ...(command === 'doctor' && state && state.route.publicUrl.startsWith('https:') && !has('--public-url') ? ['--public-url', state.route.publicUrl, ...(has('--app-url') ? [] : ['--app-url', state.route.appUrl])] : [])];
  const child = spawn(process.execPath, ['--import', tsxLoader(), bridgeCli, ...args], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => { child.kill(signal); });
  process.exitCode = await new Promise<number>(resolve => child.on('exit', code => resolve(code ?? 1)));
}

async function main() {
  const [command = 'connect', ...rest] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command) || rest.includes('--help') && !['doctor', 'rehearse', 'rotate-keys'].includes(command)) { console.log(help); return; }
  if (['doctor', 'rehearse', 'rotate-keys'].includes(command)) {
    const index = rest.indexOf('--config-dir');
    await passThrough(command, rest, configDirectory(index >= 0 ? rest[index + 1] : undefined));
    return;
  }
  const options = parse(command.startsWith('--') ? [command, ...rest] : rest);
  const json = options.flags.has('--json');
  const startOptions = { directory: options.directory, port: options.port, route: options.route, restart: options.flags.has('--restart'), allowLocalUrls: options.flags.has('--allow-local-urls') };
  switch (command.startsWith('--') ? 'connect' : command) {
    case 'setup': await setup(options); return;
    case 'mcp': await mcp(options); return;
    case 'status': await status(options); return;
    case 'down': {
      const stopped = await down(options.directory);
      console.log(json ? JSON.stringify({ stopped }) : stopped ? 'Keep Safe stopped.' : 'Keep Safe was not running.');
      return;
    }
    case 'up': {
      const { state, started } = await up(startOptions);
      if (json) { console.log(JSON.stringify({ running: true, started, port: state.port, route: state.route }, null, 2)); return; }
      console.log(`Keep Safe ${started ? 'is now running' : 'was already running'} in the background.\n\n  Phone address   ${state.route.publicUrl}   (${routeLabel(state)})`);
      for (const note of state.route.notes) console.log(`\n  Note: ${note}`);
      console.log('\nPair a phone with: keep-safe pair');
      return;
    }
    case 'pair': case 'connect': {
      const { state, started } = await up(startOptions);
      if (!json && started) console.log(`Keep Safe is now running in the background. Phone address: ${state.route.publicUrl} (${routeLabel(state)})`);
      const result = await pairFlow(options, state, !options.flags.has('--no-wait') && !json && process.stdout.isTTY === true);
      if (json) console.log(JSON.stringify({ running: true, started, port: state.port, route: state.route, ...result }, null, 2));
      else for (const note of state.route.notes) console.log(`\n  Note: ${note}`);
      return;
    }
    default: throw new CliError(`Unknown command ${command}. Run keep-safe help.`);
  }
}

main().catch(error => {
  console.error(error instanceof CliError || error instanceof ConfigError ? error.message : `Keep Safe could not finish: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
