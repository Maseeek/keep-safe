import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { mkdtemp, stat, readFile, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, type BridgeOptions } from '../src/server';
import { loadConfig } from '../src/config';
import { validateCdpUrl, validateTargetUrl, type BrowserSession } from '../src/browser';

const ownerToken = 'owner-test-secret';
const agentToken = 'agent-test-secret';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function start(options: Partial<BridgeOptions> = {}) {
  const inputs: unknown[] = [];
  let opened = 0;
  let closed = 0;
  let prepared = 0;
  const browser: BrowserSession = {
    cdpUrl: 'http://127.0.0.1:9333',
    frame: async () => ({ data: 'aW1hZ2U=', width: 390, height: 720, url: 'https://login.example.com/redirected' }),
    input: async value => { inputs.push(value); },
    prepareHandoff: async () => { prepared++; },
    close: async () => { closed++; },
  };
  const bridge = await createBridge({ ownerToken, agentToken, port: 0, browserFactory: async () => { opened++; return browser; }, ...options });
  cleanup.push(() => bridge.close());
  async function request(path: string, token: string | undefined = ownerToken, method = 'GET', body?: unknown, origin?: string, signal?: AbortSignal) {
    return fetch(`${bridge.url}${path}`, { method, signal, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(origin ? { Origin: origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  async function create(body: unknown = { agent: 'Codex', title: 'Sign into Example', url: 'https://example.com/login' }) {
    const response = await request('/api/requests', agentToken, 'POST', body);
    expect(response.status).toBe(201);
    return response.json() as Promise<{ id: string; status: string; expiresAt: string }>;
  }
  return { ...bridge, inputs, request, create, get opened() { return opened; }, get closed() { return closed; }, get prepared() { return prepared; } };
}

type Message = { type: string; [key: string]: unknown };
async function socket(url: string) {
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws');
  const messages: Message[] = [];
  ws.on('message', data => messages.push(JSON.parse(data.toString()) as Message));
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  async function next(type: string) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) { const index = messages.findIndex(message => message.type === type); if (index !== -1) return messages.splice(index, 1)[0]; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error(`Expected WebSocket message ${type}`);
  }
  function send(message: unknown) { ws.send(JSON.stringify(message)); }
  async function auth() { send({ type: 'auth', token: ownerToken }); await next('ready'); }
  return { ws, send, next, auth, messages };
}

describe('bridge authorization and validation', () => {
  it('keeps all metadata behind separate owner and agent roles', async () => {
    const bridge = await start();
    const health = await bridge.request('/api/health', undefined);
    expect(await health.json()).toEqual({ ok: true });
    expect((await bridge.request('/api/info', 'wrong')).status).toBe(401);
    expect((await bridge.request('/api/info', agentToken)).status).toBe(403);
    expect((await bridge.request('/api/requests', '')).status).toBe(401);
    expect((await bridge.request('/api/requests', agentToken)).status).toBe(403);
    expect((await bridge.request('/api/requests', ownerToken, 'POST', { agent: 'a', title: 't', url: 'https://example.com' })).status).toBe(403);
    const item = await bridge.create();
    expect((await bridge.request(`/api/requests/${item.id}/approve`, agentToken, 'POST')).status).toBe(403);
    expect((await bridge.request('/api/info', ownerToken, 'GET', undefined, 'https://evil.example')).status).toBe(403);
    const response = await bridge.request('/api/requests');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).requests).toHaveLength(1);
  });

  it('rejects insecure target websites, remote CDP and invalid lifetimes', async () => {
    const bridge = await start();
    for (const change of [{ url: 'http://example.com' }, { url: 'https://user:password@example.com' }, { url: 'https://127.0.0.1/login' }, { cdpUrl: 'http://evil.example:9222' }, { cdpUrl: 'http://localhost:9222' }, { ttlSeconds: 1801 }, { ttlSeconds: 0 }, { ttlSeconds: '600' }]) {
      const response = await bridge.request('/api/requests', agentToken, 'POST', { agent: 'Codex', title: 'Login', url: 'https://example.com', ...change });
      expect(response.status).toBe(400);
    }
    expect(validateTargetUrl('http://127.0.0.1:8999/login', true)).toBe('http://127.0.0.1:8999/login');
    expect(validateCdpUrl('ws://127.0.0.1:9222/devtools/browser/a')).toBe('ws://127.0.0.1:9222/devtools/browser/a');
    expect(() => validateCdpUrl('http://127.0.0.1:9222@evil.example')).toThrow();
  });

  it('blocks push endpoints that could fetch local or arbitrary servers', async () => {
    const bridge = await start({ vapid: { publicKey: 'public', privateKey: 'private' } });
    for (const endpoint of ['http://127.0.0.1:4318/api/info', 'https://evil.example/push', 'https://fcm.googleapis.com.evil.example/push', 'https://fcm.googleapis.com:8443/push']) {
      const response = await bridge.request('/api/push/subscribe', ownerToken, 'POST', { endpoint, keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) } });
      expect(response.status).toBe(400);
    }
  });

  it('keeps invalid credentials in a separate rate bucket from authenticated owners and agents', async () => {
    const bridge = await start();
    const statuses: number[] = [];
    for (let index = 0; index < 305; index += 25) {
      const batch = await Promise.all(Array.from({ length: Math.min(25, 305 - index) }, () => bridge.request('/api/info', 'invalid-token')));
      statuses.push(...batch.map(response => response.status));
    }
    expect(statuses).toContain(401); expect(statuses).toContain(429);
    expect((await bridge.request('/api/requests')).status).toBe(200);
    expect((await bridge.create()).status).toBe('pending');
  });
});

describe('live browser lifecycle', () => {
  it('cannot complete an approved request until its browser session has been opened', async () => {
    const bridge = await start(); const item = await bridge.create();
    await bridge.request(`/api/requests/${item.id}/approve`, ownerToken, 'POST');
    const response = await bridge.request(`/api/requests/${item.id}/complete`, ownerToken, 'POST');
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('Open the browser session before completing the handoff.');
    const detail = await (await bridge.request(`/api/requests/${item.id}`, agentToken)).json();
    expect(detail.status).toBe('approved'); expect(detail.browser).toBeUndefined();
    expect(bridge.opened).toBe(0);
  });

  it('keeps an unexpired owner session usable when handoff cleanup fails', async () => {
    let preparations = 0; let inputs = 0;
    const bridge = await start({ browserFactory: async () => ({
      cdpUrl: 'http://127.0.0.1:9333', frame: async () => ({ data: 'aW1hZ2U=', width: 390, height: 720, url: 'https://example.com/login' }),
      input: async () => { inputs++; }, prepareHandoff: async () => { if (++preparations === 1) throw new Error('Synthetic cleanup failure'); }, close: async () => {},
    }) });
    const item = await bridge.create(); await bridge.request(`/api/requests/${item.id}/approve`, ownerToken, 'POST');
    const phone = await socket(bridge.url); await phone.auth(); phone.send({ type: 'watch', requestId: item.id }); await phone.next('frame');
    expect((await bridge.request(`/api/requests/${item.id}/complete`, ownerToken, 'POST')).status).toBe(502);
    const waiting = await (await bridge.request(`/api/requests/${item.id}`, agentToken)).json();
    expect(waiting.status).toBe('active'); expect(waiting.browser).toBeUndefined();
    phone.messages.length = 0; await phone.next('frame');
    phone.send({ type: 'key', key: 'Enter' }); await expect.poll(() => inputs).toBe(1);
    phone.send({ type: 'watch', requestId: item.id }); await phone.next('frame');
    expect((await bridge.request(`/api/requests/${item.id}/complete`, ownerToken, 'POST')).status).toBe(200);
    expect((await (await bridge.request(`/api/requests/${item.id}`, agentToken)).json()).browser).toBeDefined();
  });

  it('reports an expiry during handoff cleanup as a conflict and never exposes CDP', async () => {
    let clock = Date.now(); let release!: () => void; let preparing!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { preparing = resolve; });
    const bridge = await start({ now: () => clock, expiryIntervalMs: 10, browserFactory: async () => ({
      cdpUrl: 'http://127.0.0.1:9333', frame: async () => ({ data: 'aW1hZ2U=', width: 390, height: 720, url: 'https://example.com/login' }),
      input: async () => {}, prepareHandoff: async () => { preparing(); await gate; throw new Error('Synthetic closed page'); }, close: async () => { release(); },
    }) });
    try {
      const item = await bridge.create({ agent: 'Agent', title: 'Login', url: 'https://example.com', ttlSeconds: 2 });
      await bridge.request(`/api/requests/${item.id}/approve`, ownerToken, 'POST');
      const phone = await socket(bridge.url); await phone.auth(); phone.send({ type: 'watch', requestId: item.id }); await phone.next('frame');
      const completion = bridge.request(`/api/requests/${item.id}/complete`, ownerToken, 'POST');
      await started; clock += 2001;
      const response = await completion; expect(response.status).toBe(409);
      expect((await response.json()).error).toBe('This request has expired.');
      const detail = await (await bridge.request(`/api/requests/${item.id}`, agentToken)).json();
      expect(detail.status).toBe('expired'); expect(detail.browser).toBeUndefined();
    } finally { release(); }
  });

  it.each([false, true])('drains in-flight input before clearing passwords and exposing CDP (phone disconnected: %s)', async disconnect => {
    let releaseInput!: () => void; let inputStarted!: () => void;
    const inputGate = new Promise<void>(resolve => { releaseInput = resolve; });
    const started = new Promise<void>(resolve => { inputStarted = resolve; });
    const events: string[] = []; let password = ''; let completed = false;
    const bridge = await start({ browserFactory: async () => ({
      cdpUrl: 'http://127.0.0.1:9333',
      frame: async () => ({ data: 'aW1hZ2U=', width: 390, height: 720, url: 'https://example.com/login' }),
      input: async () => { events.push('input started'); inputStarted(); await inputGate; password = 'synthetic-secret'; events.push('input finished'); },
      prepareHandoff: async () => { password = ''; events.push('password cleared'); },
      close: async () => { releaseInput(); },
    }) });
    try {
      const item = await bridge.create();
      await bridge.request(`/api/requests/${item.id}/approve`, ownerToken, 'POST');
      const phone = await socket(bridge.url); await phone.auth();
      phone.send({ type: 'watch', requestId: item.id }); await phone.next('frame');
      phone.send({ type: 'text', text: 'synthetic-secret' }); await started;
      if (disconnect) { const closed = new Promise(resolve => phone.ws.once('close', resolve)); phone.ws.close(); await closed; }
      const completion = bridge.request(`/api/requests/${item.id}/complete`, ownerToken, 'POST').then(response => { completed = true; return response; });
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(completed).toBe(false);
      expect(events).toEqual(['input started']);
      const waiting = await (await bridge.request(`/api/requests/${item.id}`, agentToken)).json();
      expect(waiting.status).toBe('active'); expect(waiting.browser).toBeUndefined();
      releaseInput();
      expect((await completion).status).toBe(200);
      expect(events).toEqual(['input started', 'input finished', 'password cleared']);
      expect(password).toBe('');
      const resumed = await (await bridge.request(`/api/requests/${item.id}`, agentToken)).json();
      expect(resumed.status).toBe('completed'); expect(resumed.browser.cdpUrl).toBe('http://127.0.0.1:9333');
    } finally { releaseInput(); }
  });

  it('keeps the input barrier after a handoff timeout so retry cannot bypass a pending keyboard operation', async () => {
    let releaseInput!: () => void; let inputStarted!: () => void; let prepared = 0;
    const gate = new Promise<void>(resolve => { releaseInput = resolve; });
    const started = new Promise<void>(resolve => { inputStarted = resolve; });
    const bridge = await start({ inputDrainTimeoutMs: 20, browserFactory: async () => ({
      cdpUrl: 'http://127.0.0.1:9333', frame: async () => ({ data: 'aW1hZ2U=', width: 390, height: 720, url: 'https://example.com/login' }),
      input: async () => { inputStarted(); await gate; }, prepareHandoff: async () => { prepared++; }, close: async () => { releaseInput(); },
    }) });
    try {
      const item = await bridge.create(); await bridge.request(`/api/requests/${item.id}/approve`, ownerToken, 'POST');
      const phone = await socket(bridge.url); await phone.auth(); phone.send({ type: 'watch', requestId: item.id }); await phone.next('frame');
      phone.send({ type: 'text', text: 'synthetic-secret' }); await started;
      expect((await bridge.request(`/api/requests/${item.id}/complete`, ownerToken, 'POST')).status).toBe(504);
      expect((await bridge.request(`/api/requests/${item.id}/complete`, ownerToken, 'POST')).status).toBe(504);
      expect(prepared).toBe(0);
      const detail = await (await bridge.request(`/api/requests/${item.id}`, agentToken)).json();
      expect(detail.status).toBe('active'); expect(detail.browser).toBeUndefined();
      const second = await socket(bridge.url); await second.auth(); second.send({ type: 'watch', requestId: item.id }); await second.next('error');
      releaseInput();
      expect((await bridge.request(`/api/requests/${item.id}/complete`, ownerToken, 'POST')).status).toBe(200);
      expect(prepared).toBe(1);
    } finally { releaseInput(); }
  });

  it('requires approval, streams current URL, hands browser to agent and revokes mobile input', async () => {
    const bridge = await start();
    const item = await bridge.create();
    const phone = await socket(bridge.url);
    await phone.auth();
    phone.send({ type: 'watch', requestId: item.id });
    await phone.next('error');
    expect(bridge.opened).toBe(0);
    expect((await bridge.request(`/api/requests/${item.id}/approve`, ownerToken, 'POST')).status).toBe(200);
    phone.send({ type: 'watch', requestId: item.id });
    const frame = await phone.next('frame');
    expect(frame.url).toBe('https://login.example.com/redirected');
    phone.send({ type: 'click', x: 42, y: 90 });
    phone.send({ type: 'text', text: 'private input' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(bridge.inputs).toHaveLength(2);
    const ownerView = await (await bridge.request(`/api/requests/${item.id}`)).json();
    expect(ownerView.browser).toBeUndefined();
    const agentView = await (await bridge.request(`/api/requests/${item.id}`, agentToken)).json();
    expect(agentView.browser).toBeUndefined();
    expect(agentView.status).toBe('active');
    const complete = await bridge.request(`/api/requests/${item.id}/complete`, ownerToken, 'POST');
    expect((await complete.json()).status).toBe('completed');
    expect(bridge.prepared).toBe(1);
    const resumed = await (await bridge.request(`/api/requests/${item.id}`, agentToken)).json();
    expect(resumed.browser.cdpUrl).toBe('http://127.0.0.1:9333');
    expect(bridge.closed).toBe(0);
    phone.send({ type: 'text', text: 'must not arrive' });
    await phone.next('error');
    expect(bridge.inputs).toHaveLength(2);
    expect((await bridge.request(`/api/requests/${item.id}/approve`, ownerToken, 'POST')).status).toBe(409);
    const queue = JSON.stringify(await (await bridge.request('/api/requests')).json());
    expect(queue).not.toContain('private input');
    expect(queue).not.toContain('cdpUrl');
  });

  it('limits each request to one mobile controller and validates input', async () => {
    const bridge = await start();
    const item = await bridge.create();
    await bridge.request(`/api/requests/${item.id}/approve`, ownerToken, 'POST');
    const first = await socket(bridge.url); const second = await socket(bridge.url);
    await first.auth(); await second.auth();
    first.send({ type: 'watch', requestId: item.id }); await first.next('frame');
    second.send({ type: 'watch', requestId: item.id }); await second.next('error');
    first.send({ type: 'click', x: -1, y: 1 }); await first.next('error');
    first.send({ type: 'key', key: 'ControlOrMeta+L' }); await first.next('error');
    expect(bridge.inputs).toHaveLength(0);
    first.send({ type: 'unwatch' });
    await new Promise(resolve => setTimeout(resolve, 20));
    second.send({ type: 'watch', requestId: item.id }); await second.next('frame');
    second.send({ type: 'key', key: 'Enter' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(bridge.inputs).toEqual([{ type: 'key', key: 'Enter' }]);
  });

  it('validates optional paired scroll coordinates before passing any input to the browser', async () => {
    const bridge = await start(); const item = await bridge.create();
    await bridge.request(`/api/requests/${item.id}/approve`, ownerToken, 'POST');
    const phone = await socket(bridge.url); await phone.auth();
    phone.send({ type: 'watch', requestId: item.id }); await phone.next('frame');
    for (const anchor of [{ x: 20 }, { y: 20 }, { x: null, y: 20 }, { x: 20, y: null }, { x: '20', y: 20 }, { x: -1, y: 0 }, { x: 391, y: 0 }, { x: 0, y: 721 }]) {
      phone.send({ type: 'scroll', deltaX: 0, deltaY: 150, ...anchor }); await phone.next('error');
    }
    // JSON can express an overflowing numeric literal even though stringify
    // turns a JavaScript Infinity into null. Reject it as non-finite too.
    phone.ws.send('{"type":"scroll","deltaX":0,"deltaY":150,"x":1e309,"y":20}'); await phone.next('error');
    expect(bridge.inputs).toEqual([]);
    phone.send({ type: 'scroll', deltaX: 0, deltaY: 150, x: 80, y: 160 });
    phone.send({ type: 'scroll', deltaX: 0, deltaY: -50 });
    await expect.poll(() => bridge.inputs.length).toBe(2);
    expect(bridge.inputs).toEqual([{ type: 'scroll', deltaX: 0, deltaY: 150, x: 80, y: 160 }, { type: 'scroll', deltaX: 0, deltaY: -50 }]);
  });

  it('expires requests, releases browsers and refuses further control', async () => {
    let clock = Date.now();
    const bridge = await start({ now: () => clock });
    const item = await bridge.create({ agent: 'Claude', title: 'Login', url: 'https://example.com/login', ttlSeconds: 2 });
    await bridge.request(`/api/requests/${item.id}/approve`, ownerToken, 'POST');
    const phone = await socket(bridge.url); await phone.auth();
    phone.send({ type: 'watch', requestId: item.id }); await phone.next('frame');
    clock += 2001;
    const detail = await (await bridge.request(`/api/requests/${item.id}`, agentToken)).json();
    expect(detail.status).toBe('expired');
    expect(detail.browser).toBeUndefined();
    expect(bridge.closed).toBe(1);
    phone.send({ type: 'key', key: 'Enter' }); await phone.next('error');
    expect(bridge.inputs).toHaveLength(0);
  });

  it('retains a completed browser only until the original request expiry', async () => {
    let clock = Date.now();
    const bridge = await start({ now: () => clock });
    const item = await bridge.create({ agent: 'Agent', title: 'Login', url: 'https://example.com', ttlSeconds: 2 });
    await bridge.request(`/api/requests/${item.id}/approve`, ownerToken, 'POST');
    const phone = await socket(bridge.url); await phone.auth();
    phone.send({ type: 'watch', requestId: item.id }); await phone.next('frame');
    await bridge.request(`/api/requests/${item.id}/complete`, ownerToken, 'POST');
    expect(bridge.closed).toBe(0);
    expect((await (await bridge.request(`/api/requests/${item.id}`, agentToken)).json()).browser).toBeDefined();
    clock += 2001;
    const detail = await (await bridge.request(`/api/requests/${item.id}`, agentToken)).json();
    expect(detail.status).toBe('completed');
    expect(detail.browser).toBeUndefined();
    expect(bridge.closed).toBe(1);
  });

  it('closes denied browsers and cannot reopen a denied request', async () => {
    const bridge = await start();
    const item = await bridge.create();
    await bridge.request(`/api/requests/${item.id}/approve`, ownerToken, 'POST');
    const phone = await socket(bridge.url); await phone.auth();
    phone.send({ type: 'watch', requestId: item.id }); await phone.next('frame');
    const response = await bridge.request(`/api/requests/${item.id}/deny`, ownerToken, 'POST');
    expect((await response.json()).status).toBe('denied');
    expect(bridge.closed).toBe(1);
    phone.send({ type: 'watch', requestId: item.id }); await phone.next('error');
    expect(bridge.opened).toBe(1);
  });

  it('requires owner authentication as the first socket message', async () => {
    const bridge = await start();
    for (const message of [{ type: 'auth', token: agentToken }, { type: 'watch', requestId: 'x' }]) {
      const phone = await socket(bridge.url);
      const closed = new Promise<number>(resolve => phone.ws.once('close', code => resolve(code)));
      phone.send(message);
      expect(await closed).toBe(4001);
    }
    const badOrigin = new WebSocket(bridge.url.replace('http:', 'ws:') + '/ws', { origin: 'https://evil.example' });
    const error = await new Promise<Error>(resolve => badOrigin.once('error', resolve));
    expect(error.message).toContain('403');
  });

  it('uses a temporary rate-limit close code without invalidating owner credentials', async () => {
    const bridge = await start(); const phone = await socket(bridge.url); await phone.auth();
    const closed = new Promise<number>(resolve => phone.ws.once('close', code => resolve(code)));
    for (let index = 0; index < 65; index++) phone.send({ type: 'unwatch' });
    expect(await closed).toBe(4029);
    const reconnected = await socket(bridge.url); await reconnected.auth();
    expect((await bridge.request('/api/info')).status).toBe(200);
  });
});

it('serves the frontend with a CSP and refuses symlinks outside its directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'keep-safe-static-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const frontend = join(directory, 'web'); await mkdir(frontend);
  await writeFile(join(frontend, 'index.html'), '<h1>Public frontend</h1>');
  await writeFile(join(directory, 'private.json'), 'private data');
  await symlink(join(directory, 'private.json'), join(frontend, 'private.json'));
  const bridge = await start({ staticDir: frontend });
  const page = await bridge.request('/', '');
  expect(page.status).toBe(200);
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  const outside = await bridge.request('/private.json', '');
  expect(outside.status).toBe(404);
  expect(await outside.text()).not.toContain('private data');
  expect((await bridge.request('/%E0%A4%A', '')).status).toBe(400);
});

it('persists separate random pairing keys in owner-only local files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'keep-safe-config-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const first = await loadConfig(directory); const second = await loadConfig(directory);
  expect(first).toEqual(second);
  expect(first.ownerToken).toHaveLength(64);
  expect(first.agentToken).toHaveLength(64);
  expect(first.ownerToken).not.toBe(first.agentToken);
  expect((await stat(join(directory, 'config.json'))).mode & 0o777).toBe(0o600);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect(await readFile(join(directory, 'config.json'), 'utf8')).not.toContain('password');
});

describe('agent long polling', () => {
  it('holds a status request until the owner changes it, then returns the browser after completion', async () => {
    const bridge = await start();
    const item = await bridge.create();
    const started = Date.now();
    const approval = bridge.request(`/api/requests/${item.id}?wait=10`, agentToken);
    await new Promise(resolve => setTimeout(resolve, 150));
    await bridge.request(`/api/requests/${item.id}/approve`, ownerToken, 'POST');
    const approved = await (await approval).json();
    expect(approved.status).toBe('approved');
    expect(Date.now() - started).toBeLessThan(5000);

    const completion = bridge.request(`/api/requests/${item.id}?wait=10&since=${encodeURIComponent(approved.updatedAt)}`, agentToken);
    const ws = await socket(bridge.url); await ws.auth();
    ws.send({ type: 'watch', requestId: item.id }); await ws.next('frame');
    const active = await (await completion).json();
    expect(active.status).toBe('active');
    expect(active.browser).toBeUndefined();

    const done = bridge.request(`/api/requests/${item.id}?wait=10&since=${encodeURIComponent(active.updatedAt)}`, agentToken);
    expect((await bridge.request(`/api/requests/${item.id}/complete`, ownerToken, 'POST')).status).toBe(200);
    const detail = await (await done).json();
    expect(detail.status).toBe('completed');
    expect(detail.browser).toEqual({ cdpUrl: 'http://127.0.0.1:9333', pageUrl: 'https://example.com/login' });
    ws.ws.close();
  });

  it('answers unchanged requests when the wait ends and changed or ended requests at once', async () => {
    const bridge = await start();
    const item = await bridge.create();
    let started = Date.now();
    const unchanged = await (await bridge.request(`/api/requests/${item.id}?wait=1`, agentToken)).json();
    expect(unchanged.status).toBe('pending');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);

    started = Date.now();
    expect((await (await bridge.request(`/api/requests/${item.id}?wait=10&since=stale`, agentToken)).json()).status).toBe('pending');
    await bridge.request(`/api/requests/${item.id}/deny`, ownerToken, 'POST');
    expect((await (await bridge.request(`/api/requests/${item.id}?wait=10`, agentToken)).json()).status).toBe('denied');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('wakes waiters on expiry and validates the wait parameters', async () => {
    const bridge = await start({ expiryIntervalMs: 50 });
    const item = await bridge.create({ agent: 'Codex', title: 'Short', url: 'https://example.com/login', ttlSeconds: 1 });
    expect((await (await bridge.request(`/api/requests/${item.id}?wait=10`, agentToken)).json()).status).toBe('expired');
    for (const query of ['wait=0', 'wait=31', 'wait=1.5', 'wait=abc', 'since=x', `wait=5&since=${'x'.repeat(65)}`]) {
      expect((await bridge.request(`/api/requests/${item.id}?${query}`, agentToken)).status).toBe(400);
    }
  });

  it('releases held responses when the bridge stops and when the caller disconnects', async () => {
    const bridge = await start();
    const item = await bridge.create();
    const abandoned = new AbortController();
    const dropped = bridge.request(`/api/requests/${item.id}?wait=30`, agentToken, 'GET', undefined, undefined, abandoned.signal).catch(() => 'aborted');
    await new Promise(resolve => setTimeout(resolve, 100));
    abandoned.abort();
    expect(await dropped).toBe('aborted');
    const held = bridge.request(`/api/requests/${item.id}?wait=30`, agentToken);
    await new Promise(resolve => setTimeout(resolve, 100));
    const started = Date.now();
    await bridge.close();
    expect((await (await held).json()).status).toBe('pending');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
