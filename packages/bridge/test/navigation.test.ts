import { createServer, type ServerResponse } from 'node:http';
import { createServer as netServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openBrowser, type BrowserSession } from '../src/browser';
import { createBridge, type BridgeOptions } from '../src/server';
import type { DevicePairResult, ServerMessage } from '../../shared/src/protocol';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const owner = 'synthetic-navigation-owner'; const agent = 'synthetic-navigation-agent';

async function site() {
  let posts = 0; let hold = false; let slowRequests = 0; let disconnected = 0; let held: ServerResponse | undefined;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'text/html');
    if (request.method === 'POST') { posts++; request.resume(); request.on('end', () => response.end('<h1 id="posted">Synthetic POST result</h1><a href="/next">Next</a>')); return; }
    if (request.url === '/slow') {
      slowRequests++;
      if (hold) { held = response; response.on('close', () => { disconnected++; }); return; }
      response.end('<h1 id="slow">Synthetic old page</h1>'); return;
    }
    response.end('<h1>Synthetic navigation</h1><form action="/posted" method="post"><label>Password<input id="password" name="password" type="password"></label><button>Submit synthetic form</button></form><a href="/next">Next</a>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, get posts() { return posts; }, get slowRequests() { return slowRequests; }, get disconnected() { return disconnected; }, get heldDestroyed() { return held?.destroyed; }, hold: () => { hold = true; }, release: () => { held?.end('<h1 id="late">Synthetic late response</h1>'); } };
}
async function managed(url: string) {
  const session = await openBrowser({ url, allowLocalUrls: true }); cleanup.push(() => session.close());
  const observer = await chromium.connectOverCDP(session.cdpUrl!); cleanup.push(() => observer.close());
  const page = observer.contexts().flatMap(context => context.pages()).find(page => page.url() === url)!;
  return { session, page };
}
async function phone(url: string, token = owner) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws'); const messages: ServerMessage[] = []; const received: ServerMessage[] = [];
  socket.on('message', data => { const message = JSON.parse(data.toString()) as ServerMessage; messages.push(message); received.push(message); });
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  cleanup.push(async () => socket.terminate());
  const send = (message: object) => socket.send(JSON.stringify(message));
  const next = async <T extends ServerMessage['type']>(type: T) => { await expect.poll(() => messages.some(message => message.type === type)).toBe(true); return messages.splice(messages.findIndex(message => message.type === type), 1)[0] as Extract<ServerMessage, { type: T }>; };
  send({ type: 'auth', token });
  return { socket, send, next, messages, received };
}
async function bridgeFixture(custom: Partial<BrowserSession> = {}, options: Partial<BridgeOptions> = {}) {
  let navigations = 0; let inputs = 0; let prepared = 0;
  const browser: BrowserSession = { cdpUrl: 'http://127.0.0.1:9333',
    frame: async () => ({ data: 'aW1hZ2U=', width: 390, height: 720, url: 'https://example.com/current', navigationAvailable: true }),
    navigate: async () => { navigations++; }, input: async () => { inputs++; }, prepareHandoff: async () => { prepared++; }, close: async () => {}, ...custom };
  const bridge = await createBridge({ ownerToken: owner, agentToken: agent, port: 0, inputDrainTimeoutMs: 20, browserFactory: async () => browser, ...options }); cleanup.push(() => bridge.close());
  const request = async (path: string, token = owner, method = 'GET', body?: object) => fetch(bridge.url + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const item = await (await request('/api/requests', agent, 'POST', { agent: 'Synthetic navigation agent', title: 'Navigation fixture', url: 'https://example.com/start', ttlSeconds: 120 })).json() as { id: string; expiresAt: string };
  await request(`/api/requests/${item.id}/approve`, owner, 'POST', {});
  const controller = await phone(bridge.url); await controller.next('ready'); controller.send({ type: 'watch', requestId: item.id }); const first = await controller.next('frame');
  return { ...bridge, request, item, controller, first, get navigations() { return navigations; }, get inputs() { return inputs; }, get prepared() { return prepared; } };
}

describe('managed browser navigation safety', () => {
  it('supports GET back, forward and reload and invalidates inspected controls', async () => {
    const server = await site(); const { session, page } = await managed(server.origin + '/start');
    const before = await session.inspectControls!(); await page.getByRole('link', { name: 'Next' }).click();
    await session.navigate!('back'); expect(page.url()).toBe(server.origin + '/start');
    await expect(session.input({ type: 'focus', snapshotId: before.snapshotId, controlId: before.controls[0].id })).rejects.toThrow();
    await session.navigate!('forward'); expect(page.url()).toBe(server.origin + '/next'); await session.navigate!('reload'); expect(page.url()).toBe(server.origin + '/next');
    expect((await session.frame()).navigationAvailable).toBe(true); expect(server.posts).toBe(0);
  });

  it('blocks POST reload before another submission reaches the server', async () => {
    const server = await site(); const { session, page } = await managed(server.origin + '/start');
    await page.locator('#password').fill('public-synthetic-password'); await page.getByRole('button').click(); await page.locator('#posted').waitFor(); expect(server.posts).toBe(1);
    await expect(session.navigate!('reload')).rejects.toMatchObject({ reason: 'form' }); expect(server.posts).toBe(1);
  });

  it('refuses a history target mutated by password-clearing handlers', async () => {
    const server = await site(); const { session, page } = await managed(server.origin + '/start'); await page.goto(server.origin + '/next');
    await page.locator('#password').fill('public-synthetic-password');
    await page.evaluate(() => document.querySelector('#password')!.addEventListener('input', () => { history.pushState({}, '', '/mutated'); }, { once: true }));
    await expect(session.navigate!('back')).rejects.toMatchObject({ reason: 'changed' }); expect(page.url()).toBe(server.origin + '/mutated');
    expect(await page.locator('#password').evaluate(input => (input as HTMLInputElement).value === '')).toBe(true); expect(server.posts).toBe(0);
  });

  it('blocks the first document POST of a popup opened by password clearing', async () => {
    const server = await site(); const { session, page } = await managed(server.origin + '/start'); await page.goto(server.origin + '/next');
    await page.locator('#password').fill('public-synthetic-password');
    await page.evaluate(() => document.querySelector('#password')!.addEventListener('input', () => {
      const form = document.createElement('form'); form.action = '/posted'; form.method = 'POST'; form.target = 'synthetic-navigation-popup';
      document.body.append(form); window.open('about:blank', form.target); form.submit();
    }, { once: true }));
    const blocked = page.context().waitForEvent('requestfailed', { predicate: request => request.isNavigationRequest() && request.method() === 'POST' });
    await expect(session.navigate!('back')).rejects.toThrow(); await blocked;
    expect(server.posts).toBe(0); expect(await page.locator('#password').evaluate(input => (input as HTMLInputElement).value === '')).toBe(true);
  });

  it('stops a held GET navigation before failure and cannot commit its late response', async () => {
    const server = await site(); const { session, page } = await managed(server.origin + '/slow'); await page.goto(server.origin + '/next'); server.hold();
    const navigation = session.navigate!('back'); let finished = false; void navigation.then(() => { finished = true; }, () => { finished = true; });
    await expect.poll(() => server.slowRequests).toBe(2); expect(finished).toBe(false);
    await expect(navigation).rejects.toMatchObject({ reason: 'timeout' });
    await expect.poll(() => server.disconnected).toBe(1); expect(server.heldDestroyed).toBe(true);
    server.release(); expect(page.url()).not.toBe(server.origin + '/slow'); expect(await page.locator('#late').count()).toBe(0); expect(server.posts).toBe(0);
    expect((await session.frame()).navigationAvailable).toBe(true);
  }, 20000);

  it('does not offer navigation on an attached browser and preserves its process', async () => {
    const server = await site(); const temporary = netServer(); await new Promise<void>(resolve => temporary.listen(0, '127.0.0.1', resolve));
    const port = (temporary.address() as { port: number }).port; await new Promise<void>(resolve => temporary.close(() => resolve()));
    const external = await chromium.launch({ args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'] }); cleanup.push(() => external.close());
    const page = await external.newPage(); await page.goto(server.origin + '/start');
    const attached = await openBrowser({ url: page.url(), cdpUrl: `http://127.0.0.1:${port}`, allowLocalUrls: true }); cleanup.push(() => attached.close());
    expect(attached.navigate).toBeUndefined(); expect((await attached.frame()).navigationAvailable).toBe(false);
    await attached.close(); await page.getByRole('heading', { name: 'Synthetic navigation', exact: true }).waitFor(); expect(page.isClosed()).toBe(false);
  });

  it('keeps concurrent close callers pending until owned browser cleanup actually settles', async () => {
    const server = await site(); const actualLaunch = chromium.launch.bind(chromium); let actual!: Awaited<ReturnType<typeof chromium.launch>>;
    const launch = vi.spyOn(chromium, 'launch').mockImplementation(async options => { actual = await actualLaunch(options); return actual; });
    let session: BrowserSession;
    try { session = await openBrowser({ url: server.origin + '/start', allowLocalUrls: true }); cleanup.push(() => session.close()); }
    finally { launch.mockRestore(); }
    const context = actual.contexts()[0]; const page = context.pages()[0]; const close = context.close.bind(context); const gate = deferred(); const started = deferred(); cleanup.push(async () => gate.resolve());
    const closing = vi.spyOn(context, 'close').mockImplementation(async options => { started.resolve(); await gate.promise; await close(options); });
    try {
      const first = session.close(); await started.promise; let secondSettled = false;
      const second = session.close().then(() => { secondSettled = true; });
      await page.evaluate(() => document.readyState); expect(secondSettled).toBe(false);
      gate.resolve(); await Promise.all([first, second]); expect(page.isClosed()).toBe(true); expect(closing).toHaveBeenCalledTimes(1);
    } finally { gate.resolve(); closing.mockRestore(); }
  });
});

describe('owner navigation protocol barriers', () => {
  it('validates owner actions and returns correlated results with a new frame epoch', async () => {
    const bridge = await bridgeFixture(); expect(bridge.info.navigationAvailable).toBe(true); expect(bridge.first.navigationAvailable).toBe(true);
    for (const message of [{ type: 'navigate', direction: 'https://example.com', navigationId: randomUUID() }, { type: 'navigate', direction: 'reload', navigationId: 'wrong' }, { type: 'navigate', direction: 'reload', navigationId: '-'.repeat(36) }, { type: 'navigate', direction: 'reload', navigationId: randomUUID(), url: 'https://example.com' }]) { bridge.controller.send(message); await bridge.controller.next('error'); }
    expect(bridge.navigations).toBe(0);
    const id = randomUUID(); bridge.controller.send({ type: 'navigate', direction: 'reload', navigationId: id }); const result = await bridge.controller.next('navigated');
    expect(result).toMatchObject({ requestId: bridge.item.id, navigationId: id, ok: true }); expect(result.frameEpoch).not.toBe(bridge.first.frameEpoch);
    await expect.poll(() => bridge.controller.messages.some(message => message.type === 'frame' && message.frameEpoch === result.frameEpoch)).toBe(true);
    // The periodic stream may already have queued an old frame BEFORE the
    // command. Only frames delivered after its acknowledgement must be fresh.
    const after = bridge.controller.received.slice(bridge.controller.received.indexOf(result) + 1).filter(message => message.type === 'frame');
    expect(after.length).toBeGreaterThan(0); expect(after.every(message => message.frameEpoch === result.frameEpoch)).toBe(true); expect(bridge.navigations).toBe(1);
    const rejected = await phone(bridge.url, agent); await expect.poll(() => rejected.socket.readyState).toBe(WebSocket.CLOSED); expect(bridge.navigations).toBe(1);
  });

  it('does not publish a held pre-navigation frame or restore its input bounds', async () => {
    const held = deferred(); const started = deferred(); let calls = 0;
    const bridge = await bridgeFixture({ frame: async () => { calls++; if (calls === 2) { started.resolve(); await held.promise; return { data: 'aW1hZ2U=', width: 999, height: 999, url: 'https://stale.example.com', navigationAvailable: true }; } return { data: 'aW1hZ2U=', width: 200, height: 300, url: 'https://fresh.example.com', navigationAvailable: true }; } });
    cleanup.push(async () => held.resolve()); await started.promise;
    bridge.controller.send({ type: 'navigate', direction: 'reload', navigationId: randomUUID() }); const ack = await bridge.controller.next('navigated'); held.resolve();
    bridge.controller.send({ type: 'click', x: 500, y: 500 }); await bridge.controller.next('error');
    const fresh = await bridge.controller.next('frame'); expect(fresh.frameEpoch).toBe(ack.frameEpoch); expect(fresh.width).toBe(200); expect(bridge.inputs).toBe(0);
    expect(bridge.controller.messages.some(message => message.type === 'frame' && message.url === 'https://stale.example.com')).toBe(false);
  });

  it('retains navigation on the handback barrier after the owner disconnects', async () => {
    const gate = deferred(); const started = deferred(); const bridge = await bridgeFixture({ navigate: async () => { started.resolve(); await gate.promise; } }); cleanup.push(async () => gate.resolve());
    bridge.controller.send({ type: 'navigate', direction: 'reload', navigationId: randomUUID() }); await started.promise; bridge.controller.socket.close();
    const complete = await bridge.request(`/api/requests/${bridge.item.id}/complete`, owner, 'POST', {}); expect(complete.status).toBe(504); expect(bridge.prepared).toBe(0);
    expect((await (await bridge.request(`/api/requests/${bridge.item.id}`, agent)).json()).browser).toBeUndefined(); gate.resolve();
    await expect.poll(async () => (await bridge.request(`/api/requests/${bridge.item.id}/complete`, owner, 'POST', {})).status).toBe(200);
    expect(bridge.prepared).toBe(1); expect(bridge.controller.messages.some(message => message.type === 'navigated')).toBe(false);
  });

  it('correlates sanitized failures and only advertises a browser with an actual navigation method', async () => {
    const bridge = await bridgeFixture({ navigate: async () => { throw new Error('private-browser-detail'); } }); const id = randomUUID();
    bridge.controller.send({ type: 'navigate', direction: 'reload', navigationId: id }); const result = await bridge.controller.next('navigated'); expect(result.ok).toBe(false); expect(result.navigationId).toBe(id); expect(JSON.stringify(result)).not.toContain('private-browser-detail'); await bridge.controller.next('frame');
    const unsupported = await bridgeFixture({ navigate: undefined }); expect(unsupported.first.navigationAvailable).toBe(false);
    unsupported.controller.send({ type: 'navigate', direction: 'reload', navigationId: randomUUID() }); expect((await unsupported.controller.next('navigated')).ok).toBe(false);
  });

  it.each(['expiry', 'revocation'])('does not revive a navigation after owner %s', async reason => {
    let clock = Date.now(); const gate = deferred(); const started = deferred();
    const bridge = await bridgeFixture({ navigate: async () => { started.resolve(); await gate.promise; } }, { now: () => clock, expiryIntervalMs: 10 }); cleanup.push(async () => gate.resolve());
    const paired = await (await bridge.request('/api/devices', owner, 'POST', { name: 'Synthetic navigation phone' })).json() as DevicePairResult;
    const closed = new Promise<void>(resolve => bridge.controller.socket.once('close', () => resolve())); bridge.controller.socket.close(); await closed;
    const controller = await phone(bridge.url, paired.token); await controller.next('ready'); controller.send({ type: 'watch', requestId: bridge.item.id }); await controller.next('frame');
    controller.send({ type: 'navigate', direction: 'reload', navigationId: randomUUID() }); await started.promise;
    if (reason === 'expiry') { clock = Date.parse(bridge.item.expiresAt) + 1; await expect.poll(async () => (await (await bridge.request(`/api/requests/${bridge.item.id}`, agent)).json()).status).toBe('expired'); }
    else expect((await bridge.request(`/api/devices/${paired.device.id}/revoke`, owner, 'POST', {})).status).toBe(200);
    gate.resolve();
    if (reason === 'revocation') await expect.poll(() => controller.socket.readyState).toBe(WebSocket.CLOSED);
    expect(controller.messages.some(message => message.type === 'navigated' || message.type === 'frame')).toBe(false);
    expect((await (await bridge.request(`/api/requests/${bridge.item.id}`, agent)).json()).browser).toBeUndefined(); expect(bridge.prepared).toBe(0);
  });
});
