import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createBridge, type BridgeOptions } from '../src/server';
import type { DevicePairResult } from '../../shared/src/protocol';

const rootToken = 'bootstrap-master-token'; const agentToken = 'agent-token';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });
async function files() {
  const directory = await mkdtemp(join(tmpdir(), 'keep-safe-devices-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return { devicesFile: join(directory, 'devices.json'), subscriptionsFile: join(directory, 'subscriptions.json') };
}
async function start(options: Partial<BridgeOptions> = {}) {
  const inputs: unknown[] = [];
  const bridge = await createBridge({ ownerToken: rootToken, agentToken, port: 0, browserFactory: async () => ({ cdpUrl: 'http://127.0.0.1:9333', frame: async () => ({ data: 'aW1hZ2U=', width: 390, height: 720, url: 'https://example.com/login' }), input: async input => { inputs.push(input); }, close: async () => {} }), ...options });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await bridge.close(); } };
  cleanup.push(close);
  async function request(path: string, token = rootToken, method = 'GET', body?: unknown) {
    return fetch(`${bridge.url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  async function pair(name = 'My phone') { const result = await request('/api/devices', rootToken, 'POST', { name }); expect(result.status).toBe(201); return result.json() as Promise<DevicePairResult>; }
  return { ...bridge, request, pair, inputs, close };
}
async function phone(url: string, token: string) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws');
  const messages: Array<{ type: string; [key: string]: unknown }> = [];
  let closeCode: number | undefined;
  socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
  socket.on('close', code => { closeCode = code; });
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  async function next(type: string) {
    await expect.poll(() => messages.some(message => message.type === type), { timeout: 3000 }).toBe(true);
    return messages.splice(messages.findIndex(message => message.type === type), 1)[0];
  }
  send({ type: 'auth', token });
  return { socket, send, next, get closeCode() { return closeCode; }, messages };
}
const subscription = { endpoint: 'https://fcm.googleapis.com/test-device-subscription', keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) } };

describe('revocable phone pairing', () => {
  it('returns a one-time token, persists only its digest, and enforces owner-only device roles', async () => {
    const paths = await files(); const bridge = await start(paths);
    const paired = await bridge.pair();
    expect(paired.token).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(paired.device.expiresAt) - Date.parse(paired.device.createdAt)).toBe(7 * 24 * 60 * 60 * 1000);
    const stored = await readFile(paths.devicesFile, 'utf8');
    expect(stored).not.toContain(paired.token);
    expect(JSON.parse(stored).devices[0].digest).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(paths.devicesFile)).mode & 0o777).toBe(0o600);
    expect((await bridge.request('/api/devices', agentToken)).status).toBe(403);
    expect((await bridge.request('/api/devices', agentToken, 'POST', { name: 'Unauthorized' })).status).toBe(403);
    expect((await bridge.request('/api/devices', paired.token, 'POST', { name: 'Unauthorized expansion' })).status).toBe(403);
    expect((await bridge.request('/api/requests', paired.token, 'POST', { agent: 'Fake agent', title: 'Login', url: 'https://example.com' })).status).toBe(403);
    expect((await bridge.request('/api/info', paired.token)).status).toBe(200);
    const ownerList = await (await bridge.request('/api/devices')).json();
    expect(ownerList.devices[0].current).toBeUndefined();
    expect(JSON.stringify(ownerList)).not.toContain('digest');
    expect(JSON.stringify(ownerList)).not.toContain(paired.token);
    const currentList = await (await bridge.request('/api/devices', paired.token)).json();
    expect(currentList.devices[0]).toMatchObject({ id: paired.device.id, current: true });
  });

  it('reconnects a persisted phone after restart and updates last-seen without persisting its token', async () => {
    const paths = await files(); let clock = Date.now();
    const initial = await start({ ...paths, now: () => clock }); const paired = await initial.pair();
    await initial.close();
    clock += 61_000;
    const restarted = await start({ ...paths, now: () => clock });
    expect((await restarted.request('/api/info', paired.token)).status).toBe(200);
    const socket = await phone(restarted.url, paired.token); await socket.next('ready');
    await restarted.close();
    const stored = await readFile(paths.devicesFile, 'utf8');
    expect(stored).not.toContain(paired.token);
    expect(JSON.parse(stored).devices[0].lastSeenAt).toBe(new Date(clock).toISOString());
  });

  it('expires paired phones, closes sockets and prunes their push subscriptions', async () => {
    const paths = await files(); let clock = Date.now();
    const bridge = await start({ ...paths, now: () => clock, expiryIntervalMs: 10, vapid: { publicKey: 'unused-test-key', privateKey: 'unused-test-key' } });
    const paired = await bridge.pair();
    expect((await bridge.request('/api/push/subscribe', paired.token, 'POST', subscription)).status).toBe(200);
    expect(JSON.parse(await readFile(paths.subscriptionsFile, 'utf8'))[0].deviceId).toBe(paired.device.id);
    const socket = await phone(bridge.url, paired.token); await socket.next('ready');
    clock = Date.parse(paired.device.expiresAt) + 1;
    await expect.poll(() => socket.closeCode).toBe(4001);
    expect((await bridge.request('/api/info', paired.token)).status).toBe(401);
    expect((await (await bridge.request('/api/devices')).json()).devices).toHaveLength(0);
    expect(JSON.parse(await readFile(paths.devicesFile, 'utf8')).devices).toHaveLength(0);
    expect(JSON.parse(await readFile(paths.subscriptionsFile, 'utf8'))).toEqual([]);
  });

  it('revokes a live phone immediately, stops its control and releases control to another owner', async () => {
    const bridge = await start(await files()); const paired = await bridge.pair();
    const item = await (await bridge.request('/api/requests', agentToken, 'POST', { agent: 'Codex', title: 'Login', url: 'https://example.com/login' })).json();
    await bridge.request(`/api/requests/${item.id}/approve`, paired.token, 'POST');
    const socket = await phone(bridge.url, paired.token); await socket.next('ready');
    socket.send({ type: 'watch', requestId: item.id }); await socket.next('frame');
    socket.send({ type: 'key', key: 'Enter' });
    await expect.poll(() => bridge.inputs.length).toBe(1);
    expect((await bridge.request(`/api/devices/${paired.device.id}/revoke`, rootToken, 'POST')).status).toBe(200);
    await expect.poll(() => socket.closeCode).toBe(4001);
    expect((await bridge.request(`/api/requests/${item.id}/complete`, paired.token, 'POST')).status).toBe(401);
    const rejected = await phone(bridge.url, paired.token);
    await expect.poll(() => rejected.closeCode).toBe(4001);
    expect(rejected.messages).toHaveLength(0);
    const master = await phone(bridge.url, rootToken); await master.next('ready');
    master.send({ type: 'watch', requestId: item.id }); await master.next('frame');
    expect(bridge.inputs).toHaveLength(1);
  });

  it('lets a paired phone forget itself and removes only its own notification mapping', async () => {
    const paths = await files(); const bridge = await start({ ...paths, vapid: { publicKey: 'unused', privateKey: 'unused' } });
    const paired = await bridge.pair();
    await bridge.request('/api/push/subscribe', paired.token, 'POST', subscription);
    await bridge.request('/api/push/subscribe', rootToken, 'POST', { ...subscription, endpoint: subscription.endpoint + '-root' });
    expect((await bridge.request(`/api/devices/${paired.device.id}/revoke`, paired.token, 'POST')).status).toBe(200);
    expect((await bridge.request('/api/info', paired.token)).status).toBe(401);
    const remaining = JSON.parse(await readFile(paths.subscriptionsFile, 'utf8'));
    expect(remaining).toHaveLength(1); expect(remaining[0].deviceId).toBeUndefined();
  });

  it('caps active paired devices and permits replacement after revocation', async () => {
    const bridge = await start(await files()); const phones = [];
    for (let index = 0; index < 10; index++) phones.push(await bridge.pair(`Phone ${index}`));
    expect((await bridge.request('/api/devices', rootToken, 'POST', { name: 'Eleventh phone' })).status).toBe(429);
    await bridge.request(`/api/devices/${phones[0].device.id}/revoke`, rootToken, 'POST');
    expect((await bridge.pair('Replacement phone')).device.name).toBe('Replacement phone');
  });

  it('serializes concurrent pairing and revocation into complete owner-only JSON files', async () => {
    const paths = await files(); const bridge = await start(paths);
    const paired = await Promise.all(Array.from({ length: 8 }, (_value, index) => bridge.pair(`Phone ${index}`)));
    await Promise.all(paired.slice(0, 4).map(device => bridge.request(`/api/devices/${device.device.id}/revoke`, rootToken, 'POST')));
    const stored = await readFile(paths.devicesFile, 'utf8');
    expect(JSON.parse(stored).devices).toHaveLength(4);
    for (const device of paired) expect(stored).not.toContain(device.token);
    expect((await stat(paths.devicesFile)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(paths.devicesFile, '..'))).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('migrates legacy root push records while removing unknown device records on startup', async () => {
    const paths = await files();
    await writeFile(paths.subscriptionsFile, JSON.stringify([subscription, { ...subscription, endpoint: subscription.endpoint + '-expired', deviceId: '00000000-0000-0000-0000-000000000000' }]));
    await start(paths);
    const records = JSON.parse(await readFile(paths.subscriptionsFile, 'utf8'));
    expect(records).toEqual([subscription]);
  });
});
