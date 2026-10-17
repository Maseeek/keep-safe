import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { createECDH, randomBytes } from 'node:crypto';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import webpush from 'web-push';
import { createBridge, type BridgeOptions } from '../src/server';
import * as deviceModule from '../src/devices';
import type { DevicePairResult } from '../../shared/src/protocol';

const ownerToken = 'push-test-owner'; const agentToken = 'push-test-agent';
const vapid = { publicKey: 'unused-test-public', privateKey: 'unused-test-private' };
const subscription = { endpoint: 'https://fcm.googleapis.com/synthetic-push', keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) } };
const cleanup: Array<() => Promise<unknown>> = [];
const sendNotification = webpush.sendNotification.bind(webpush);
beforeEach(() => { vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} }); });
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close(); } finally { vi.restoreAllMocks(); vi.useRealTimers(); } });

async function files() {
  const directory = await mkdtemp(join(tmpdir(), 'keep-safe-push-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return { devicesFile: join(directory, 'devices.json'), subscriptionsFile: join(directory, 'subscriptions.json') };
}
async function start(options: Partial<BridgeOptions> = {}) {
  const bridge = await createBridge({ ownerToken, agentToken, port: 0, vapid, expiryIntervalMs: 60_000, browserFactory: async () => { throw new Error('Browser must not open in notification tests.'); }, ...options });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await bridge.close(); } };
  cleanup.push(close);
  async function request(path: string, token = ownerToken, body?: unknown, origin?: string) {
    return fetch(`${bridge.url}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(origin ? { Origin: origin } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function pair(name = 'Synthetic phone') {
    const response = await request('/api/devices', ownerToken, { name });
    expect(response.status).toBe(201); return response.json() as Promise<DevicePairResult>;
  }
  async function push(action: string, token = ownerToken, body: unknown = subscription) {
    const response = await request(`/api/push/${action}`, token, body);
    return { status: response.status, body: await response.json() };
  }
  async function create() {
    const response = await request('/api/requests', agentToken, { agent: 'Synthetic agent', title: 'Synthetic notification test', url: 'https://example.com/login' });
    expect(response.status).toBe(201); return response.json();
  }
  return { ...bridge, request, pair, push, create, close };
}

describe('per-bridge notification management', () => {
  it('advertises management, keeps responses minimal and requires valid owner authority and origin', async () => {
    const bridge = await start(); const paired = await bridge.pair();
    expect(await (await bridge.request('/api/info')).json()).toMatchObject({ pushManagementAvailable: true, pushEnabled: true });
    for (const action of ['status', 'unsubscribe']) {
      expect((await bridge.push(action, '')).status).toBe(401);
      expect((await bridge.push(action, 'wrong')).status).toBe(401);
      expect((await bridge.push(action, agentToken)).status).toBe(403);
      expect((await bridge.request(`/api/push/${action}`, ownerToken, subscription, 'https://untrusted.example')).status).toBe(403);
    }
    expect(await bridge.push('status', paired.token)).toEqual({ status: 200, body: { enabled: false } });
    expect(await bridge.push('subscribe', paired.token)).toEqual({ status: 200, body: { ok: true } });
    expect(await bridge.push('status', paired.token)).toEqual({ status: 200, body: { enabled: true } });
    expect(await bridge.push('unsubscribe', paired.token)).toEqual({ status: 200, body: { ok: true } });
    expect(await bridge.push('unsubscribe', paired.token)).toEqual({ status: 200, body: { ok: true } });
    expect(await bridge.push('status', paired.token)).toEqual({ status: 200, body: { enabled: false } });
  });

  it('matches endpoint, both keys and the exact master/device principal while allowing explicit re-enrollment', async () => {
    const bridge = await start(); const first = await bridge.pair('First'); const second = await bridge.pair('Second');
    await bridge.push('subscribe');
    expect((await bridge.push('status')).body).toEqual({ enabled: true });
    expect((await bridge.push('status', first.token)).body).toEqual({ enabled: false });
    await bridge.push('unsubscribe', first.token);
    expect((await bridge.push('status')).body).toEqual({ enabled: true });
    await bridge.push('subscribe', first.token);
    expect((await bridge.push('status')).body).toEqual({ enabled: false });
    expect((await bridge.push('status', first.token)).body).toEqual({ enabled: true });
    for (const token of [ownerToken, second.token]) {
      await bridge.push('unsubscribe', token);
      expect((await bridge.push('status', first.token)).body).toEqual({ enabled: true });
    }
    for (const changed of [
      { ...subscription, endpoint: subscription.endpoint + '-different' },
      { ...subscription, keys: { ...subscription.keys, p256dh: 'c'.repeat(87) } },
      { ...subscription, keys: { ...subscription.keys, auth: 'd'.repeat(22) } },
    ]) {
      expect((await bridge.push('status', first.token, changed)).body).toEqual({ enabled: false });
      await bridge.push('unsubscribe', first.token, changed);
      expect((await bridge.push('status', first.token)).body).toEqual({ enabled: true });
    }
    const other = { ...subscription, endpoint: subscription.endpoint + '-second' };
    await bridge.push('subscribe', second.token, other);
    await bridge.push('unsubscribe', first.token);
    expect((await bridge.push('status', first.token)).body).toEqual({ enabled: false });
    expect((await bridge.push('status', second.token, other)).body).toEqual({ enabled: true });
  });

  it('persists enrollment and exact removal across restart without returning subscription data', async () => {
    const paths = await files(); const initial = await start(paths); const paired = await initial.pair();
    const other = { ...subscription, endpoint: subscription.endpoint + '-paired' };
    await initial.push('subscribe'); await initial.push('subscribe', paired.token, other); await initial.close();
    const second = await start(paths);
    expect((await second.push('status')).body).toEqual({ enabled: true });
    expect((await second.push('status', paired.token, other)).body).toEqual({ enabled: true });
    expect((await second.push('status', paired.token)).body).toEqual({ enabled: false });
    await second.push('unsubscribe');
    expect((await stat(paths.subscriptionsFile)).mode & 0o777).toBe(0o600);
    await second.close();
    const third = await start(paths);
    expect((await third.push('status')).body).toEqual({ enabled: false });
    expect((await third.push('status', paired.token, other)).body).toEqual({ enabled: true });
  });

  it('migrates a verified master enrollment during explicit phone pairing and removes it on revocation', async () => {
    const paths = await files(); const bridge = await start(paths);
    await bridge.push('subscribe');
    const response = await bridge.request('/api/devices', ownerToken, { name: 'Remembered phone', notificationSubscription: subscription });
    expect(response.status).toBe(201); const paired = await response.json() as DevicePairResult;
    expect(Object.keys(paired).sort()).toEqual(['device', 'token']);
    expect((await bridge.push('status')).body).toEqual({ enabled: false });
    expect((await bridge.push('status', paired.token)).body).toEqual({ enabled: true });
    await bridge.close();
    const restarted = await start(paths);
    expect((await restarted.push('status', paired.token)).body).toEqual({ enabled: true });
    expect((await restarted.request(`/api/devices/${paired.device.id}/revoke`, ownerToken, {})).status).toBe(200);
    expect(JSON.parse(await readFile(paths.subscriptionsFile, 'utf8'))).toEqual([]);
    expect((await restarted.push('status', paired.token)).status).toBe(401);
    expect((await restarted.push('status')).body).toEqual({ enabled: false });
  });

  it('rejects mismatched migration proof before creating any phone or changing the master enrollment', async () => {
    const bridge = await start(); await bridge.push('subscribe');
    for (const changed of [
      { ...subscription, endpoint: subscription.endpoint + '-unknown' },
      { ...subscription, keys: { ...subscription.keys, p256dh: 'c'.repeat(87) } },
      { ...subscription, keys: { ...subscription.keys, auth: 'd'.repeat(22) } },
    ]) {
      const response = await bridge.request('/api/devices', ownerToken, { name: 'Uncreated phone', notificationSubscription: changed });
      expect(response.status).toBe(409);
      expect(Object.keys(await response.json())).toEqual(['error']);
      expect((await (await bridge.request('/api/devices')).json()).devices).toEqual([]);
      expect((await bridge.push('status')).body).toEqual({ enabled: true });
    }
    expect((await bridge.request('/api/devices', ownerToken, { name: 'Uncreated phone', notificationSubscription: 'invalid' })).status).toBe(400);
    const paired = await bridge.pair(); await bridge.push('subscribe', paired.token);
    expect((await bridge.request('/api/devices', ownerToken, { name: 'Other phone', notificationSubscription: subscription })).status).toBe(409);
    expect((await (await bridge.request('/api/devices')).json()).devices).toHaveLength(1);
  });

  it('rolls back an unpublished phone and restores the durable master enrollment after a migration write fails', async () => {
    const paths = await files(); let failMigration = false;
    const writer = deviceModule.atomicJsonWriter;
    vi.spyOn(deviceModule, 'atomicJsonWriter').mockImplementation(path => {
      const real = writer(path);
      return path !== paths.subscriptionsFile ? real : { ...real, write(value) {
        if (failMigration) { failMigration = false; return Promise.reject(new Error('Synthetic migration write failure.')); }
        return real.write(value);
      } };
    });
    const bridge = await start(paths); await bridge.push('subscribe'); failMigration = true;
    const response = await bridge.request('/api/devices', ownerToken, { name: 'Unpublished phone', notificationSubscription: subscription });
    expect(response.status).toBe(500);
    expect(Object.keys(await response.json())).toEqual(['error']);
    expect((await (await bridge.request('/api/devices')).json()).devices).toEqual([]);
    expect((await bridge.push('status')).body).toEqual({ enabled: true });
    expect(JSON.parse(await readFile(paths.devicesFile, 'utf8')).devices).toEqual([]);
    expect(JSON.parse(await readFile(paths.subscriptionsFile, 'utf8'))).toEqual([subscription]);
    await bridge.close();
    const restarted = await start(paths);
    expect((await restarted.push('status')).body).toEqual({ enabled: true });
    expect((await (await restarted.request('/api/devices')).json()).devices).toEqual([]);
  });

  it('preserves a concurrent re-enrollment when an in-flight pairing loses its original record', async () => {
    const paths = await files(); let release!: () => void; let persisted!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const phonePersisted = new Promise<void>(resolve => { persisted = resolve; });
    const originalStore = deviceModule.createDeviceStore;
    vi.spyOn(deviceModule, 'createDeviceStore').mockImplementation(async (...args) => {
      const store = await originalStore(...args);
      return { ...store, async pair(name) { const paired = await store.pair(name); persisted(); await barrier; return paired; } };
    });
    const bridge = await start(paths); await bridge.push('subscribe');
    const pairing = bridge.request('/api/devices', ownerToken, { name: 'Unpublished phone', notificationSubscription: subscription });
    try {
      await phonePersisted;
      const changed = { ...subscription, keys: { ...subscription.keys, auth: 'd'.repeat(22) } };
      await bridge.push('subscribe', ownerToken, changed);
      release();
      expect((await pairing).status).toBe(500);
      expect((await (await bridge.request('/api/devices')).json()).devices).toEqual([]);
      expect((await bridge.push('status')).body).toEqual({ enabled: false });
      expect((await bridge.push('status', ownerToken, changed)).body).toEqual({ enabled: true });
      expect(JSON.parse(await readFile(paths.subscriptionsFile, 'utf8'))).toEqual([changed]);
    } finally { release(); await pairing; }
  });

  it('permits status and cleanup when delivery is unavailable, without permitting new subscriptions', async () => {
    const paths = await files(); const initial = await start(paths);
    await initial.push('subscribe'); await initial.close();
    const disabled = await start({ ...paths, vapid: undefined });
    expect((await disabled.push('subscribe')).status).toBe(409);
    expect((await disabled.push('status')).body).toEqual({ enabled: true });
    expect((await disabled.push('unsubscribe')).body).toEqual({ ok: true });
    expect((await disabled.push('status')).body).toEqual({ enabled: false });
  });

  it.each(['status', 'unsubscribe'])('uses the bounded subscription parser for %s', async action => {
    const bridge = await start();
    for (const body of [{ endpoint: subscription.endpoint }, { ...subscription, endpoint: 'https://127.0.0.1/private' }, { ...subscription, keys: { ...subscription.keys, auth: 'invalid' } }]) {
      expect((await bridge.push(action, ownerToken, body)).status).toBe(400);
    }
    expect((await bridge.push(action, ownerToken, { subscription })).body).toEqual(action === 'status' ? { enabled: false } : { ok: true });
    expect((await bridge.push(action, ownerToken, { ...subscription, padding: 'x'.repeat(17_000) })).status).toBe(413);
    const wrongContentType = await fetch(bridge.url + `/api/push/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'text/plain' }, body: JSON.stringify(subscription) });
    expect(wrongContentType.status).toBe(415);
  });

  it.each(['subscribe', 'status', 'unsubscribe'].flatMap(action => ['expiry', 'revocation'].map(change => ({ action, change }))))('revalidates $action authority after a slow body during $change', async ({ action, change }) => {
    let clock = Date.now(); const bridge = await start({ now: () => clock }); const paired = await bridge.pair();
    await bridge.push('subscribe', paired.token);
    let incoming: IncomingMessage | undefined;
    bridge.server.on('request', request => { if (request.url === `/api/push/${action}`) incoming = request; });
    const body = JSON.stringify(subscription); const midpoint = Math.floor(body.length / 2);
    const response = new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
      const request = httpRequest(bridge.url + `/api/push/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${paired.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, result => {
        let content = ''; result.on('data', part => { content += part; }); result.on('end', () => resolve({ status: result.statusCode, body: JSON.parse(content) }));
      });
      request.once('error', reject); request.write(body.slice(0, midpoint));
      void (async () => {
        try {
          // The async body iterator has consumed the first chunk and is now
          // waiting for the remainder, not merely waiting for request headers.
          await expect.poll(() => !!incoming && incoming.listenerCount('readable') > 0 && incoming.readableLength === 0).toBe(true);
          if (change === 'expiry') clock = Date.parse(paired.device.expiresAt) + 1;
          else expect((await bridge.request(`/api/devices/${paired.device.id}/revoke`, ownerToken, {})).status).toBe(200);
          request.end(body.slice(midpoint));
        } catch (error) { request.destroy(); reject(error); }
      })();
    });
    expect((await response).status).toBe(401);
  });

  it('persists 404/410 pruning while retaining transient failures, and does not resend pruned endpoints after restart', async () => {
    const paths = await files(); const bridge = await start(paths);
    const items = ['404', '410', '503', 'network'].map(suffix => ({ ...subscription, endpoint: subscription.endpoint + '-' + suffix }));
    for (const item of items) await bridge.push('subscribe', ownerToken, item);
    const send = vi.mocked(webpush.sendNotification).mockImplementation(async item => { throw Object.assign(new Error('Synthetic transport failure.'), { statusCode: Number(item.endpoint.split('-').at(-1)) || undefined }); });
    await bridge.create(); await bridge.close();
    expect(send).toHaveBeenCalledTimes(4);
    expect(JSON.parse(await readFile(paths.subscriptionsFile, 'utf8')).map((item: { endpoint: string }) => item.endpoint)).toEqual(items.slice(2).map(item => item.endpoint));
    send.mockClear(); send.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    const restarted = await start(paths);
    for (const [index, item] of items.entries()) expect((await restarted.push('status', ownerToken, item)).body).toEqual({ enabled: index >= 2 });
    await restarted.create(); await restarted.close();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not let a stale dead-endpoint response delete a newer paired-device enrollment', async () => {
    const paths = await files(); const bridge = await start(paths); const paired = await bridge.pair();
    await bridge.push('subscribe');
    let rejectSend!: (error: Error) => void;
    const pendingSend = new Promise<never>((_resolve, reject) => { rejectSend = reject; });
    vi.mocked(webpush.sendNotification).mockReturnValueOnce(pendingSend);
    await bridge.create();
    await expect.poll(() => vi.mocked(webpush.sendNotification).mock.calls.length).toBe(1);
    await bridge.push('subscribe', paired.token);
    rejectSend(Object.assign(new Error('Synthetic expired endpoint.'), { statusCode: 410 }));
    await bridge.close();
    const restarted = await start(paths);
    expect((await restarted.push('status', paired.token)).body).toEqual({ enabled: true });
    expect((await restarted.push('status')).body).toEqual({ enabled: false });
  });

  it('contains a background pruning-write failure without rejecting request creation or shutdown', async () => {
    const paths = await files(); const bridge = await start(paths);
    await bridge.push('subscribe');
    await unlink(paths.subscriptionsFile); await mkdir(paths.subscriptionsFile);
    vi.mocked(webpush.sendNotification).mockRejectedValueOnce(Object.assign(new Error('Synthetic dead endpoint.'), { statusCode: 410 }));
    await bridge.create();
    await expect(bridge.close()).resolves.toBeUndefined();
  });

  it.each(['hanging', 'trickling', 'shutdown'])('bounds real web-push requests at the private-agent boundary during $0 delivery', async mode => {
    const key = createECDH('prime256v1'); key.generateKeys();
    const valid = { ...subscription, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    const bridge = await start({ vapid: webpush.generateVAPIDKeys() });
    await bridge.push('subscribe', ownerToken, valid);
    let started!: () => void;
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    let responseStarted = false;
    const stream = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        if (!responseStarted) {
          responseStarted = true;
          queueMicrotask(() => {
            if (mode === 'trickling') stream.push('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n');
            started();
          });
        }
        callback();
      },
    });
    // Simulated socket transport only: no DNS, TLS connection, provider or
    // payload inspection. Inactivity never fires, so only the wall deadline or
    // explicit shutdown can finish this real web-push ClientRequest.
    Object.assign(stream, { setTimeout: () => stream, setNoDelay: () => stream, setKeepAlive: () => stream, ref: () => stream, unref: () => stream });
    vi.mocked(webpush.sendNotification).mockImplementation((item, payload, options) => {
      const agent = options!.agent!;
      expect(agent).toBeInstanceOf(HttpsAgent);
      vi.spyOn(agent, 'createConnection').mockImplementation(() => stream as Socket);
      return sendNotification(item, payload, options);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const scheduled = vi.spyOn(globalThis, 'setTimeout');
    const cancelled = vi.spyOn(globalThis, 'clearTimeout');
    // A non-pooled local API request keeps unrelated undici keepalive timers
    // out of the transport's clock/cleanup assertions.
    const created = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(bridge.url + '/api/requests', { method: 'POST', agent: false, headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end(JSON.stringify({ agent: 'Synthetic agent', title: 'Synthetic timeout test', url: 'https://example.com/login' }));
    });
    expect(created).toBe(201); await requestStarted;
    if (mode === 'shutdown') await bridge.close();
    else {
      await vi.advanceTimersByTimeAsync(4999);
      if (mode === 'trickling') stream.push('1\r\ny\r\n');
      expect(stream.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(stream.destroyed).toBe(true);
      expect((await bridge.push('status', ownerToken, valid)).body).toEqual({ enabled: true });
      await bridge.close();
    }
    expect(stream.destroyed).toBe(true);
    const deadlines = scheduled.mock.calls.flatMap((call, index) => call[1] === 5000 ? [scheduled.mock.results[index].value] : []);
    expect(deadlines).toHaveLength(1);
    for (const deadline of deadlines) expect(cancelled.mock.calls.some(call => call[0] === deadline)).toBe(true);
  });
});
