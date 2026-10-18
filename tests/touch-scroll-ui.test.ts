import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser, type CDPSession, type Locator, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';
import { startTouchLoginFixture, touchFixtureCredentials } from './fixtures/touch-login-site';

const ownerToken = 'synthetic-touch-owner'; const agentToken = 'synthetic-touch-agent';
type Point = { x: number; y: number };
const contact = (point: Point, id = 0) => ({ ...point, id, radiusX: 1, radiusY: 1, force: 1 });
async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: Array<Point & { id?: number }> = []) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(point => contact(point, point.id ?? 0)) });
}
async function tap(cdp: CDPSession, point: Point) {
  await touch(cdp, 'touchStart', [point]); await touch(cdp, 'touchMove', [{ x: point.x + 1, y: point.y + 1 }]); await touch(cdp, 'touchEnd');
}
async function swipe(cdp: CDPSession, from: Point, to: Point, steps = 6) {
  await touch(cdp, 'touchStart', [from]);
  for (let index = 1; index <= steps; index++) await touch(cdp, 'touchMove', [{ x: from.x + (to.x - from.x) * index / steps, y: from.y + (to.y - from.y) * index / steps }]);
  await touch(cdp, 'touchEnd');
}
async function imageBox(page: Page) {
  const image = page.locator('.remote-screen img'); await image.scrollIntoViewIfNeeded(); const box = (await image.boundingBox())!;
  expect(box.width).toBeGreaterThan(0); expect(box.height).toBeGreaterThan(0); return box;
}
const mapped = (box: { x: number; y: number; width: number; height: number }, point: Point, width = 390, height = 720) => ({ x: box.x + point.x * box.width / width, y: box.y + point.y * box.height / height });
async function mouseActivate(cdp: CDPSession, locator: Locator) {
  await locator.evaluate(element => element.scrollIntoView({ block: 'center' })); const box = (await locator.boundingBox())!;
  expect(await locator.evaluate(element => { const box = element.getBoundingClientRect(); const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return target === element || element.contains(target); })).toBe(true);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

describe('trusted touch scrolling through the phone interface', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each([320, 390])('touches, scrolls native containers and signs in before authenticated handback at %ipx', async width => {
    const site = await startTouchLoginFixture();
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, allowLocalUrls: true, staticDir: resolve('apps/web/dist') });
    const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true });
    const page = await context.newPage(); const cdp = await context.newCDPSession(page); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      const request = await client.create({ agent: 'Touch login fixture', title: 'Synthetic touch sign-in', url: site.loginUrl, ttlSeconds: 120 });
      await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: ownerToken })}`);
      await page.getByRole('button', { name: /Touch login fixture/ }).click(); await page.getByRole('button', { name: 'Approve & open', exact: true }).click();
      await page.locator('.remote-screen img').waitFor(); await expect.poll(() => site.formReadyCount).toBe(1);
      let box = await imageBox(page); await tap(cdp, mapped(box, { x: 195, y: 40 })); await expect.poll(() => site.tapCount).toBe(1);
      box = await imageBox(page); const localBefore = await page.locator('.detail-section').evaluate(element => element.scrollTop);
      await swipe(cdp, mapped(box, { x: 195, y: 280 }), mapped(box, { x: 195, y: 120 }));
      await expect.poll(() => site.nestedScrolledCount).toBe(1); expect(site.bodyScrolledCount).toBe(0);
      expect(Math.abs(await page.locator('.detail-section').evaluate(element => element.scrollTop) - localBefore)).toBeLessThan(2);
      for (let index = 0; index < 2; index++) { box = await imageBox(page); await swipe(cdp, mapped(box, { x: 250, y: 620 }), mapped(box, { x: 250, y: 100 })); }
      await expect.poll(() => site.bodyScrolledCount).toBe(1); expect(site.tapCount).toBe(1); expect(site.loginCount).toBe(0);
      await page.getByRole('button', { name: 'Page controls', exact: true }).click();
      const focus = async (name: string) => { await page.getByRole('button', { name: `Focus ${name}`, exact: true }).click(); await page.getByText(`Focus confirmed on ${name}.`, { exact: true }).waitFor(); };
      await focus('Touch email'); await page.getByRole('button', { name: 'Type text', exact: true }).click();
      const text = page.getByLabel('Tap a field in the browser, then send text'); await text.fill(touchFixtureCredentials.email); await page.getByRole('button', { name: 'Send', exact: true }).click();
      await focus('Synthetic touch password'); await text.fill(touchFixtureCredentials.password); await page.getByRole('button', { name: 'Send', exact: true }).click(); expect(await text.inputValue()).toBe('');
      await page.getByRole('button', { name: 'Page controls', exact: true }).click(); await page.getByRole('button', { name: 'Type text', exact: true }).click();
      box = await imageBox(page);
      if (process.env.KEEP_SAFE_QA_SCREENSHOTS) { await mkdir('.keep-safe/qa', { recursive: true }); await page.screenshot({ path: `.keep-safe/qa/touch-scroll-${width}.png`, fullPage: true }); }
      await tap(cdp, mapped(box, { x: 195, y: 680 })); await expect.poll(() => site.loginCount).toBe(1); await expect.poll(() => site.readyCount).toBe(1);
      expect((await client.get(request.id)).browser).toBeUndefined(); await page.getByRole('button', { name: /Done, hand back/ }).click();
      await expect.poll(async () => (await client.get(request.id)).status).toBe('completed'); const result = await client.get(request.id);
      const agent = await chromium.connectOverCDP(result.browser!.cdpUrl);
      try {
        const resumed = agent.contexts().flatMap(context => context.pages()).find(page => page.url() === site.loginUrl)!;
        expect(await resumed.locator('#password').evaluate(element => (element as HTMLInputElement).value === '')).toBe(true);
        expect((await resumed.goto(site.origin + '/account'))?.status()).toBe(200); await resumed.reload(); await resumed.getByRole('heading', { name: 'Touch session authenticated', exact: true }).waitFor();
      } finally { await agent.close(); }
      expect(site.tapCount).toBe(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true); expect(errors).toEqual([]);
    } finally { await cdp.detach(); await context.close(); await bridge.close(); await site.close(); }
  }, 45000);

  async function controlledPhone() {
    const remote = await browser.newPage({ viewport: { width: 3000, height: 720 } });
    await remote.setContent('<style>body{margin:0;width:7000px;height:16000px;background:linear-gradient(white,#cdddc5)}button{position:fixed;inset:0;width:100%;height:100%;background:transparent;border:0}</style><button id="probe">Synthetic gesture target</button><script>document.body.dataset.clicks="0";document.querySelector("button").onclick=()=>{document.body.dataset.clicks=String(Number(document.body.dataset.clicks)+1);};</script>');
    const images = [(await remote.screenshot({ type: 'jpeg' })).toString('base64')];
    await remote.evaluate(() => { document.body.style.backgroundImage = 'linear-gradient(#eeeeee,#cdddc5)'; }); images.push((await remote.screenshot({ type: 'jpeg' })).toString('base64'));
    expect(images[0]).not.toBe(images[1]);
    let frames = 0; let inputScrolls = 0; let outputScrolls = 0; let inputClicks = 0; let sumY = 0; let maxDelta = 0; let anchors = true;
    let frameUrl = 'https://example.com/touch';
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, staticDir: resolve('apps/web/dist'), browserFactory: async () => ({
      frame: async () => ({ data: images[frames++ % 2], width: 3000, height: 720, url: frameUrl }),
      inspectControls: async () => ({ snapshotId: '00000000-0000-4000-8000-000000000001', origin: 'https://example.com', truncated: false, controls: [{ id: '00000000-0000-4000-8000-000000000002', name: 'Synthetic focus target', role: 'button', protected: false, disabled: false }] }),
      input: async message => {
        if (message.type === 'focus') throw new Error('Synthetic failed focus.');
        if (message.type === 'click') { inputClicks++; await remote.mouse.click(Number(message.x), Number(message.y)); }
        if (message.type === 'scroll') {
          inputScrolls++; sumY += Number(message.deltaY); maxDelta = Math.max(maxDelta, Math.abs(Number(message.deltaX)), Math.abs(Number(message.deltaY)));
          anchors &&= typeof message.x === 'number' && typeof message.y === 'number';
          if (typeof message.x === 'number' && typeof message.y === 'number') await remote.mouse.move(message.x, message.y);
          await remote.mouse.wheel(Number(message.deltaX), Number(message.deltaY));
        }
      }, close: async () => { if (!remote.isClosed()) await remote.close(); },
    }) });
    const context = await browser.newContext({ viewport: { width: 320, height: 900 }, isMobile: true, hasTouch: true });
    await context.addInitScript(() => { const Native = window.WebSocket; window.WebSocket = class extends Native { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); (window as unknown as { touchSocket: WebSocket }).touchSocket = this; } }; });
    const page = await context.newPage(); await page.clock.install();
    page.on('websocket', socket => socket.on('framesent', frame => { if (JSON.parse(String(frame.payload)).type === 'scroll') outputScrolls++; }));
    const cdp = await context.newCDPSession(page); const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const request = await client.create({ agent: 'Touch control fixture', title: 'Synthetic gesture checks', url: frameUrl, ttlSeconds: 120 });
    await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: ownerToken })}`);
    await page.getByRole('button', { name: /Touch control fixture/ }).click(); await page.getByRole('button', { name: 'Approve & open', exact: true }).click(); await page.locator('.remote-screen img').waitFor();
    return { remote, bridge, context, page, cdp, client, request, get frames() { return frames; }, get inputScrolls() { return inputScrolls; }, get outputScrolls() { return outputScrolls; }, get inputClicks() { return inputClicks; }, get sumY() { return sumY; }, get maxDelta() { return maxDelta; }, get anchors() { return anchors; }, setUrl: (url: string) => { frameUrl = url; },
      close: async () => { await touch(cdp, 'touchCancel').catch(() => {}); await cdp.detach(); await context.close(); await bridge.close(); if (!remote.isClosed()) await remote.close(); } };
  }

  it('scales and coalesces trusted swipes without clicks, focus recovery or cancelled-touch replay', async () => {
    const test = await controlledPhone(); const { page, cdp } = test;
    try {
      let box = await imageBox(page); await tap(cdp, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      await expect.poll(() => test.inputClicks).toBe(1); expect(await test.remote.evaluate(() => Number(document.body.dataset.clicks))).toBe(1);
      await page.getByRole('button', { name: 'Type text', exact: true }).click(); await page.getByRole('button', { name: 'Page controls', exact: true }).click();
      await page.getByRole('button', { name: 'Focus Synthetic focus target', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'The requested action was not accepted' }).waitFor();
      const text = page.getByLabel('Tap a field in the browser, then send text'); expect(await text.isDisabled()).toBe(true);
      box = await imageBox(page); await page.clock.pauseAt(new Date(Date.now() + 100));
      const from = { x: box.x + box.width / 2, y: box.y + box.height * 0.8 }; const to = { x: from.x, y: from.y - 30 };
      await touch(cdp, 'touchStart', [from]);
      for (let index = 1; index <= 6; index++) await touch(cdp, 'touchMove', [{ x: from.x, y: from.y - index * 5 }]);
      const frameCount = test.frames; await expect.poll(() => test.frames).toBeGreaterThan(frameCount); // JPEG refresh is not a new gesture scope.
      await touch(cdp, 'touchEnd'); await page.clock.runFor(60);
      await expect.poll(() => test.inputScrolls).toBe(1);
      expect(test.sumY).toBeCloseTo(30 * 720 / box.height, 0); expect(test.maxDelta).toBeLessThanOrEqual(3000); expect(test.anchors).toBe(true);
      await expect.poll(() => test.remote.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      expect(test.inputClicks).toBe(1); expect(await text.isDisabled()).toBe(true);
      let count = test.outputScrolls; const offset = await test.remote.evaluate(() => window.scrollY);
      await touch(cdp, 'touchStart', [from]); await touch(cdp, 'touchMove', [to]); await touch(cdp, 'touchCancel'); await page.clock.runFor(100);
      expect(test.outputScrolls).toBe(count); expect(await test.remote.evaluate(() => window.scrollY)).toBe(offset); expect(test.inputClicks).toBe(1);
      await touch(cdp, 'touchStart', [from]); await touch(cdp, 'touchMove', [to]);
      await touch(cdp, 'touchStart', [{ ...to, id: 0 }, { x: 315, y: to.y, id: 1 }]); await touch(cdp, 'touchEnd'); await page.clock.runFor(100);
      expect(test.outputScrolls).toBe(count); expect(test.inputClicks).toBe(1); expect(await text.isDisabled()).toBe(true);
      expect(await page.locator('.remote-screen img').evaluate(element => getComputedStyle(element).touchAction)).toContain('pinch-zoom');
      // Capture keeps a long drag on the remote surface even outside its image.
      // Its scaled delta exceeds the protocol limit and must become one capped batch.
      expect(330 * 720 / box.height).toBeGreaterThan(3000);
      await touch(cdp, 'touchStart', [from]); await touch(cdp, 'touchMove', [{ x: from.x, y: from.y - 330 }]); await touch(cdp, 'touchEnd');
      await page.clock.runFor(49); expect(test.outputScrolls).toBe(count);
      await page.clock.runFor(1); await expect.poll(() => test.outputScrolls).toBe(count + 1);
      expect(test.maxDelta).toBe(3000); await expect.poll(() => test.remote.evaluate(() => window.scrollY)).toBeGreaterThan(offset); count++;
      expect(test.inputClicks).toBe(1); expect(await text.isDisabled()).toBe(true);
      await page.clock.resume(); await page.getByRole('button', { name: 'More keys', exact: true }).click();
      await imageBox(page); const local = await page.locator('.detail-section').evaluate(element => element.scrollTop); const remote = await test.remote.evaluate(() => window.scrollY);
      await swipe(cdp, { x: 8, y: 780 }, { x: 8, y: 300 });
      await expect.poll(() => page.locator('.detail-section').evaluate(element => element.scrollTop)).toBeGreaterThan(local); expect(await test.remote.evaluate(() => window.scrollY)).toBe(remote); expect(test.outputScrolls).toBe(count);
    } finally { await test.close(); }
  }, 30000);

  it('preserves genuine mouse and pen taps while rejecting a press from an older page source', async () => {
    const test = await controlledPhone(); const { page, cdp } = test;
    try {
      const box = await imageBox(page); const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      for (const pointerType of ['mouse', 'pen'] as const) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1, pointerType });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1, pointerType });
        await expect.poll(() => test.inputClicks).toBe(pointerType === 'mouse' ? 1 : 2);
      }
      expect(await test.remote.evaluate(() => Number(document.body.dataset.clicks))).toBe(2);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      test.setUrl('https://other.example.com/touch'); await expect.poll(() => page.locator('.address').innerText()).toBe('https://other.example.com');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      // A subsequent genuine tap is an observable same-socket boundary.
      await tap(cdp, point); await expect.poll(() => test.inputClicks).toBe(3);
      expect(await test.remote.evaluate(() => Number(document.body.dataset.clicks))).toBe(3); expect(test.outputScrolls).toBe(0);
    } finally { await test.close(); }
  }, 30000);

  it.each(['request change', 'reconnect', 'ending', 'source change'])('drops pending trusted gesture input on %s', async lifecycle => {
    const test = await controlledPhone(); const { page, cdp, client } = test;
    try {
      const second = lifecycle === 'request change' ? await client.create({ agent: 'Second touch fixture', title: 'Synthetic second request', url: 'https://example.com/second', ttlSeconds: 120 }) : undefined;
      const box = await imageBox(page); await page.clock.pauseAt(new Date(Date.now() + 100));
      const start = { x: box.x + box.width / 2, y: box.y + box.height * 0.8 };
      await touch(cdp, 'touchStart', [start]); await touch(cdp, 'touchMove', [{ x: start.x, y: start.y - 25 }]);
      expect(test.outputScrolls).toBe(0);
      if (lifecycle === 'reconnect') {
        await page.evaluate(() => (window as unknown as { touchSocket: WebSocket }).touchSocket.close(1000, 'Synthetic touch reconnect'));
        await expect.poll(() => page.locator('.remote-screen img').count()).toBe(0);
        await page.clock.runFor(2200); await expect.poll(() => page.locator('.remote-screen img').count(), { timeout: 5000 }).toBe(1);
      } else if (lifecycle === 'ending') {
        const response = await fetch(`${test.bridge.url}/api/requests/${test.request.id}/deny`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, body: '{}' }); expect(response.ok).toBe(true);
        await expect.poll(() => page.locator('.remote-screen img').count()).toBe(0);
      } else if (lifecycle === 'source change') {
        test.setUrl('https://other.example.com/touch'); await expect.poll(() => page.locator('.address').innerText()).toBe('https://other.example.com');
      } else {
        await mouseActivate(cdp, page.getByRole('button', { name: 'Back to requests', exact: true }));
        await mouseActivate(cdp, page.getByRole('button', { name: /Second touch fixture/ }));
        await mouseActivate(cdp, page.getByRole('button', { name: 'Approve & open', exact: true }));
        await expect.poll(async () => (await client.get(second!.id)).status).toBe('active');
      }
      await touch(cdp, 'touchEnd'); await page.clock.runFor(120);
      expect(test.outputScrolls).toBe(0); expect(test.inputScrolls).toBe(0); expect(test.inputClicks).toBe(0);
      if (!test.remote.isClosed()) expect(await test.remote.evaluate(() => window.scrollY)).toBe(0);
    } finally { await test.close(); }
  }, 30000);
});
