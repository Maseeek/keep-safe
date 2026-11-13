import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createBridge, type BridgeOptions } from '../src/server';
import type { BrowserSession } from '../src/browser';
import type { ViewportRequest } from '../../shared/src/protocol';
import { connectionOrigin, tailnetHost } from '../src/connection-options';

const ownerToken = 'pairing-owner-secret';
const agentToken = 'pairing-agent-secret';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function start(options: Partial<BridgeOptions> = {}) {
  let clock = Date.now();
  const opened: Array<ViewportRequest | undefined> = [];
  const resized: ViewportRequest[] = [];
  const inputs: Array<{ type: string }> = [];
  const browser: BrowserSession = {
    cdpUrl: 'http://127.0.0.1:9333',
    frame: async () => ({ data: 'aW1hZ2U=', width: 390, height: 720, url: 'https://login.example.com/' }),
    input: async value => { inputs.push(value); return value.type === 'click' ? { editable: true, kind: 'password' as const } : undefined; },
    resize: async viewport => { resized.push(viewport); },
    close: async () => {},
  };
  const bridge = await createBridge({ ownerToken, agentToken, port: 0, now: () => clock, browserFactory: async input => { opened.push(input.viewport); return browser; }, ...options });
  cleanup.push(() => bridge.close());
  const call = async (path: string, body?: unknown, token?: string, origin?: string) => {
    const response = await fetch(`${bridge.url}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(origin ? { Origin: origin } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json().catch(() => ({})) as Record<string, any> };
  };
  const invite = async () => { const created = await call('/api/pairing', {}, ownerToken); expect(created.status).toBe(201); return created.data as { code: string; expiresAt: string }; };
  return { ...bridge, call, invite, opened, resized, inputs, advance(milliseconds: number) { clock += milliseconds; } };
}

function connect(url: string, token: string) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws');
  const messages: Array<{ type: string; [key: string]: unknown }> = [];
  cleanup.push(async () => { socket.terminate(); });
  socket.on('message', raw => { messages.push(JSON.parse(String(raw))); });
  const ready = new Promise<void>((resolve, reject) => { socket.once('open', () => { socket.send(JSON.stringify({ type: 'auth', token })); resolve(); }); socket.once('error', reject); });
  const until = async (type: string) => { for (let attempt = 0; attempt < 200; attempt++) { const found = messages.find(message => message.type === type); if (found) return found; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error(`No ${type} message arrived.`); };
  return { socket, messages, ready, until };
}

describe('one-time pairing codes', () => {
  it('lets only the owner key create a code, and trades it once for a revocable phone key', async () => {
    const bridge = await start();
    expect((await bridge.call('/api/pairing', {}, agentToken)).status).toBe(403);
    expect((await bridge.call('/api/pairing', {})).status).toBe(401);
    const { code, expiresAt } = await bridge.invite();
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect((await bridge.call('/api/pair/status', { code })).data).toMatchObject({ state: 'waiting' });

    // Typed codes arrive lower-case and grouped. No bearer token is involved.
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()}`;
    const paired = await bridge.call('/api/pair', { code: typed, name: 'Pixel' });
    expect(paired.status).toBe(201);
    expect(paired.data.token).toMatch(/^[a-f0-9]{64}$/);
    expect(paired.data.device.name).toBe('Pixel');
    expect(paired.data.info.pairingCodesAvailable).toBe(true);
    expect(JSON.stringify(paired.data)).not.toContain(ownerToken);
    expect(JSON.stringify(paired.data)).not.toContain(agentToken);

    expect((await bridge.call('/api/pair', { code, name: 'Second' })).status).toBe(401);
    expect((await bridge.call('/api/pair/status', { code })).data).toEqual({ state: 'claimed', name: 'Pixel' });

    // The phone key is an owner key for requests, but cannot invite phones.
    expect((await bridge.call('/api/requests', undefined, paired.data.token)).status).toBe(200);
    expect((await bridge.call('/api/pairing', {}, paired.data.token)).status).toBe(403);
    expect((await bridge.call('/api/status', undefined, agentToken)).data).toMatchObject({ phones: 1 });
    expect((await bridge.call(`/api/devices/${paired.data.device.id}/revoke`, {}, ownerToken)).status).toBe(200);
    expect((await bridge.call('/api/requests', undefined, paired.data.token)).status).toBe(401);
  });

  it('expires codes after ten minutes and cancels them after repeated wrong guesses', async () => {
    const bridge = await start();
    const first = await bridge.invite();
    bridge.advance(10 * 60_000 + 1);
    expect((await bridge.call('/api/pair', { code: first.code })).status).toBe(401);
    expect((await bridge.call('/api/pair/status', { code: first.code })).data.state).toBe('expired');

    const second = await bridge.invite();
    for (let guess = 0; guess < 10; guess++) expect((await bridge.call('/api/pair', { code: 'AAAAAAAA' })).status).toBe(401);
    expect((await bridge.call('/api/pair', { code: second.code })).status).toBe(401);
    expect((await bridge.call('/api/devices', undefined, ownerToken)).data.devices).toEqual([]);
  });

  it('keeps the allowed-origin check on the unauthenticated pairing route', async () => {
    const bridge = await start({ appUrl: 'https://app.example' });
    const { code } = await bridge.invite();
    expect((await bridge.call('/api/pair', { code }, undefined, 'https://evil.example')).status).toBe(403);
    expect((await bridge.call('/api/pair', { code }, undefined, 'https://app.example')).status).toBe(201);
  });

  it('renews an active phone and lets an idle one expire after 30 days', async () => {
    const bridge = await start();
    const { code } = await bridge.invite();
    const paired = await bridge.call('/api/pair', { code });
    const day = 24 * 60 * 60_000;
    expect(Date.parse(paired.data.device.expiresAt) - Date.parse(paired.data.device.createdAt)).toBe(30 * day);
    bridge.advance(20 * day);
    const renewed = await bridge.call('/api/devices', undefined, paired.data.token);
    expect(Date.parse(renewed.data.devices[0].expiresAt)).toBeGreaterThan(Date.parse(paired.data.device.expiresAt) + 19 * day);
    bridge.advance(31 * day);
    expect((await bridge.call('/api/devices', undefined, paired.data.token)).status).toBe(401);
  });
});

const relinkProof = (token: string, code: string) => createHmac('sha256', createHash('sha256').update(token).digest()).update(`keep-safe-relink:${code}`).digest('hex');

describe('scanning again and a changing public address', () => {
  it('keeps a paired phone\'s key when it scans a new code, and never accepts a wrong proof', async () => {
    const bridge = await start();
    const first = await bridge.call('/api/pair', { code: (await bridge.invite()).code, name: 'Pixel' });
    const { token, device } = first.data as { token: string; device: { id: string } };

    const second = await bridge.invite();
    const again = await bridge.call('/api/pair', { code: second.code, name: 'Renamed', device: { id: device.id, proof: relinkProof(token, second.code) } });
    expect(again.status).toBe(200);
    expect(again.data).toMatchObject({ relinked: true, device: { id: device.id, name: 'Pixel' } });
    expect(again.data.token).toBeUndefined();
    expect((await bridge.call('/api/pair/status', { code: second.code })).data).toEqual({ state: 'claimed', name: 'Pixel' });
    expect((await bridge.call('/api/devices', undefined, ownerToken)).data.devices).toHaveLength(1);
    expect((await bridge.call('/api/requests', undefined, token)).status).toBe(200);

    // A proof made for another code, or with another key, pairs a new phone instead.
    const third = await bridge.invite();
    const wrong = await bridge.call('/api/pair', { code: third.code, name: 'Other', device: { id: device.id, proof: relinkProof(token, second.code) } });
    expect(wrong.status).toBe(201);
    expect(wrong.data.device.id).not.toBe(device.id);
    expect(wrong.data.token).toMatch(/^[a-f0-9]{64}$/);
    // The proof alone is not a credential: without a valid code nothing happens.
    expect((await bridge.call('/api/pair', { code: 'AAAAAAAA', device: { id: device.id, proof: relinkProof(token, 'AAAAAAAA') } })).status).toBe(401);
  });

  it('builds the pairing link from the current public address and accepts that origin', async () => {
    let address: string | undefined;
    let state = 'starting';
    const bridge = await start({ appUrl: 'https://app.example', link: { url: () => address, state: () => state, ready: async () => !!address } });
    // No address yet: a code would be useless, so none is created.
    const early = await bridge.call('/api/pairing', {}, ownerToken);
    expect(early.status).toBe(503);
    expect((await bridge.call('/api/status', undefined, agentToken)).data).toMatchObject({ link: 'starting', version: '0.3.0' });
    expect((await bridge.call('/api/status', undefined, agentToken)).data.publicUrl).toBeUndefined();

    address = 'https://first-words.trycloudflare.com'; state = 'ready';
    const created = await bridge.call('/api/pairing', {}, ownerToken);
    expect(created.status).toBe(201);
    expect(created.data.link).toBe(`https://app.example/#pair=${created.data.code}&bridge=${encodeURIComponent(address)}`);
    expect(created.data.link).not.toContain(ownerToken);
    expect((await bridge.call('/api/pair/status', { code: created.data.code })).data.link).toBe(created.data.link);
    expect((await bridge.call('/api/status', undefined, agentToken)).data).toMatchObject({ link: 'ready', publicUrl: address });
    expect((await bridge.call('/api/pair/status', { code: created.data.code }, undefined, address)).status).toBe(200);

    // The address moved: the old origin stops being accepted and links follow.
    address = 'https://second-words.trycloudflare.com';
    expect((await bridge.call('/api/pair/status', { code: created.data.code }, undefined, 'https://first-words.trycloudflare.com')).status).toBe(403);
    expect((await bridge.call('/api/pair/status', { code: created.data.code })).data.link).toContain(encodeURIComponent(address));
    // Without a separate app, the bridge's own address is the whole link.
    const own = await start();
    const code = (await own.invite()).code;
    expect((await own.call('/api/pair/status', { code })).data.link).toBe(`${own.url}/#pair=${code}`);
  });
});

describe('phone-sized live view', () => {
  it('opens the browser at the phone\'s clamped size, resizes it, and reports typing targets without values', async () => {
    const bridge = await start();
    const created = await bridge.call('/api/requests', { agent: 'Codex', title: 'Sign in', url: 'https://example.com/login' }, agentToken);
    await bridge.call(`/api/requests/${created.data.id}/approve`, {}, ownerToken);
    const phone = connect(bridge.url, ownerToken);
    await phone.ready; await phone.until('ready');
    phone.socket.send(JSON.stringify({ type: 'watch', requestId: created.data.id, viewport: { width: 5000, height: 100, scale: 9, touch: true } }));
    await phone.until('frame');
    expect(bridge.opened).toEqual([{ width: 1280, height: 320, scale: 2, touch: true }]);

    phone.socket.send(JSON.stringify({ type: 'resize', width: 412, height: 700 }));
    phone.socket.send(JSON.stringify({ type: 'click', x: 10, y: 10 }));
    const hint = await phone.until('editable');
    expect(hint).toEqual({ type: 'editable', requestId: created.data.id, editable: true, kind: 'password' });
    expect(bridge.resized).toEqual([{ width: 412, height: 700, scale: 1, touch: false }]);
    expect(bridge.inputs.map(input => input.type)).toEqual(['click']);
    expect(phone.messages.filter(message => message.type === 'error')).toEqual([]);
  });

  it('keeps the earlier fixed size for a client that sends no viewport', async () => {
    const bridge = await start();
    const created = await bridge.call('/api/requests', { agent: 'Codex', title: 'Sign in', url: 'https://example.com/login' }, agentToken);
    await bridge.call(`/api/requests/${created.data.id}/approve`, {}, ownerToken);
    const phone = connect(bridge.url, ownerToken);
    await phone.ready; await phone.until('ready');
    phone.socket.send(JSON.stringify({ type: 'watch', requestId: created.data.id }));
    await phone.until('frame');
    expect(bridge.opened).toEqual([undefined]);
  });

  it('sends an unchanged page once a second instead of on every capture', async () => {
    const bridge = await start();
    const created = await bridge.call('/api/requests', { agent: 'Codex', title: 'Sign in', url: 'https://example.com/login' }, agentToken);
    await bridge.call(`/api/requests/${created.data.id}/approve`, {}, ownerToken);
    const phone = connect(bridge.url, ownerToken);
    await phone.ready; await phone.until('ready');
    phone.socket.send(JSON.stringify({ type: 'watch', requestId: created.data.id }));
    await phone.until('frame');
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(phone.messages.filter(message => message.type === 'frame').length).toBeLessThanOrEqual(2);
  });
});

describe('private-network listening', () => {
  it('also serves an extra loopback-range address and accepts its origin', async () => {
    const bridge = await start({ listenHosts: ['127.0.0.2'], extraOrigins: ['http://127.0.0.2:1'] });
    expect(bridge.listening).toEqual(['127.0.0.2']);
    const health = await fetch(`http://127.0.0.2:${bridge.port}/api/health`);
    expect(await health.json()).toEqual({ ok: true });
    const { code } = await bridge.invite();
    const response = await fetch(`http://127.0.0.2:${bridge.port}/api/pair/status`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.2:1' }, body: JSON.stringify({ code }) });
    expect(response.status).toBe(200);
  });

  it('reports an address it could not listen on without failing startup', async () => {
    const bridge = await start({ listenHosts: ['203.0.113.7'] });
    expect(bridge.listening).toEqual([]);
    expect((await bridge.call('/api/health')).data).toEqual({ ok: true });
  });

  it('accepts plain HTTP only on loopback, or on Tailscale addresses when asked', () => {
    expect(tailnetHost('100.89.197.113')).toBe(true);
    expect(tailnetHost('100.63.0.1')).toBe(false);
    expect(tailnetHost('pop-os.tail8fc8b4.ts.net')).toBe(true);
    expect(tailnetHost('192.168.1.20')).toBe(false);
    expect(tailnetHost('example.com')).toBe(false);
    expect(() => connectionOrigin('http://pop-os.tail8fc8b4.ts.net:4318')).toThrow();
    expect(connectionOrigin('http://pop-os.tail8fc8b4.ts.net:4318', { tailnetHttp: true })).toBe('http://pop-os.tail8fc8b4.ts.net:4318');
    expect(() => connectionOrigin('http://192.168.1.20:4318', { tailnetHttp: true })).toThrow();
    expect(() => connectionOrigin('http://example.com', { tailnetHttp: true })).toThrow();
    expect(connectionOrigin('https://example.com')).toBe('https://example.com');
  });
});
