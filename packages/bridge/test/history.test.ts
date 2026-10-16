import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createBridge, type BridgeOptions } from '../src/server';
import type { BrowserSession } from '../src/browser';
import type { HistoryCleanupResult, LoginRequest } from '../../shared/src/protocol';

const owner = 'history-owner-token'; const agent = 'history-agent-token';
const hour = 60 * 60 * 1000;
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

async function fixture(options: Partial<BridgeOptions> = {}) {
  let clock = Date.now(); let closes = 0;
  const browser: BrowserSession = {
    cdpUrl: 'http://127.0.0.1:9333', pageUrl: 'https://example.com/account',
    frame: async () => ({ data: 'aW1hZ2U=', width: 390, height: 720, url: 'https://example.com/login' }),
    input: async () => {}, prepareHandoff: async () => {}, close: async () => { closes++; },
  };
  const bridge = await createBridge({ ownerToken: owner, agentToken: agent, port: 0, now: () => clock, expiryIntervalMs: 60_000, browserFactory: async () => browser, ...options });
  cleanup.push(() => bridge.close());
  async function request(path: string, token = owner, method = 'GET', body?: unknown, origin?: string) {
    return fetch(bridge.url + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(origin ? { Origin: origin } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function create(ttlSeconds = 120) {
    const response = await request('/api/requests', agent, 'POST', { agent: 'History fixture', title: 'Sign in', url: 'https://example.com/login', ttlSeconds });
    expect(response.status).toBe(201); return response.json() as Promise<LoginRequest>;
  }
  async function clear(token = owner): Promise<HistoryCleanupResult> {
    const response = await request('/api/history/clear', token, 'POST', { confirm: true });
    expect(response.status).toBe(200); return response.json() as Promise<HistoryCleanupResult>;
  }
  async function action(item: LoginRequest, action: 'approve' | 'deny' | 'complete') { return request(`/api/requests/${item.id}/${action}`, owner, 'POST'); }
  async function get(item: LoginRequest) { return request(`/api/requests/${item.id}`, agent); }
  return { ...bridge, request, create, clear, action, get, browser, advance(milliseconds: number) { clock += milliseconds; }, setTime(time: number) { clock = time; }, get closes() { return closes; } };
}

async function phone(url: string) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws');
  const messages: Array<{ type: string; requests?: LoginRequest[] }> = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  async function next(type: string) { await expect.poll(() => messages.some(message => message.type === type)).toBe(true); return messages.splice(messages.findIndex(message => message.type === type), 1)[0]; }
  send({ type: 'auth', token: owner }); await next('ready');
  return { socket, send, next, messages };
}
async function open(bridge: Awaited<ReturnType<typeof fixture>>, item: LoginRequest) {
  expect((await bridge.action(item, 'approve')).status).toBe(200);
  const client = await phone(bridge.url); client.send({ type: 'watch', requestId: item.id }); await client.next('frame'); return client;
}

describe('owner history cleanup', () => {
  it('requires a confirmed owner request, supports paired owners, and refuses revoked phones', async () => {
    const bridge = await fixture(); const ended = await bridge.create(1); const pending = await bridge.create(120);
    await bridge.action(ended, 'deny'); bridge.advance(1001);
    expect((await bridge.request('/api/info')).status).toBe(200);
    expect((await (await bridge.request('/api/info')).json()).historyRetentionHours).toBe(24);
    expect((await bridge.request('/api/history/clear', agent, 'POST', { confirm: true })).status).toBe(403);
    expect((await bridge.request('/api/history/clear', 'invalid', 'POST', { confirm: true })).status).toBe(401);
    expect((await bridge.request('/api/history/clear', owner, 'POST')).status).toBe(415);
    for (const body of [{}, { confirm: false }, { confirm: 'true' }]) expect((await bridge.request('/api/history/clear', owner, 'POST', body)).status).toBe(400);
    expect((await bridge.request('/api/history/clear', owner, 'POST', { confirm: true }, 'https://wrong-app.example')).status).toBe(403);
    const paired = await (await bridge.request('/api/devices', owner, 'POST', { name: 'History test phone' })).json();
    const result = await bridge.clear(paired.token);
    expect(result).toMatchObject({ removed: 1, protected: 0 }); expect(result.requests.map(item => item.id)).toEqual([pending.id]);
    expect((await bridge.get(ended)).status).toBe(404);
    await bridge.request(`/api/devices/${paired.device.id}/revoke`, owner, 'POST');
    expect((await bridge.request('/api/history/clear', paired.token, 'POST', { confirm: true })).status).toBe(401);
  });

  it('preserves every unexpired outcome and completed CDP endpoint until its original deadline', async () => {
    const bridge = await fixture();
    const denied = await bridge.create(); await bridge.action(denied, 'deny');
    const completed = await bridge.create(); await open(bridge, completed); await bridge.action(completed, 'complete');
    const pending = await bridge.create(); const approved = await bridge.create(); await bridge.action(approved, 'approve');
    const active = await bridge.create(); await open(bridge, active);
    const result = await bridge.clear(); expect(result).toMatchObject({ removed: 0, protected: 2 }); expect(result.requests).toHaveLength(5);
    expect((await (await bridge.get(completed)).json()).browser.cdpUrl).toBe('http://127.0.0.1:9333');
    expect((await (await bridge.get(denied)).json()).status).toBe('denied');
    for (const item of [pending, approved, active]) expect((await bridge.get(item)).status).toBe(200);
    bridge.advance(120001); await bridge.request('/api/requests'); await tick();
    expect((await (await bridge.get(completed)).json()).browser).toBeUndefined();
    const expired = await bridge.clear(); expect(expired).toMatchObject({ removed: 5, protected: 0, requests: [] });
  });

  it('removes eligible metadata manually and automatically 24 hours after original expiry', async () => {
    const bridge = await fixture(); const manual = await bridge.create(1); await bridge.action(manual, 'deny'); bridge.advance(1001);
    expect((await bridge.clear()).removed).toBe(1);
    const automatic = await bridge.create(1); await bridge.action(automatic, 'deny');
    bridge.setTime(Date.parse(automatic.expiresAt) + 24 * hour - 1);
    expect((await bridge.get(automatic)).status).toBe(200);
    bridge.advance(1);
    expect((await bridge.get(automatic)).status).toBe(404);
    expect((await (await bridge.request('/api/requests')).json()).requests).toEqual([]);
  });

  it('broadcasts manual and automatic removals to all authenticated owner connections', async () => {
    const bridge = await fixture({ expiryIntervalMs: 10 }); const ended = await bridge.create(1); await bridge.action(ended, 'deny'); bridge.advance(1001);
    const first = await phone(bridge.url); const second = await phone(bridge.url);
    first.messages.length = 0; second.messages.length = 0;
    expect((await bridge.clear()).removed).toBe(1);
    expect((await first.next('requests')).requests).toEqual([]); expect((await second.next('requests')).requests).toEqual([]);
    const old = await bridge.create(1); await bridge.action(old, 'deny'); first.messages.length = 0; second.messages.length = 0;
    bridge.setTime(Date.parse(old.expiresAt) + 24 * hour);
    await expect.poll(() => first.messages.some(message => message.type === 'requests' && message.requests?.length === 0)).toBe(true);
    await expect.poll(() => second.messages.some(message => message.type === 'requests' && message.requests?.length === 0)).toBe(true);
  });

  it('protects a denied request while its approved browser is still opening', async () => {
    const opening = deferred(); const started = deferred(); let closed = false;
    const bridge = await fixture({ browserFactory: async () => { started.resolve(); await opening.promise; return { frame: async () => ({ data: '', width: 390, height: 720, url: 'https://example.com' }), input: async () => {}, close: async () => { closed = true; } }; } });
    cleanup.push(opening.resolve);
    const item = await bridge.create(1); await bridge.action(item, 'approve'); const client = await phone(bridge.url);
    client.send({ type: 'watch', requestId: item.id }); await started.promise;
    await bridge.action(item, 'deny'); bridge.advance(1001);
    expect(await bridge.clear()).toMatchObject({ removed: 0, protected: 1 }); expect((await bridge.get(item)).status).toBe(200);
    opening.resolve(); await expect.poll(() => closed).toBe(true); await tick();
    expect((await bridge.clear()).removed).toBe(1);
  });

  it('protects metadata while finalization is pending even after the browser closes', async () => {
    const preparing = deferred(); const started = deferred(); let closed = false;
    const bridge = await fixture({ browserFactory: async () => ({
      frame: async () => ({ data: '', width: 390, height: 720, url: 'https://example.com' }), input: async () => {},
      prepareHandoff: async () => { started.resolve(); await preparing.promise; }, close: async () => { closed = true; },
    }) });
    cleanup.push(preparing.resolve);
    const item = await bridge.create(1); await open(bridge, item);
    const completing = bridge.action(item, 'complete'); await started.promise; bridge.advance(1001);
    await bridge.clear(); await expect.poll(() => closed).toBe(true); await tick();
    expect(await bridge.clear()).toMatchObject({ removed: 0, protected: 1 });
    preparing.resolve(); expect((await completing).status).toBe(409); await tick();
    expect((await bridge.clear()).removed).toBe(1);
  });

  it('protects an orphaned input operation until it settles', async () => {
    const input = deferred(); const started = deferred();
    const bridge = await fixture({ browserFactory: async () => ({
      frame: async () => ({ data: '', width: 390, height: 720, url: 'https://example.com' }), input: async () => { started.resolve(); await input.promise; }, close: async () => {},
    }) });
    cleanup.push(input.resolve);
    const item = await bridge.create(1); const client = await open(bridge, item);
    client.send({ type: 'key', key: 'Enter' }); await started.promise; client.socket.close();
    await bridge.action(item, 'deny'); bridge.advance(1001); await tick();
    expect(await bridge.clear()).toMatchObject({ removed: 0, protected: 1 });
    input.resolve(); await tick(); expect((await bridge.clear()).removed).toBe(1);
  });

  it('protects a drain-only operation after completion times out and the browser has closed', async () => {
    const frame = deferred(); const started = deferred(); let closed = false;
    const bridge = await fixture({ inputDrainTimeoutMs: 10, browserFactory: async () => ({
      frame: async () => { started.resolve(); await frame.promise; return { data: '', width: 390, height: 720, url: 'https://example.com' }; }, input: async () => {}, close: async () => { closed = true; },
    }) });
    cleanup.push(frame.resolve);
    const item = await bridge.create(1); await bridge.action(item, 'approve'); const client = await phone(bridge.url);
    client.send({ type: 'watch', requestId: item.id }); await started.promise;
    expect((await bridge.action(item, 'complete')).status).toBe(504);
    bridge.advance(1001); await bridge.clear(); await expect.poll(() => closed).toBe(true); await tick();
    expect(await bridge.clear()).toMatchObject({ removed: 0, protected: 1 });
    frame.resolve(); await tick(); expect((await bridge.clear()).removed).toBe(1);
  });

  it('keeps closing references and does not block metadata APIs on a slow close', async () => {
    const closing = deferred(); const started = deferred(); let attempts = 0;
    const bridge = await fixture({ browserFactory: async () => ({
      cdpUrl: 'http://127.0.0.1:9333', frame: async () => ({ data: '', width: 390, height: 720, url: 'https://example.com' }), input: async () => {},
      close: async () => { attempts++; started.resolve(); await closing.promise; },
    }) });
    cleanup.push(closing.resolve);
    const item = await bridge.create(1); await open(bridge, item); await bridge.action(item, 'complete'); bridge.advance(1001);
    await bridge.request('/api/requests'); await started.promise;
    expect(await bridge.clear()).toMatchObject({ removed: 0, protected: 1 }); expect(attempts).toBe(1);
    expect((await bridge.get(item)).status).toBe(200); expect(attempts).toBe(1);
    closing.resolve(); await tick(); expect((await bridge.clear()).removed).toBe(1);
  });

  it('retains browser references after failed closure and retries before allowing removal', async () => {
    let failClose = true; let attempts = 0;
    const bridge = await fixture({ browserFactory: async () => ({
      frame: async () => ({ data: '', width: 390, height: 720, url: 'https://example.com' }), input: async () => {},
      close: async () => { attempts++; if (failClose) throw new Error('Synthetic close failure'); },
    }) });
    const item = await bridge.create(1); await open(bridge, item); await bridge.action(item, 'deny'); bridge.advance(1001);
    expect(await bridge.clear()).toMatchObject({ removed: 0, protected: 1 }); expect(attempts).toBeGreaterThan(1);
    failClose = false; await bridge.request('/api/requests'); await tick();
    expect((await bridge.clear()).removed).toBe(1);
  });

  it('enforces the 100-record cap without evicting unexpired terminal outcomes', async () => {
    const bridge = await fixture(); let first!: LoginRequest;
    for (let index = 0; index < 100; index++) { const item = await bridge.create(1800); if (!index) first = item; await bridge.action(item, 'deny'); }
    const input = { agent: 'Capacity fixture', title: 'Sign in', url: 'https://example.com', ttlSeconds: 120 };
    expect((await bridge.request('/api/requests', agent, 'POST', input)).status).toBe(429);
    expect((await bridge.get(first)).status).toBe(200);
    expect(await bridge.clear()).toMatchObject({ removed: 0, protected: 100 });
    bridge.advance(1800001);
    const created = await bridge.request('/api/requests', agent, 'POST', input); expect(created.status).toBe(201);
    expect((await bridge.get(first)).status).toBe(404);
    const result = await bridge.clear(); expect(result.removed).toBe(99); expect(result.requests).toHaveLength(1); expect(result.requests[0].status).toBe('pending');
  });
});
