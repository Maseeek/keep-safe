import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Workspace } from '../apps/web/src/workspace';
import type { LoginRequest, ServerMessage } from '../packages/shared/src/protocol';

type HarnessWindow = Window & {
  navigationWorkspace: Workspace;
  navigationSockets: Array<globalThis.WebSocket & { emit(message: object): void }>;
  navigationMessages: Array<{ type: string; navigationId?: string; direction?: string }>;
  navigationAutoFrame: boolean;
};
const request: LoginRequest = { id: randomUUID(), agent: 'Synthetic navigation fixture', title: 'Synthetic navigation boundaries',
  url: 'https://example.com/login', origin: 'https://example.com', reason: 'Synthetic only', status: 'active',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() };
const initialEpoch = randomUUID();
const image = { data: 'aW1hZ2U=', width: 390, height: 720, url: request.url, navigationAvailable: true, frameEpoch: initialEpoch };
const info = { name: 'Synthetic navigation bridge', version: 'test', browserAvailable: true, pushEnabled: false, navigationAvailable: true };

async function harnessServer() {
  const virtual = 'virtual:navigation-workspace-harness';
  const result = await build({ configFile: false, envDir: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'navigation-workspace-test', resolveId: id => id === virtual || id.endsWith('/' + virtual) ? '\0' + virtual : undefined,
      load: id => id === '\0' + virtual ? `import React from'react';import{createRoot}from'react-dom/client';import{useWorkspace}from${JSON.stringify(resolve('apps/web/src/workspace.ts'))};
        function Harness(){const workspace=useWorkspace(()=>{});window.navigationWorkspace=workspace;return React.createElement('p',null,workspace.status);}
        createRoot(document.querySelector('#root')).render(React.createElement(Harness));` : undefined }],
    build: { write: false, emptyOutDir: false, copyPublicDir: false, minify: false, sourcemap: false, lib: { entry: virtual, name: 'NavigationWorkspaceHarness', formats: ['iife'] } } });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Synthetic navigation harness did not build.');
  const script = output.output.find(chunk => chunk.type === 'chunk');
  if (!script || script.type !== 'chunk') throw new Error('Synthetic navigation harness did not build.');
  let completions = 0;
  const server = createServer((incoming, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (incoming.url === '/harness.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(script.code); return; }
    if (incoming.url === '/api/info') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(info)); return; }
    if (incoming.url === '/api/requests') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ requests: [request] })); return; }
    if (incoming.method === 'POST') { incoming.resume(); incoming.on('end', () => { if (incoming.url?.endsWith('/complete')) completions++; response.setHeader('Content-Type', 'application/json'); response.end('{}'); }); return; }
    const path = new URL(incoming.url || '/', 'http://fixture.invalid').pathname;
    if (path === '/ui' || path === '/sw.js' || /^\/assets\/[A-Za-z0-9._-]+$/.test(path)) {
      const file = path === '/ui' ? 'index.html' : path.slice(1);
      response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      void readFile(resolve('apps/web/dist', file)).then(data => response.end(data)).catch(() => { response.statusCode = 404; response.end(); }); return;
    }
    response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><div id="root"></div><script src="/harness.js"></script>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, get completions() { return completions; },
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}

describe('website navigation owner workspace boundaries', () => {
  let browser: Browser;
  let server: Awaited<ReturnType<typeof harnessServer>>;
  beforeAll(async () => { browser = await chromium.launch(); const fixture = await browser.newPage(); await fixture.setContent('<h1>Synthetic navigation page</h1>'); image.data = (await fixture.screenshot({ type: 'jpeg' })).toString('base64'); await fixture.close(); server = await harnessServer(); });
  afterAll(async () => { await browser?.close(); await server?.close(); });
  async function setup(unsupported?: 'old bridge' | 'attached browser') {
    const context = await browser.newContext(); const page = await context.newPage();
    const metadata = unsupported === 'old bridge' ? { ...info, navigationAvailable: undefined } : info;
    const screenshot = unsupported ? { ...image, navigationAvailable: false } : image;
    if (unsupported) await page.route('**/api/info', route => route.fulfill({ json: metadata }));
    await page.addInitScript(({ request, image, info }) => {
      const target = window as unknown as HarnessWindow;
      target.navigationSockets = []; target.navigationMessages = []; target.navigationAutoFrame = true;
      class Socket {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        readyState = 0;
        onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: (event: { code: number }) => void;
        constructor() { target.navigationSockets.push(this as unknown as HarnessWindow['navigationSockets'][number]); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
        emit(message: object) { this.onmessage?.({ data: JSON.stringify(message) }); }
        send(raw: string) {
          const message = JSON.parse(raw) as { type: string; direction?: string; navigationId?: string };
          // Keep only action kinds and correlation IDs, never authentication or text.
          target.navigationMessages.push({ type: message.type, direction: message.direction, navigationId: message.navigationId });
          if (message.type === 'auth') queueMicrotask(() => this.emit({ type: 'ready', info, requests: [request] }));
          if (message.type === 'watch' && target.navigationAutoFrame) queueMicrotask(() => this.emit({ type: 'frame', requestId: request.id, ...image }));
        }
        close() { this.readyState = 3; queueMicrotask(() => this.onclose?.({ code: 1000 })); }
      }
      window.WebSocket = Socket as unknown as typeof WebSocket;
    }, { request, image: screenshot, info: metadata });
    await page.goto(`${server.origin}/${unsupported ? 'ui' : ''}#${new URLSearchParams({ bridge: server.origin, token: 'synthetic-navigation-owner' })}`);
    if (unsupported) {
      await page.locator('.remote-screen img').waitFor();
      return { context, page };
    }
    await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).navigationWorkspace?.status)).toBe('connected');
    await page.evaluate(id => (window as unknown as HarnessWindow).navigationWorkspace.watch(id), request.id);
    await expect.poll(() => page.evaluate(() => !!(window as unknown as HarnessWindow).navigationWorkspace.frame)).toBe(true);
    return { context, page };
  }
  const state = (page: Page) => page.evaluate(() => { const workspace = (window as unknown as HarnessWindow).navigationWorkspace; return { busy: workspace.navigationBusy, paused: workspace.browserPaused, frame: !!workspace.frame, blocked: workspace.focusBlocked, error: workspace.navigationError, uncertain: workspace.navigationUncertain }; });
  const emit = (page: Page, message: ServerMessage) => page.evaluate(message => (window as unknown as HarnessWindow).navigationSockets.at(-1)!.emit(message), message);
  const navigationId = (page: Page) => page.evaluate(() => (window as unknown as HarnessWindow).navigationMessages.filter(message => message.type === 'navigate').at(-1)!.navigationId!);
  const finish = async (page: Page, id: string, epoch = randomUUID(), ok = true) => {
    await emit(page, { type: 'navigated', requestId: request.id, navigationId: id, frameEpoch: epoch, ok, ...(ok ? {} : { message: 'The website could not be navigated. Check the page before trying again.' }) });
    await emit(page, { type: 'frame', requestId: request.id, ...image, frameEpoch: epoch });
    await expect.poll(() => state(page)).toMatchObject({ busy: false, frame: true, blocked: true });
    return epoch;
  };

  it('blocks same-event input and Done until a correlated result and a fresh epoch, including same-URL reload', async () => {
    const { context, page } = await setup();
    try {
      const completions = server.completions;
      const gate = await page.evaluate(async id => {
        const workspace = (window as unknown as HarnessWindow).navigationWorkspace;
        const started = workspace.navigateBrowser('reload');
        const input = [workspace.send({ type: 'click', x: 1, y: 1 }), workspace.send({ type: 'key', key: 'Tab' }), workspace.send({ type: 'text', text: 'synthetic-not-sent' }), workspace.navigateBrowser('back')];
        workspace.inspectControls(); workspace.focusControl('synthetic-snapshot', 'synthetic-control');
        let done = false; try { await workspace.action(id, 'complete'); done = true; } catch { /* Expected synchronous gate before HTTP. */ }
        return { started, input, done };
      }, request.id);
      expect(gate).toEqual({ started: true, input: [false, false, false, false], done: false }); expect(server.completions).toBe(completions);
      await expect.poll(() => state(page)).toMatchObject({ busy: true, frame: false, blocked: true });
      const id = await navigationId(page); const epoch = randomUUID();
      await emit(page, { type: 'frame', requestId: request.id, ...image, frameEpoch: epoch });
      await emit(page, { type: 'navigated', requestId: request.id, navigationId: randomUUID(), frameEpoch: epoch, ok: true });
      await emit(page, { type: 'navigated', requestId: request.id, navigationId: id, frameEpoch: initialEpoch, ok: true });
      expect(await state(page)).toMatchObject({ busy: true, frame: false });
      await emit(page, { type: 'navigated', requestId: request.id, navigationId: id, frameEpoch: epoch, ok: true });
      await emit(page, { type: 'frame', requestId: request.id, ...image });
      expect(await state(page)).toMatchObject({ busy: true, frame: false });
      await emit(page, { type: 'frame', requestId: request.id, ...image, frameEpoch: epoch });
      await expect.poll(() => state(page)).toMatchObject({ busy: false, frame: true, blocked: true });
      await emit(page, { type: 'frame', requestId: request.id, ...image, url: 'https://stale.example.invalid', frameEpoch: initialEpoch });
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).navigationWorkspace.frame?.url)).toBe(request.url);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).navigationWorkspace.send({ type: 'key', key: 'Enter' }))).toBe(false);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).navigationWorkspace.send({ type: 'key', key: 'Tab' }))).toBe(true);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).navigationMessages.map(message => message.type))).not.toContain('focus');
    } finally { await context.close(); }
  });

  it('recovers a settled failure without optimistic success or an automatic retry', async () => {
    const { context, page } = await setup();
    try {
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).navigationWorkspace.navigateBrowser('back'))).toBe(true);
      const first = await navigationId(page); await finish(page, first, randomUUID(), false);
      expect((await state(page)).error).toContain('could not be navigated');
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).navigationMessages.filter(message => message.type === 'navigate').length)).toBe(1);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).navigationWorkspace.navigateBrowser('forward'))).toBe(true);
      const second = await navigationId(page);
      await emit(page, { type: 'navigated', requestId: request.id, navigationId: first, frameEpoch: randomUUID(), ok: true });
      expect(await state(page)).toMatchObject({ busy: true, frame: false }); await finish(page, second);
      expect((await state(page)).error).toBe('');
    } finally { await context.close(); }
  });

  it('abandons pending intent on pause and ignores retired replies after an explicit fresh-frame resume', async () => {
    const { context, page } = await setup();
    try {
      await page.evaluate(() => (window as unknown as HarnessWindow).navigationWorkspace.navigateBrowser('reload'));
      const id = await navigationId(page);
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
      await expect.poll(() => state(page)).toMatchObject({ paused: true, busy: false, frame: false });
      await page.evaluate(({ request, image, id, epoch }) => {
        const target = window as unknown as HarnessWindow;
        target.navigationSockets[0].emit({ type: 'navigated', requestId: request.id, navigationId: id, frameEpoch: epoch, ok: true });
        target.navigationSockets[0].emit({ type: 'frame', requestId: request.id, ...image, frameEpoch: epoch });
        target.navigationAutoFrame = false;
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange'));
      }, { request, image, id, epoch: randomUUID() });
      expect(await state(page)).toMatchObject({ paused: true, frame: false });
      expect(await page.evaluate(id => (window as unknown as HarnessWindow).navigationWorkspace.resumeBrowser(id), request.id)).toBe(true);
      await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).navigationWorkspace.status)).toBe('connected');
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).navigationWorkspace.send({ type: 'click', x: 1, y: 1 }))).toBe(false);
      await emit(page, { type: 'frame', requestId: request.id, ...image, frameEpoch: randomUUID() });
      await expect.poll(() => state(page)).toMatchObject({ paused: false, frame: true, blocked: true });
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).navigationMessages.filter(message => message.type === 'navigate').length)).toBe(1);
    } finally { await context.close(); }
  });

  it('times out to a paused view without resending navigation or releasing input', async () => {
    const { context, page } = await setup();
    try {
      await page.clock.install();
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).navigationWorkspace.navigateBrowser('reload'))).toBe(true);
      await page.clock.fastForward(15001);
      await expect.poll(() => state(page)).toMatchObject({ paused: true, busy: false, frame: false, blocked: true });
      expect(await page.evaluate(async id => { try { await (window as unknown as HarnessWindow).navigationWorkspace.action(id, 'complete'); return true; } catch { return false; } }, request.id)).toBe(false);
      expect((await state(page)).error).toContain('not confirmed');
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).navigationMessages.filter(message => message.type === 'navigate').length)).toBe(1);
    } finally { await context.close(); }
  });

  it('retains an uncertain handback gate across leaving and reopening the same request', async () => {
    const { context, page } = await setup();
    try {
      await page.evaluate(() => (window as unknown as HarnessWindow).navigationWorkspace.navigateBrowser('reload'));
      const completions = server.completions;
      await page.evaluate(id => {
        const target = window as unknown as HarnessWindow;
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
        target.navigationWorkspace.watch(null); target.navigationWorkspace.watch(id);
        target.navigationAutoFrame = false;
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange'));
      }, request.id);
      await expect.poll(() => state(page)).toMatchObject({ paused: true, uncertain: true, frame: false });
      const complete = () => page.evaluate(async id => { try { await (window as unknown as HarnessWindow).navigationWorkspace.action(id, 'complete'); return true; } catch { return false; } }, request.id);
      expect(await complete()).toBe(false);
      expect(await page.evaluate(id => (window as unknown as HarnessWindow).navigationWorkspace.resumeBrowser(id), request.id)).toBe(true);
      await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).navigationWorkspace.status)).toBe('connected');
      expect(await complete()).toBe(false); expect(server.completions).toBe(completions);
      await emit(page, { type: 'frame', requestId: request.id, ...image, frameEpoch: randomUUID() });
      await expect.poll(() => state(page)).toMatchObject({ paused: false, uncertain: false, frame: true, blocked: true });
      expect(await complete()).toBe(true); expect(server.completions).toBe(completions + 1);
    } finally { await context.close(); }
  });

  it.each(['before result', 'after result before image'])('requires explicit Resume after a disconnect %s', async phase => {
    const { context, page } = await setup();
    try {
      await page.clock.install();
      await page.evaluate(() => (window as unknown as HarnessWindow).navigationWorkspace.navigateBrowser('reload'));
      if (phase === 'after result before image') await emit(page, { type: 'navigated', requestId: request.id, navigationId: await navigationId(page), frameEpoch: randomUUID(), ok: true });
      const before = await page.evaluate(() => (window as unknown as HarnessWindow).navigationMessages.filter(message => message.type === 'watch').length);
      await page.evaluate(() => (window as unknown as HarnessWindow).navigationSockets.at(-1)!.close());
      await expect.poll(() => state(page)).toMatchObject({ paused: true, busy: false, frame: false });
      await page.clock.fastForward(1001);
      await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).navigationWorkspace.status)).toBe('connected');
      await emit(page, { type: 'frame', requestId: request.id, ...image, frameEpoch: randomUUID() });
      expect(await state(page)).toMatchObject({ paused: true, frame: false, blocked: true });
      const completions = server.completions;
      expect(await page.evaluate(async id => { try { await (window as unknown as HarnessWindow).navigationWorkspace.action(id, 'complete'); return true; } catch { return false; } }, request.id)).toBe(false);
      expect(server.completions).toBe(completions);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).navigationMessages.filter(message => message.type === 'watch').length)).toBe(before);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).navigationWorkspace.send({ type: 'click', x: 1, y: 1 }))).toBe(false);
      expect(await page.evaluate(id => (window as unknown as HarnessWindow).navigationWorkspace.resumeBrowser(id), request.id)).toBe(true);
      await expect.poll(() => state(page)).toMatchObject({ paused: false, frame: true, blocked: true, uncertain: false });
      await page.evaluate(id => (window as unknown as HarnessWindow).navigationWorkspace.action(id, 'complete'), request.id);
      expect(server.completions).toBe(completions + 1);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).navigationMessages.filter(message => message.type === 'navigate').length)).toBe(1);
    } finally { await context.close(); }
  });

  it.each(['old bridge', 'attached browser'])('rejects unsupported %s navigation without sending an intent', async kind => {
    const { context, page } = await setup();
    try {
      if (kind === 'old bridge') await emit(page, { type: 'ready', info: { ...info, navigationAvailable: undefined }, requests: [request] });
      else await emit(page, { type: 'frame', requestId: request.id, ...image, navigationAvailable: false });
      await expect.poll(() => page.evaluate(kind => { const workspace = (window as unknown as HarnessWindow).navigationWorkspace; return kind === 'old bridge' ? workspace.info?.navigationAvailable !== true : !workspace.navigationAvailable; }, kind)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).navigationWorkspace.navigateBrowser('reload'))).toBe(false);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).navigationMessages.filter(message => message.type === 'navigate').length)).toBe(0);
    } finally { await context.close(); }
  });

  it.each(['old bridge', 'attached browser'] as const)('hides website navigation actions and gives useful guidance for an %s', async kind => {
    const { context, page } = await setup(kind);
    try {
      expect(await page.getByRole('group', { name: 'Website navigation', exact: true }).count()).toBe(0);
      for (const name of ['Back in the website', 'Forward in the website', 'Reload website']) expect(await page.getByRole('button', { name, exact: true }).count()).toBe(0);
      const guidance = page.locator('.website-navigation-hint');
      await guidance.waitFor();
      expect(await guidance.innerText()).toBe(kind === 'old bridge' ? 'Update the bridge on your computer for website Back, Forward and Reload.' : 'Use the website’s own links and buttons in this browser.');
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).navigationMessages.filter(message => message.type === 'navigate').length)).toBe(0);
    } finally { await context.close(); }
  });
});
