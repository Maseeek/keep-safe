import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { WebSocket } from 'ws';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';
import type { DevicePairResult, PageControlsSnapshot, ServerMessage } from '../packages/shared/src/protocol';
import type { Workspace } from '../apps/web/src/workspace';
import { backgroundFixtureCredentials, startBackgroundLoginFixture } from './fixtures/background-login-site';

const owner = 'synthetic-background-owner'; const agent = 'synthetic-background-agent';
type HarnessWindow = Window & { backgroundWorkspace: Workspace; backgroundSockets: globalThis.WebSocket[] };
const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

// Native headless Chromium frozen/active, foreground-tab and minimized-window
// probes did not change visibilityState. These are controlled lifecycle signals,
// not proof of physical-phone backgrounding or browser suspension behavior.
async function visibility(page: Page, hidden: boolean, pageTransition = false) {
  return page.evaluate(({ hidden, pageTransition }) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: hidden ? 'hidden' : 'visible' });
    if (pageTransition) window.dispatchEvent(new PageTransitionEvent(hidden ? 'pagehide' : 'pageshow', { persisted: true }));
    else document.dispatchEvent(new Event('visibilitychange'));
    const draft = document.querySelector<HTMLInputElement>('#remote-input');
    return { empty: !draft || draft.value === '', masked: !draft || draft.type === 'password' };
  }, { hidden, pageTransition });
}
async function ownerSocket(url: string) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws'); const messages: ServerMessage[] = [];
  socket.on('message', raw => messages.push(JSON.parse(raw.toString()) as ServerMessage));
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'auth', token: owner }));
  const next = async (type: ServerMessage['type']) => { await expect.poll(() => messages.some(message => message.type === type)).toBe(true); return messages.splice(messages.findIndex(message => message.type === type), 1)[0]; };
  await next('ready');
  return { send: (value: object) => socket.send(JSON.stringify(value)), next, close: async () => { if (socket.readyState === WebSocket.CLOSED) return; const closed = new Promise<void>(resolve => socket.once('close', () => resolve())); socket.close(); await closed; } };
}
async function harnessServer() {
  const virtual = 'virtual:background-workspace-harness';
  const result = await build({ configFile: false, envDir: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'background-workspace-test-harness', resolveId: id => id === virtual || id.endsWith('/' + virtual) ? '\0' + virtual : undefined,
      load: id => id === '\0' + virtual ? `import React from'react';import{createRoot}from'react-dom/client';import{useWorkspace}from${JSON.stringify(resolve('apps/web/src/workspace.ts'))};
        const Native=window.WebSocket;window.backgroundSockets=[];window.WebSocket=class extends Native{constructor(...args){super(...args);window.backgroundSockets.push(this);}};
        function Harness(){const workspace=useWorkspace(()=>{});window.backgroundWorkspace=workspace;return React.createElement('p',null,workspace.status);}
        createRoot(document.querySelector('#root')).render(React.createElement(Harness));` : undefined }],
    build: { write: false, emptyOutDir: false, copyPublicDir: false, minify: false, sourcemap: false, lib: { entry: virtual, name: 'BackgroundWorkspaceHarness', formats: ['iife'] } } });
  const output = Array.isArray(result) ? result[0] : result; if (!output || !('output' in output)) throw new Error('Synthetic harness build failed.');
  const script = output.output.find(chunk => chunk.type === 'chunk'); if (!script || script.type !== 'chunk') throw new Error('Synthetic harness build failed.');
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/harness.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(script.code); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><div id="root"></div><script src="/harness.js"></script>'); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}

describe('explicit browser resume after mobile background pause', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each([320, 390])('releases control, discards drafts and requires explicit resume before authenticated handback at %ipx', async width => {
    const site = await startBackgroundLoginFixture(); const bridge = await createBridge({ ownerToken: owner, agentToken: agent, port: 0, allowLocalUrls: true, staticDir: resolve('apps/web/dist') });
    const client = new BridgeClient({ url: bridge.url, token: agent });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true }); const page = await context.newPage();
    let watches = 0; let completes = 0; const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/complete')) completes++; });
    page.on('websocket', socket => socket.on('framesent', frame => { if (JSON.parse(String(frame.payload)).type === 'watch') watches++; }));
    try {
      const request = await client.create({ agent: 'Background login fixture', title: 'Synthetic background pause', url: site.loginUrl, ttlSeconds: 120 });
      await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: owner })}`);
      await page.getByRole('button', { name: /Background login fixture/ }).click(); await page.getByRole('button', { name: 'Approve & open', exact: true }).click();
      await page.locator('.remote-screen img').waitFor(); await expect.poll(() => site.formReadyCount).toBe(1);
      await page.getByRole('button', { name: 'Type text', exact: true }).click();
      const text = page.getByLabel('Tap a field in the browser, then send text'); await text.fill('synthetic-unsent-draft'); await page.getByLabel('Show text', { exact: true }).check();
      const beforePause = watches; expect(await visibility(page, true, width === 390)).toEqual({ empty: true, masked: true });
      await page.getByRole('heading', { name: 'Browser paused', exact: true }).waitFor(); expect(await page.locator('.remote-screen img').count()).toBe(0);
      expect(await text.count()).toBe(0); expect(await page.locator('body').innerText()).not.toContain('synthetic-unsent-draft');
      const other = await ownerSocket(bridge.url);
      try { other.send({ type: 'watch', requestId: request.id }); await other.next('frame'); } finally { await other.close(); }
      expect((await client.get(request.id)).browser).toBeUndefined(); expect((await client.get(request.id)).status).toBe('active'); expect(completes).toBe(0);
      await visibility(page, false, width === 390); await page.getByText('Bridge connected', { exact: true }).waitFor();
      expect(await page.locator('.remote-screen img').count()).toBe(0); expect(watches).toBe(beforePause);
      if (process.env.KEEP_SAFE_QA_SCREENSHOTS) { await mkdir('.keep-safe/qa', { recursive: true }); await page.screenshot({ path: `.keep-safe/qa/background-pause-${width}.png`, fullPage: true }); }
      await page.getByRole('button', { name: 'Resume browser', exact: true }).click(); await page.locator('.remote-screen img').waitFor();
      await page.getByRole('button', { name: 'Type text', exact: true }).click();
      expect(watches).toBe(beforePause + 1); expect(await text.inputValue()).toBe(''); expect(await text.getAttribute('type')).toBe('password'); expect(await page.getByLabel('Show text', { exact: true }).isChecked()).toBe(false);
      await page.getByRole('button', { name: 'Page controls', exact: true }).click();
      const focus = async (name: string) => { await page.getByRole('button', { name: `Focus ${name}`, exact: true }).click(); await page.getByText(`Focus confirmed on ${name}.`, { exact: true }).waitFor(); };
      await focus('Background email'); await text.fill(backgroundFixtureCredentials.email); await page.getByRole('button', { name: 'Send', exact: true }).click();
      await focus('Synthetic background password'); await text.fill(backgroundFixtureCredentials.password); await page.getByRole('button', { name: 'Send', exact: true }).click();
      await focus('Sign in background fixture'); await page.getByRole('button', { name: 'Press Enter in browser', exact: true }).click();
      await expect.poll(() => site.loginCount).toBe(1); await expect.poll(() => site.readyCount).toBe(1);
      expect((await client.get(request.id)).browser).toBeUndefined(); expect(completes).toBe(0);
      if (width === 390) {
        // Explicit handback is still available while viewing stays paused.
        await visibility(page, true); await page.getByRole('heading', { name: 'Browser paused', exact: true }).waitFor();
        await visibility(page, false); await page.getByText('Bridge connected', { exact: true }).waitFor();
        expect(await page.locator('.remote-screen img').count()).toBe(0); expect(completes).toBe(0); expect((await client.get(request.id)).browser).toBeUndefined();
      }
      await page.getByRole('button', { name: /Done, hand back/ }).click(); await expect.poll(async () => (await client.get(request.id)).status).toBe('completed');
      const result = await client.get(request.id); const resumed = await chromium.connectOverCDP(result.browser!.cdpUrl);
      try { const remote = resumed.contexts().flatMap(context => context.pages()).find(page => page.url() === site.loginUrl)!; expect(await remote.locator('#password').evaluate(input => (input as HTMLInputElement).value === '')).toBe(true); expect((await remote.goto(site.origin + '/account'))?.status()).toBe(200); await remote.reload(); await remote.getByRole('heading', { name: 'Background session authenticated', exact: true }).waitFor(); }
      finally { await resumed.close(); }
      expect(completes).toBe(1); expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    } finally { await context.close(); await bridge.close(); await site.close(); }
  }, 45000);

  async function controlledHarness(paired = false) {
    const server = await harnessServer(); const remote = await browser.newPage({ viewport: { width: 390, height: 720 } });
    await remote.setContent('<label><input id="target" type="checkbox">Synthetic recovery checkbox</label>'); await remote.locator('#target').focus();
    const image = (await remote.screenshot({ type: 'jpeg' })).toString('base64'); const focusGate = deferred(); const frameGate = deferred();
    const snapshot: PageControlsSnapshot = { snapshotId: randomUUID(), origin: 'https://example.com', truncated: false, controls: [{ id: randomUUID(), name: 'Synthetic recovery checkbox', role: 'checkbox', protected: false, disabled: false, checked: false }] };
    let clock = Date.now(); let focusMode: 'hold' | 'fail' | 'success' = 'hold'; let focusStarted = 0; let holdFrames = false; let frameStarted = 0; let inspections = 0; let inputCount = 0; let handoffs = 0; let url = 'https://example.com/login';
    const bridge = await createBridge({ ownerToken: owner, agentToken: agent, port: 0, appUrl: server.origin, now: () => clock, expiryIntervalMs: 10, browserFactory: async () => ({
      cdpUrl: 'http://127.0.0.1:9333', frame: async () => { frameStarted++; if (holdFrames) await frameGate.promise; return { data: image, width: 390, height: 720, url }; },
      inspectControls: async () => { inspections++; return snapshot; },
      input: async message => { if (message.type === 'focus') { focusStarted++; if (focusMode === 'hold') await focusGate.promise; if (focusMode === 'fail') throw new Error('Synthetic focus failure.'); return; } inputCount++; if (message.type === 'key') await remote.keyboard.press(String(message.key)); if (message.type === 'click') await remote.mouse.click(Number(message.x), Number(message.y)); },
      prepareHandoff: async () => { handoffs++; }, close: async () => {},
    }) });
    let device: DevicePairResult | undefined;
    if (paired) { const response = await fetch(bridge.url + '/api/devices', { method: 'POST', headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic background phone' }) }); expect(response.status).toBe(201); device = await response.json() as DevicePairResult; }
    const client = new BridgeClient({ url: bridge.url, token: agent }); const request = await client.create({ agent: 'Background hook fixture', title: 'Synthetic pause barriers', url, ttlSeconds: 120 });
    expect((await fetch(`${bridge.url}/api/requests/${request.id}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' }, body: '{}' })).ok).toBe(true);
    const context = await browser.newContext(); const page = await context.newPage(); let watches = 0;
    page.on('websocket', socket => socket.on('framesent', frame => { if (JSON.parse(String(frame.payload)).type === 'watch') watches++; }));
    await page.goto(`${server.origin}/#${new URLSearchParams({ bridge: bridge.url, token: device?.token ?? owner })}`);
    await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).backgroundWorkspace?.status)).toBe('connected');
    await page.evaluate(id => (window as unknown as HarnessWindow).backgroundWorkspace.watch(id), request.id);
    await expect.poll(() => page.evaluate(() => !!(window as unknown as HarnessWindow).backgroundWorkspace.frame)).toBe(true);
    return { page, context, bridge, client, request, snapshot, device, remote, focusGate, frameGate,
      get watches() { return watches; }, get focusStarted() { return focusStarted; }, get inspections() { return inspections; }, get frameStarted() { return frameStarted; }, get inputCount() { return inputCount; }, get handoffs() { return handoffs; },
      holdFrames: () => { holdFrames = true; }, setMode: (mode: typeof focusMode) => { focusMode = mode; }, setUrl: (value: string) => { url = value; }, expire: () => { clock = Date.parse(request.expiresAt) + 1; },
      close: async () => { focusGate.release(); frameGate.release(); await context.close(); await bridge.close(); await remote.close(); await server.close(); } };
  }

  it('blocks same-tick hidden input, stale transport replies and reconnection until explicit fresh-frame resume', async () => {
    const test = await controlledHarness(); const { page } = test;
    const state = () => page.evaluate(() => { const workspace = (window as unknown as HarnessWindow).backgroundWorkspace; return { paused: workspace.browserPaused, visible: workspace.browserVisible, status: workspace.status, frame: !!workspace.frame, blocked: workspace.focusBlocked, focused: !!workspace.focusedControl }; });
    const rejected = () => page.evaluate(() => { const workspace = (window as unknown as HarnessWindow).backgroundWorkspace; return [workspace.send({ type: 'key', key: 'Space' }), workspace.send({ type: 'text', text: 'synthetic-not-sent' })]; });
    try {
      await page.evaluate(() => (window as unknown as HarnessWindow).backgroundWorkspace.inspectControls());
      await expect.poll(() => test.inspections).toBe(1); await expect.poll(() => page.evaluate(() => !!(window as unknown as HarnessWindow).backgroundWorkspace.pageControls)).toBe(true);
      await page.evaluate(snapshot => (window as unknown as HarnessWindow).backgroundWorkspace.focusControl(snapshot.snapshotId, snapshot.controls[0].id), test.snapshot);
      await expect.poll(() => test.focusStarted).toBe(1);
      const rapid = await page.evaluate(id => {
        const workspace = (window as unknown as HarnessWindow).backgroundWorkspace;
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
        return [workspace.send({ type: 'click', x: 10, y: 10 }), workspace.send({ type: 'scroll', deltaX: 0, deltaY: 100 }), workspace.send({ type: 'key', key: 'Tab' }), workspace.send({ type: 'text', text: 'synthetic-not-sent' }), workspace.resumeBrowser(id)];
      }, test.request.id);
      expect(rapid).toEqual(Array(5).fill(false));
      await expect.poll(state).toMatchObject({ paused: true, visible: false, frame: false, blocked: true, focused: false });
      test.focusGate.release();
      await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).backgroundWorkspace.status)).toBe('connected');
      // Inject replies already queued on the retired browser WebSocket. They
      // carry no field values and cannot become a resumed frame or focus proof.
      await page.evaluate(({ id, snapshot }) => {
        const old = (window as unknown as HarnessWindow).backgroundSockets[0];
        old.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'frame', requestId: id, data: 'aW1hZ2U=', width: 390, height: 720, url: 'https://stale.example.com' }) }));
        old.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'focused', requestId: id, snapshotId: snapshot.snapshotId, controlId: snapshot.controls[0].id }) }));
      }, { id: test.request.id, snapshot: test.snapshot });
      expect(await state()).toMatchObject({ paused: true, frame: false, blocked: true, focused: false }); expect(await rejected()).toEqual([false, false]);
      const other = await ownerSocket(test.bridge.url); try { other.send({ type: 'watch', requestId: test.request.id }); await other.next('frame'); } finally { await other.close(); }
      const sockets = await page.evaluate(() => (window as unknown as HarnessWindow).backgroundSockets.length);
      await page.evaluate(() => (window as unknown as HarnessWindow).backgroundSockets.at(-1)!.close(1000, 'Synthetic hidden reconnect'));
      await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).backgroundSockets.length), { timeout: 6000 }).toBeGreaterThan(sockets);
      await expect.poll(state).toMatchObject({ status: 'connected', paused: true, frame: false });
      await visibility(page, false); expect(test.watches).toBe(1); expect(await rejected()).toEqual([false, false]);
      test.setUrl('https://new.example.com/login'); test.holdFrames(); const beforeFrame = test.frameStarted;
      expect(await page.evaluate(id => (window as unknown as HarnessWindow).backgroundWorkspace.resumeBrowser(id), test.request.id)).toBe(true);
      await expect.poll(() => test.frameStarted).toBeGreaterThan(beforeFrame);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).backgroundWorkspace.send({ type: 'click', x: 10, y: 10 }))).toBe(false);
      test.frameGate.release();
      await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).backgroundWorkspace.frame?.url)).toBe('https://new.example.com/login');
      expect(await state()).toMatchObject({ paused: false, visible: true, blocked: true, focused: false }); expect(await rejected()).toEqual([false, false]);
      // A fresh failed focus must survive another background round trip too.
      test.setMode('fail'); await page.evaluate(() => (window as unknown as HarnessWindow).backgroundWorkspace.inspectControls());
      await expect.poll(() => page.evaluate(() => !!(window as unknown as HarnessWindow).backgroundWorkspace.pageControls)).toBe(true);
      await page.evaluate(snapshot => (window as unknown as HarnessWindow).backgroundWorkspace.focusControl(snapshot.snapshotId, snapshot.controls[0].id), test.snapshot);
      await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).backgroundWorkspace.controlsError)).toContain('The requested action was not accepted');
      await visibility(page, true, true); await visibility(page, false, true);
      await expect.poll(state).toMatchObject({ status: 'connected', paused: true, frame: false, blocked: true });
      expect(await page.evaluate(id => (window as unknown as HarnessWindow).backgroundWorkspace.resumeBrowser(id), test.request.id)).toBe(true);
      await expect.poll(state).toMatchObject({ paused: false, frame: true, blocked: true }); expect(await rejected()).toEqual([false, false]);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).backgroundWorkspace.send({ type: 'key', key: 'Tab' }))).toBe(true);
      await expect.poll(() => test.inputCount).toBe(1); expect(await state()).toMatchObject({ blocked: false });
      expect((await test.client.get(test.request.id)).browser).toBeUndefined(); expect(test.handoffs).toBe(0);
    } finally { await test.close(); }
  }, 30000);

  it.each(['expired request', 'revoked pairing'])('cannot resume a stale browser after %s', async reason => {
    const test = await controlledHarness(reason === 'revoked pairing'); const { page } = test;
    try {
      await visibility(page, true); await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).backgroundWorkspace.browserPaused)).toBe(true);
      if (reason === 'expired request') {
        test.expire(); await expect.poll(async () => (await test.client.get(test.request.id)).status).toBe('expired');
        // The controlled server clock advanced independently of the phone.
        // Wait for its actual expiry metadata before asserting the local choice.
        await expect.poll(() => page.evaluate(id => (window as unknown as HarnessWindow).backgroundWorkspace.requests.find(request => request.id === id)?.status, test.request.id)).toBe('expired');
      }
      else { const response = await fetch(`${test.bridge.url}/api/devices/${test.device!.device.id}/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' }, body: '{}' }); expect(response.ok).toBe(true); await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).backgroundWorkspace.connection)).toBeNull(); }
      await visibility(page, false);
      expect(await page.evaluate(id => (window as unknown as HarnessWindow).backgroundWorkspace.resumeBrowser(id), test.request.id)).toBe(false);
      expect(await page.evaluate(() => !!(window as unknown as HarnessWindow).backgroundWorkspace.frame)).toBe(false); expect(test.watches).toBe(1); expect(test.inputCount).toBe(0); expect(test.handoffs).toBe(0); expect((await test.client.get(test.request.id)).browser).toBeUndefined();
    } finally { await test.close(); }
  });

  it('does not resume an old request after the logical watch or connected bridge changes while paused', async () => {
    const test = await controlledHarness(); const { page } = test;
    let otherBridge: Awaited<ReturnType<typeof createBridge>> | undefined;
    try {
      const second = await test.client.create({ agent: 'Second background fixture', title: 'Synthetic different request', url: 'https://example.com/second', ttlSeconds: 120 });
      expect((await fetch(`${test.bridge.url}/api/requests/${second.id}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' }, body: '{}' })).ok).toBe(true);
      await visibility(page, true); await page.evaluate(id => (window as unknown as HarnessWindow).backgroundWorkspace.watch(id), second.id); await visibility(page, false);
      expect(await page.evaluate(id => (window as unknown as HarnessWindow).backgroundWorkspace.resumeBrowser(id), test.request.id)).toBe(false);
      expect(await page.evaluate(() => !!(window as unknown as HarnessWindow).backgroundWorkspace.frame)).toBe(false); expect(test.watches).toBe(1);
      await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).backgroundWorkspace.status)).toBe('connected');
      expect(await page.evaluate(id => (window as unknown as HarnessWindow).backgroundWorkspace.resumeBrowser(id), second.id)).toBe(true);
      await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).backgroundWorkspace.frame?.requestId)).toBe(second.id);
      expect((await test.client.get(test.request.id)).browser).toBeUndefined(); expect((await test.client.get(second.id)).browser).toBeUndefined(); expect(test.handoffs).toBe(0);
      await visibility(page, true);
      const image = (await test.remote.screenshot({ type: 'jpeg' })).toString('base64');
      otherBridge = await createBridge({ ownerToken: 'synthetic-other-owner', agentToken: 'synthetic-other-agent', port: 0, appUrl: new URL(page.url()).origin,
        browserFactory: async () => ({ frame: async () => ({ data: image, width: 390, height: 720, url: 'https://other.example.com/login' }), input: async () => {}, close: async () => {} }) });
      const otherClient = new BridgeClient({ url: otherBridge.url, token: 'synthetic-other-agent' });
      const next = await otherClient.create({ agent: 'Other computer fixture', title: 'Synthetic different bridge', url: 'https://other.example.com/login', ttlSeconds: 120 });
      expect((await fetch(`${otherBridge.url}/api/requests/${next.id}/approve`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-other-owner', 'Content-Type': 'application/json' }, body: '{}' })).ok).toBe(true);
      await page.evaluate(value => (window as unknown as HarnessWindow).backgroundWorkspace.connect(value), { url: otherBridge.url, token: 'synthetic-other-owner' });
      await expect.poll(() => page.evaluate(id => { const workspace = (window as unknown as HarnessWindow).backgroundWorkspace; return { url: workspace.connection?.url, status: workspace.status, known: workspace.requests.some(request => request.id === id) }; }, next.id)).toEqual({ url: otherBridge.url, status: 'connected', known: true });
      await page.evaluate(id => (window as unknown as HarnessWindow).backgroundWorkspace.watch(id), next.id); await visibility(page, false);
      expect(await page.evaluate(id => (window as unknown as HarnessWindow).backgroundWorkspace.resumeBrowser(id), second.id)).toBe(false);
      expect(await page.evaluate(() => !!(window as unknown as HarnessWindow).backgroundWorkspace.frame)).toBe(false);
      expect(await page.evaluate(id => (window as unknown as HarnessWindow).backgroundWorkspace.resumeBrowser(id), next.id)).toBe(true);
      await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).backgroundWorkspace.frame?.url)).toBe('https://other.example.com/login');
      expect((await otherClient.get(next.id)).browser).toBeUndefined(); expect((await test.client.get(second.id)).browser).toBeUndefined();
    } finally {
      // Stop the real hook's reconnect producer before tearing down either
      // endpoint. Otherwise an in-flight reconnect can race bridge shutdown.
      await test.context.close();
      await otherBridge?.close();
      await test.close();
    }
  });
});
