import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '../packages/bridge/src/config';
import { createBridge } from '../packages/bridge/src/server';
import type { LoginRequest } from '../packages/shared/src/protocol';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'keep-safe-rehearsal-cli-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
function launch(args: string[]) {
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('packages/bridge/src/cli.ts'), 'rehearse', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, KEEP_SAFE_PORT: '4318', KEEP_SAFE_CONFIG_DIR: '' },
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  cleanup.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
    try { await exit; } finally { clearTimeout(timer); }
  });
  return { child, exit, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

it('requires existing configuration and never initializes keys or a lock', async () => {
  const path = await directory(); const absent = join(path, 'absent');
  const run = launch(['--config-dir', absent, '--port', '4318']);
  expect(await run.exit).toBe(1);
  expect(run.stderr).toContain('Existing bridge configuration could not be read');
  expect(await readdir(path)).toEqual([]);
  expect(run.stdout).not.toContain('token');
});

it.each(['--allow-local-urls', '--public-url', '--json'])('rejects %s rather than changing the rehearsal boundary', async flag => {
  const path = await directory(); const run = launch(['--config-dir', path, flag, 'synthetic-private-value']);
  expect(await run.exit).toBe(1);
  expect(run.stderr).toContain('Unknown or missing option');
  expect(run.stdout + run.stderr).not.toContain('synthetic-private-value');
  expect(await readdir(path)).toEqual([]);
});

it.each(['deny', 'expire', 'interrupt', 'terminate', 'hangup'] as const)('closes the real practice browser after %s without owner API authority or configuration changes', async action => {
  const path = await directory(); const config = await loadConfig(path);
  const before = await readFile(join(path, 'config.json'), 'utf8');
  let clock = Date.now();
  const bridge = await createBridge({ ...config, port: 0, now: () => clock }); cleanup.push(() => bridge.close());
  const agentCalls: Array<{ method: string; path: string }> = [];
  bridge.server.prependListener('request', request => {
    if (request.headers.authorization === `Bearer ${config.agentToken}`) agentCalls.push({ method: request.method!, path: request.url! });
  });
  const run = launch(['--port', String(bridge.port), '--config-dir', path]);
  let item: LoginRequest | undefined;
  await expect.poll(async () => {
    const response = await fetch(bridge.url + '/api/requests', { headers: { Authorization: `Bearer ${config.ownerToken}` } });
    item = (await response.json()).requests[0]; return !!item;
  }, { timeout: 15_000 }).toBe(true);
  expect(item!.title).toBe('Practice browser handoff');
  expect(item!.url).toBe('https://practice.keep-safe.invalid/login');
  if (action === 'deny') {
    expect((await fetch(`${bridge.url}/api/requests/${item!.id}/deny`, { method: 'POST', headers: { Authorization: `Bearer ${config.ownerToken}` } })).status).toBe(200);
  } else if (action === 'expire') clock += 301_000;
  else run.child.kill(action === 'interrupt' ? 'SIGINT' : action === 'terminate' ? 'SIGTERM' : 'SIGHUP');
  expect(await run.exit).toBe(action === 'interrupt' ? 130 : action === 'terminate' ? 143 : action === 'hangup' ? 129 : 1);
  expect(run.stdout).toContain('practice browser is closed');
  expect(run.stdout).not.toContain('Practice handoff verified');
  expect(run.stderr).toBe('');
  const output = run.stdout + run.stderr;
  for (const secret of [config.ownerToken, config.agentToken, config.vapid.privateKey, 'cdpUrl', 'http://127.0.0.1:', 'keep_safe_practice=']) expect(output).not.toContain(secret);
  expect(agentCalls.length).toBeGreaterThan(0);
  expect(agentCalls.every(call => call.path === '/api/requests' && call.method === 'POST' || /^\/api\/requests\/[a-f0-9-]+$/.test(call.path) && call.method === 'GET')).toBe(true);
  expect(await readFile(join(path, 'config.json'), 'utf8')).toBe(before);
  expect(await readdir(path)).toEqual(['config.json']);
}, 30_000);
