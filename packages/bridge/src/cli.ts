#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { ConfigError, loadConfig } from './config';
import { acquireConfigLock } from './config-lock';
import { rotateKeys, type KeyScope } from './key-rotation';
import { createBridge } from './server';

class UsageError extends Error {}

function argumentsOf(args: string[], rotation: boolean) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const allowed = new Set(rotation ? ['--config-dir'] : ['--port', '--config-dir', '--app-url', '--public-url', '--static-dir']);
  const booleans = new Set(rotation ? ['--owner', '--agent', '--all', '--help'] : ['--allow-local-urls', '--no-static', '--help']);
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
  const rotation = args[0] === 'rotate-keys';
  const { values, flags } = argumentsOf(rotation ? args.slice(1) : args, rotation);
  if (flags.has('--help')) {
    console.log(`Keep Safe local browser bridge\n\nUsage: npm run bridge -- [options]\n\n--port NUMBER          Loopback port (default 4318; KEEP_SAFE_PORT)\n--config-dir PATH      Local keys directory (default .keep-safe; KEEP_SAFE_CONFIG_DIR)\n--public-url URL       HTTPS tunnel address for phone connections (KEEP_SAFE_PUBLIC_URL)\n--app-url URL          Allowed frontend URL and pairing page (KEEP_SAFE_APP_URL)\n--static-dir PATH      Built frontend directory (default apps/web/dist)\n--no-static            Disable built frontend hosting\n--allow-local-urls     Allow explicit loopback HTTP test/development websites\n\nOffline key replacement (stop every bridge first):\n  npm run bridge -- rotate-keys --owner|--agent|--all [--config-dir PATH]\n  --owner replaces the owner key and revokes remembered phones and notifications.\n  --agent replaces the agent key; restart connected MCP clients after rotation.\n  --all performs both. No keys are printed by this command.\n\nThe bridge binds only to 127.0.0.1. Use a trusted HTTPS tunnel to reach it from a phone.\nKeep pairing links private. Passwords, browser frames and cookies are never written by the bridge.\nCompleted managed browsers stay available to the agent until the request expiry time.`);
    return;
  }
  const configDirectory = resolve(values.get('--config-dir') ?? process.env.KEEP_SAFE_CONFIG_DIR ?? '.keep-safe');
  if (rotation) {
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
  const port = Number(values.get('--port') ?? process.env.KEEP_SAFE_PORT ?? '4318');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError('Port must be between 1 and 65535.');
  const publicUrl = values.get('--public-url') ?? process.env.KEEP_SAFE_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
  const appUrl = values.get('--app-url') ?? process.env.KEEP_SAFE_APP_URL ?? publicUrl;
  for (const value of [publicUrl, appUrl]) {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search || !['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new UsageError('Public and app URLs must use HTTPS (or local HTTP for development), without credentials, query or fragment.');
  }
  const lock = await acquireConfigLock(configDirectory, 'bridge');
  let bridge: Awaited<ReturnType<typeof createBridge>>;
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(configDirectory);
    bridge = await createBridge({
      ...config, port, appUrl, publicUrl,
      subscriptionsFile: join(configDirectory, 'subscriptions.json'),
      devicesFile: join(configDirectory, 'devices.json'),
      staticDir: flags.has('--no-static') ? undefined : resolve(values.get('--static-dir') ?? 'apps/web/dist'),
      allowLocalUrls: flags.has('--allow-local-urls'),
    });
  } catch (error) { await lock.release(); throw error; }
  const pairing = new URL(appUrl);
  pairing.hash = new URLSearchParams({ bridge: publicUrl, token: config.ownerToken }).toString();
  console.log(`Keep Safe bridge listening at ${bridge.url}\nPair your phone (private owner link):\n${pairing.href}\n\nAgent credentials are in ${join(configDirectory, 'config.json')}. Do not share them.\nBrowser installed: ${bridge.info.browserAvailable ? 'yes' : 'no — run npx playwright install chromium'}\nPhone notifications: ${bridge.info.pushEnabled ? 'available after pairing' : 'disabled'}`);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void bridge.close().then(() => lock.release()).then(() => process.exit(0)).catch(() => {
      console.error('Bridge cleanup did not finish. Check that it stopped, then follow README lock recovery instructions.');
      process.exit(1);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(error => { console.error(error instanceof UsageError || error instanceof ConfigError ? error.message : 'Keep Safe could not start. Check the options, port availability, and local configuration. Use --help for setup.'); process.exitCode = 1; });
