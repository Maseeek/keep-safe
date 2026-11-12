import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startLoginFixture } from './fixtures/login-site';
import { terminalQr } from '../packages/cli/src/qr';

const bin = resolve('bin/keep-safe.mjs');
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close().catch(() => {}); });

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(done => {
    execFile(process.execPath, [bin, ...args], { env: { ...process.env, KEEP_SAFE_ROUTE: 'local', ...env }, timeout: 60_000 }, (error, stdout, stderr) => done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}
async function freePort() {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  await new Promise(done => server.close(done));
  return port;
}
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'keep-safe-cli-'));
  const port = await freePort();
  cleanup.push(async () => { await run(['down', '--config-dir', directory]); await rm(directory, { recursive: true, force: true }); });
  return { directory, port, common: ['--config-dir', directory] };
}

describe('keep-safe command', () => {
  it('draws a terminal QR code as equal-width half-block rows', () => {
    const lines = terminalQr('http://127.0.0.1:4318/#pair=ABCD2345').split('\n');
    expect(lines.length).toBeGreaterThan(10);
    expect(new Set(lines.map(line => line.length)).size).toBe(1);
    expect(lines.join('')).toMatch(/^[█▀▄ ]+$/);
  });

  it('starts a background bridge, pairs a phone with a one-time code, and stops', async () => {
    const { directory, port, common } = await workspace();
    expect(JSON.parse((await run(['status', '--json', ...common])).stdout)).toEqual({ running: false });

    const started = await run(['up', '--route', 'local', '--port', String(port), '--json', ...common]);
    expect(started.code).toBe(0);
    expect(JSON.parse(started.stdout)).toMatchObject({ running: true, started: true, port, route: { kind: 'local', publicUrl: `http://127.0.0.1:${port}` } });
    // A second start reuses the running bridge.
    expect(JSON.parse((await run(['up', '--json', ...common])).stdout)).toMatchObject({ started: false, port });

    const invited = await run(['pair', '--json', '--no-open', ...common]);
    expect(invited.code).toBe(0);
    const { invitation } = JSON.parse(invited.stdout) as { invitation: { code: string; display: string; link: string; desktopUrl: string } };
    expect(invitation.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(invitation.display).toBe(`${invitation.code.slice(0, 4)}-${invitation.code.slice(4)}`);
    expect(invitation.link).toBe(`http://127.0.0.1:${port}/#pair=${invitation.code}`);
    expect(new URL(invitation.desktopUrl).hash).toContain('desk=');

    const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')) as { ownerToken: string; agentToken: string };
    // Nothing printed or logged carries a key.
    for (const text of [started.stdout, invited.stdout, invited.stderr, await readFile(join(directory, 'bridge.log'), 'utf8'), await readFile(join(directory, 'daemon.json'), 'utf8')]) {
      expect(text).not.toContain(config.ownerToken);
      expect(text).not.toContain(config.agentToken);
    }
    for (const file of ['config.json', 'daemon.json', 'bridge.log']) expect((await stat(join(directory, file))).mode & 0o077).toBe(0);

    const claimed = await fetch(`http://127.0.0.1:${port}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: invitation.code, name: 'Test phone' }) });
    expect(claimed.status).toBe(201);
    expect(JSON.parse((await run(['status', '--json', ...common])).stdout)).toMatchObject({ running: true, phones: 1 });
    const human = (await run(['pair', '--no-open', '--no-wait', ...common])).stdout;
    expect(human).toContain('Pairing code: ');
    expect(human).toMatch(/[█▀▄]{10,}/);

    expect((await run(['down', ...common])).stdout).toContain('Keep Safe stopped.');
    expect(JSON.parse((await run(['status', '--json', ...common])).stdout)).toEqual({ running: false });
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  }, 90_000);

  it('stops promptly while a phone has a live browser and its page controls open', async () => {
    const { directory, port, common } = await workspace();
    const fixture = await startLoginFixture();
    cleanup.push(() => fixture.close());
    expect((await run(['up', '--route', 'local', '--port', String(port), '--allow-local-urls', ...common])).code).toBe(0);
    const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')) as { ownerToken: string; agentToken: string };
    const base = `http://127.0.0.1:${port}`;
    const call = async (path: string, token: string, body: unknown) => (await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<{ id: string }>;
    const request = await call('/api/requests', config.agentToken, { agent: 'CLI test', title: 'Live session', url: fixture.origin + '/login', ttlSeconds: 120 });
    await call(`/api/requests/${request.id}/approve`, config.ownerToken, {});
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    cleanup.push(async () => { socket.terminate(); });
    const seen = new Set<string>();
    socket.on('message', raw => { seen.add((JSON.parse(String(raw)) as { type: string }).type); });
    await new Promise<void>((done, fail) => { socket.once('open', () => done()); socket.once('error', fail); });
    socket.send(JSON.stringify({ type: 'auth', token: config.ownerToken }));
    socket.send(JSON.stringify({ type: 'watch', requestId: request.id, viewport: { width: 390, height: 640, scale: 2, touch: true } }));
    await expect.poll(() => seen.has('frame'), { timeout: 30_000 }).toBe(true);
    // An inspection leaves a control channel attached to the page, the case that once stalled shutdown.
    socket.send(JSON.stringify({ type: 'inspect-controls', inspectionId: randomUUID(), includeFrames: true }));
    await expect.poll(() => seen.has('controls'), { timeout: 15_000 }).toBe(true);
    const started = Date.now();
    const stopped = await run(['down', ...common]);
    expect(stopped.stdout).toContain('Keep Safe stopped.');
    expect(stopped.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    await expect(fetch(`${base}/api/health`)).rejects.toThrow();
  }, 90_000);

  it('rejects unknown options and routes with a plain message', async () => {
    const { common } = await workspace();
    const unknown = await run(['up', '--nope', ...common]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Unknown or incomplete option --nope');
    expect((await run(['up', '--route', 'carrier-pigeon', ...common])).stderr).toContain('Choose a route');
    expect((await run(['help'])).stdout).toContain('keep-safe <command>');
  }, 60_000);

  it('starts the bridge on demand from the MCP server and tells the agent when no phone is paired', async () => {
    const { directory, port } = await workspace();
    const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp', '--config-dir', directory, '--port', String(port)], env: { ...process.env as Record<string, string>, KEEP_SAFE_ROUTE: 'local' }, stderr: 'pipe' });
    const client = new Client({ name: 'keep-safe-cli-test', version: '1.0.0' });
    cleanup.push(() => client.close());
    await client.connect(transport);
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['get_login_request', 'request_login', 'wait_for_login']);
    const result = await client.callTool({ name: 'request_login', arguments: { agent: 'CLI test', title: 'Sign in', url: 'https://example.com/login', ttl_seconds: 60 } });
    const data = result.structuredContent as { request: { status: string }; setup?: string };
    expect(data.request.status).toBe('pending');
    expect(data.setup).toContain('keep-safe pair');
    expect(JSON.parse((await run(['status', '--json', '--config-dir', directory])).stdout)).toMatchObject({ running: true, port, phones: 0 });
  }, 90_000);
});
