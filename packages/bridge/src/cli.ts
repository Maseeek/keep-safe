#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { loadConfig } from './config';
import { createBridge } from './server';

function argumentsOf(args: string[]) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const allowed = new Set(['--port', '--config-dir', '--app-url', '--public-url', '--static-dir']);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (['--allow-local-urls', '--no-static', '--help'].includes(flag)) { flags.add(flag); continue; }
    if (!allowed.has(flag) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Unknown or missing option: ${flag}. Run with --help.`);
    values.set(flag, args[++index]);
  }
  return { values, flags };
}

async function main() {
  const { values, flags } = argumentsOf(process.argv.slice(2));
  if (flags.has('--help')) {
    console.log(`Keep Safe local browser bridge\n\nUsage: npm run bridge -- [options]\n\n--port NUMBER          Loopback port (default 4318; KEEP_SAFE_PORT)\n--config-dir PATH      Local keys directory (default .keep-safe; KEEP_SAFE_CONFIG_DIR)\n--public-url URL       HTTPS tunnel address for phone connections (KEEP_SAFE_PUBLIC_URL)\n--app-url URL          Allowed frontend URL and pairing page (KEEP_SAFE_APP_URL)\n--static-dir PATH      Built frontend directory (default apps/web/dist)\n--no-static            Disable built frontend hosting\n--allow-local-urls     Allow explicit loopback HTTP test/development websites\n\nThe bridge binds only to 127.0.0.1. Use a trusted HTTPS tunnel to reach it from a phone.\nKeep pairing links private. Passwords, browser frames and cookies are never written by the bridge.\nCompleted managed browsers stay available to the agent until the request expiry time.`);
    return;
  }
  const port = Number(values.get('--port') ?? process.env.KEEP_SAFE_PORT ?? '4318');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  const configDirectory = resolve(values.get('--config-dir') ?? process.env.KEEP_SAFE_CONFIG_DIR ?? '.keep-safe');
  const publicUrl = values.get('--public-url') ?? process.env.KEEP_SAFE_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
  const appUrl = values.get('--app-url') ?? process.env.KEEP_SAFE_APP_URL ?? publicUrl;
  for (const value of [publicUrl, appUrl]) {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search || !['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Public and app URLs must use HTTPS (or local HTTP for development), without credentials, query or fragment.');
  }
  const config = await loadConfig(configDirectory);
  const bridge = await createBridge({
    ...config, port, appUrl, publicUrl,
    subscriptionsFile: join(configDirectory, 'subscriptions.json'),
    staticDir: flags.has('--no-static') ? undefined : resolve(values.get('--static-dir') ?? 'apps/web/dist'),
    allowLocalUrls: flags.has('--allow-local-urls'),
  });
  const pairing = new URL(appUrl);
  pairing.hash = new URLSearchParams({ bridge: publicUrl, token: config.ownerToken }).toString();
  console.log(`Keep Safe bridge listening at ${bridge.url}\nPair your phone (private owner link):\n${pairing.href}\n\nAgent credentials are in ${join(configDirectory, 'config.json')}. Do not share them.\nBrowser installed: ${bridge.info.browserAvailable ? 'yes' : 'no — run npx playwright install chromium'}\nPhone notifications: ${bridge.info.pushEnabled ? 'available after pairing' : 'disabled'}`);
  let stopping = false;
  const shutdown = () => { if (stopping) return; stopping = true; void bridge.close().then(() => process.exit(0)); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(() => { console.error('Keep Safe could not start. Check the options, port availability, and local configuration. Use --help for setup.'); process.exitCode = 1; });
