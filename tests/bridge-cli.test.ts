import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '../packages/bridge/src/config';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'keep-safe-cli-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function port() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return value;
}
function launch(args: string[], env = process.env) {
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('packages/bridge/src/cli.ts'), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let stdout = ''; let stderr = '';
  // Captured only in this temporary test process. Never print the startup pairing link.
  child.stdout.on('data', value => { stdout += String(value); });
  child.stderr.on('data', value => { stderr += String(value); });
  const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await exit; } finally { clearTimeout(timer); }
    }
  };
  cleanup.push(stop);
  return { child, exit, stop, get stdout() { return stdout; }, get stderr() { return stderr; } };
}
async function healthy(url: string) {
  try { return (await fetch(url + '/api/health', { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
}

it('locks the real bridge, refuses live rotation, then rotates and enforces new keys after restart', async () => {
  const path = await directory();
  const first = await loadConfig(path);
  const selectedPort = await port();
  const url = `http://127.0.0.1:${selectedPort}`;
  const daemon = launch(['--config-dir', path, '--port', String(selectedPort), '--no-static']);
  await expect.poll(() => healthy(url), { timeout: 5000 }).toBe(true);
  const before = await readFile(join(path, 'config.json'), 'utf8');
  const refused = launch(['rotate-keys', '--all', '--config-dir', path]);
  expect(await refused.exit).toBe(1);
  expect(refused.stderr).toContain('configuration is locked');
  expect(await readFile(join(path, 'config.json'), 'utf8') === before).toBe(true);
  const duplicate = launch(['--config-dir', path, '--port', String(await port()), '--no-static']);
  expect(await duplicate.exit).toBe(1);
  expect(duplicate.stderr).toContain('configuration is locked');
  await daemon.stop();
  expect(await daemon.exit).toBe(0);
  expect((await readdir(path)).includes('bridge.lock')).toBe(false);
  const rotate = launch(['rotate-keys', '--all', '--config-dir', path]);
  expect(await rotate.exit).toBe(0);
  const next = await loadConfig(path);
  for (const key of [first.ownerToken, first.agentToken, next.ownerToken, next.agentToken, first.vapid.privateKey]) {
    expect((rotate.stdout + rotate.stderr).includes(key)).toBe(false);
  }
  const restarted = launch(['--config-dir', path, '--port', String(selectedPort), '--no-static']);
  await expect.poll(() => healthy(url), { timeout: 5000 }).toBe(true);
  const info = (token: string) => fetch(url + '/api/info', { headers: { Authorization: `Bearer ${token}` } });
  expect((await info(first.ownerToken)).status).toBe(401);
  expect((await info(next.ownerToken)).status).toBe(200);
  const request = (token: string) => fetch(url + '/api/requests', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'CLI fixture', title: 'Check rotated agent', url: 'https://example.com' }) });
  expect((await request(first.agentToken)).status).toBe(401);
  expect((await request(next.agentToken)).status).toBe(201);
  await restarted.stop();
});

it('keeps a crash lock until an operator confirms exit and removes it', async () => {
  const path = await directory();
  const original = await loadConfig(path);
  const selectedPort = await port();
  const daemon = launch(['--config-dir', path, '--port', String(selectedPort), '--no-static']);
  await expect.poll(() => healthy(`http://127.0.0.1:${selectedPort}`), { timeout: 5000 }).toBe(true);
  daemon.child.kill('SIGKILL');
  await daemon.exit;
  const refused = launch(['rotate-keys', '--agent', '--config-dir', path]);
  expect(await refused.exit).toBe(1);
  expect((await loadConfig(path)).agentToken === original.agentToken).toBe(true);
  // Manual recovery is only safe after the owning process has exited.
  await unlink(join(path, 'bridge.lock'));
  const recovered = launch(['rotate-keys', '--agent', '--config-dir', path]);
  expect(await recovered.exit).toBe(0);
  expect((await loadConfig(path)).agentToken === original.agentToken).toBe(false);
});

it('releases startup locks on failure and rejects conflicting flags without changing keys', async () => {
  const path = await directory();
  await loadConfig(path);
  const original = await readFile(join(path, 'config.json'), 'utf8');
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => occupied.close(() => resolve())));
  const selectedPort = (occupied.address() as { port: number }).port;
  const failed = launch(['--config-dir', path, '--port', String(selectedPort), '--no-static']);
  expect(await failed.exit).toBe(1);
  expect((await readdir(path)).includes('bridge.lock')).toBe(false);
  for (const scopes of [[], ['--owner', '--agent'], ['--all', '--owner']]) {
    const invalid = launch(['rotate-keys', ...scopes, '--config-dir', path]);
    expect(await invalid.exit).toBe(1);
    expect(invalid.stderr).toContain('Choose exactly one rotation scope');
  }
  expect(await readFile(join(path, 'config.json'), 'utf8') === original).toBe(true);
});

it('does not expose malformed config contents or create keys in a missing configuration', async () => {
  const path = await directory();
  const missing = launch(['rotate-keys', '--all', '--config-dir', path]);
  expect(await missing.exit).toBe(1);
  expect(await readdir(path)).toEqual([]);
  await writeFile(join(path, 'config.json'), '{private-test-marker-not-for-output');
  const invalid = launch(['rotate-keys', '--all', '--config-dir', path]);
  expect(await invalid.exit).toBe(1);
  expect((invalid.stdout + invalid.stderr).includes('private-test-marker-not-for-output')).toBe(false);
  expect(invalid.stderr).toContain('Invalid bridge configuration');
});

it('runs JSON diagnostics beside a locked bridge without changing its configuration or printing secrets', async () => {
  const path = await directory();
  const config = await loadConfig(path);
  const selectedPort = await port();
  const daemon = launch(['--config-dir', path, '--port', String(selectedPort), '--app-url', 'https://keep-safe-eight.vercel.app', '--no-static']);
  await expect.poll(() => healthy(`http://127.0.0.1:${selectedPort}`), { timeout: 5000 }).toBe(true);
  const original = await readFile(join(path, 'config.json'), 'utf8');
  const lock = await readFile(join(path, 'bridge.lock'), 'utf8');
  const doctor = launch(['doctor', '--config-dir', path, '--port', String(selectedPort), '--app-url', 'https://keep-safe-eight.vercel.app', '--json']);
  expect(await doctor.exit).toBe(0);
  const report = JSON.parse(doctor.stdout);
  expect(report.ok).toBe(true);
  expect(report.checks.find((value: { id: string }) => value.id === 'local-auth').status).toBe('pass');
  expect(await readFile(join(path, 'config.json'), 'utf8') === original).toBe(true);
  expect(await readFile(join(path, 'bridge.lock'), 'utf8') === lock).toBe(true);
  for (const secret of [config.ownerToken, config.agentToken, config.vapid.privateKey]) expect((doctor.stdout + doctor.stderr).includes(secret)).toBe(false);
  await daemon.stop();
});

it('prints setup without creating configuration and fails diagnostics and invalid origins safely', async () => {
  const path = await directory();
  const missing = join(path, 'not-created');
  const setup = launch(['setup', '--config-dir', missing, '--json']);
  expect(await setup.exit).toBe(0);
  expect(JSON.parse(setup.stdout).commands.publicStart).toContain('YOUR-TUNNEL');
  expect(await readdir(path)).toEqual([]);
  const doctor = launch(['doctor', '--config-dir', missing, '--port', String(await port()), '--json']);
  expect(await doctor.exit).toBe(1);
  expect(JSON.parse(doctor.stdout).checks.find((value: { id: string }) => value.id === 'config').status).toBe('fail');
  expect(await readdir(path)).toEqual([]);
  for (const command of [[], ['setup'], ['doctor']]) {
    const invalid = launch([...command, '--config-dir', missing, '--public-url', 'https://example.com/private-url-marker']);
    expect(await invalid.exit).toBe(1);
    expect(invalid.stderr).toContain('root HTTPS origins');
    expect((invalid.stdout + invalid.stderr).includes('private-url-marker')).toBe(false);
    expect(await readdir(path)).toEqual([]);
  }
});

it('keeps the owner check direct when environment proxy routing is enabled', async () => {
  const path = await directory();
  const config = await loadConfig(path);
  const selectedPort = await port();
  const daemon = launch(['--config-dir', path, '--port', String(selectedPort), '--no-static']);
  await expect.poll(() => healthy(`http://127.0.0.1:${selectedPort}`), { timeout: 5000 }).toBe(true);
  let sawOwnerAuthority = false;
  const proxy = createHttpServer((request, response) => {
    if (request.headers.authorization?.includes(config.ownerToken)) sawOwnerAuthority = true;
    response.writeHead(502).end('proxy fixture');
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); });
  const proxyOrigin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const doctor = launch(['doctor', '--config-dir', path, '--port', String(selectedPort), '--json'], { ...process.env, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyOrigin, http_proxy: proxyOrigin, HTTPS_PROXY: proxyOrigin, https_proxy: proxyOrigin, NO_PROXY: '', no_proxy: '' });
  expect(await doctor.exit).toBe(0); // Every local transport uses a private direct agent.
  const report = JSON.parse(doctor.stdout);
  expect(report.ok).toBe(true);
  expect(report.checks.find((value: { id: string }) => value.id === 'local-auth').status).toBe('pass');
  expect(sawOwnerAuthority).toBe(false);
  for (const secret of [config.ownerToken, config.agentToken, config.vapid.privateKey]) expect((doctor.stdout + doctor.stderr).includes(secret)).toBe(false);
  await daemon.stop();
});

it('defaults --app-url to the hosted production origin when --public-url is supplied', async () => {
  const path = await directory();
  await loadConfig(path);
  const selectedPort = await port();
  const localUrl = `http://127.0.0.1:${selectedPort}`;
  const daemon = launch(['--config-dir', path, '--port', String(selectedPort), '--public-url', 'https://tunnel.example.com', '--no-static']);
  await expect.poll(() => healthy(localUrl), { timeout: 5000 }).toBe(true);
  const preflight = await fetch(localUrl + '/api/requests', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://keep-safe-eight.vercel.app',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'Authorization',
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe('https://keep-safe-eight.vercel.app');
  await daemon.stop();
});
