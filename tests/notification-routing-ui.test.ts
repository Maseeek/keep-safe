import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import webpush from 'web-push';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';
import type { DevicePairResult } from '../packages/shared/src/protocol';
import { backgroundFixtureCredentials, startBackgroundLoginFixture } from './fixtures/background-login-site';

const owner = 'synthetic-routing-owner'; const agent = 'synthetic-routing-agent';
const source = webpush.generateVAPIDKeys(); const otherSource = webpush.generateVAPIDKeys();
type RoutingBridge = Awaited<ReturnType<typeof createBridge>>;

// Exercise the actual registered worker → WindowClient.postMessage → App path.
// Message contents are controlled. This does not click an OS notification or
// contact a push provider, and does not prove physical-phone delivery.
async function workerMessage(context: BrowserContext, page: Page, message: object) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  const worker = context.serviceWorkers().find(worker => new URL(worker.url()).origin === new URL(page.url()).origin);
  expect(worker).toBeTruthy();
  await worker!.evaluate(async ({ href, message }) => {
    const scope = globalThis as unknown as { clients: { matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<Array<{ url: string; postMessage(message: object): void }>> } };
    // WindowClient URL can retain the document's initial fragment after the
    // app removes pairing fields with replaceState. Each isolated test context
    // has exactly one app document; do not inspect or export its fragment.
    const expected = new URL(href);
    const targets = (await scope.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(client => { const url = new URL(client.url); return url.origin === expected.origin && url.pathname === expected.pathname; });
    if (targets.length !== 1) throw new Error('A unique synthetic worker client was not found.');
    targets[0].postMessage(message);
  }, { href: page.url(), message });
}
const notification = (requestId: string, sourceKey = source.publicKey) => ({ type: 'notification-request', version: 1, requestId, sourceKey });
async function pair(bridge: RoutingBridge) {
  const response = await fetch(bridge.url + '/api/devices', { method: 'POST', headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic notification phone' }) });
  expect(response.status).toBe(201); return response.json() as Promise<DevicePairResult>;
}
async function remember(context: BrowserContext, bridge: RoutingBridge, device: DevicePairResult) {
  await context.addInitScript(({ origin, value }) => { if (location.origin === origin) localStorage.setItem('keep-safe.device.v1', value); },
    { origin: bridge.url, value: JSON.stringify({ url: bridge.url, token: device.token, device: device.device }) });
}
async function readableNotice(notice: Locator) {
  const style = await notice.evaluate(element => { const text = getComputedStyle(element.querySelector('p')!); return { color: text.color, background: getComputedStyle(element).backgroundColor, size: parseFloat(text.fontSize) }; });
  const luminance = (color: string) => { const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(value => Number(value) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4); return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; };
  const values = [luminance(style.color), luminance(style.background)].sort((a, b) => a - b);
  expect((values[1] + 0.05) / (values[0] + 0.05)).toBeGreaterThanOrEqual(4.5); expect(style.size).toBeGreaterThanOrEqual(14);
}

describe('notification routing with the registered service worker', () => {
  let browser: Browser; let image: string;
  beforeAll(async () => {
    browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 390, height: 720 } });
    await page.setContent('<h1>Synthetic notification browser</h1>'); image = (await page.screenshot({ type: 'jpeg' })).toString('base64'); await page.close();
  });
  afterAll(async () => { await browser?.close(); });

  it.each([320, 390])('preserves the current login until an exact notification is deliberately opened at %ipx', async width => {
    const site = await startBackgroundLoginFixture();
    const bridge = await createBridge({ ownerToken: owner, agentToken: agent, vapid: source, port: 0, allowLocalUrls: true, staticDir: resolve('apps/web/dist') });
    const client = new BridgeClient({ url: bridge.url, token: agent });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true }); const page = await context.newPage();
    const watches: string[] = []; const errors: string[] = []; let completions = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/complete')) completions++; });
    page.on('websocket', socket => socket.on('framesent', frame => { const message = JSON.parse(String(frame.payload)); if (message.type === 'watch') watches.push(message.requestId); }));
    try {
      const current = await client.create({ agent: 'Current routing fixture', title: 'Keep the current login', url: site.loginUrl, ttlSeconds: 180 });
      const target = await client.create({ agent: 'Target routing fixture', title: 'Exact notification request', url: site.loginUrl, ttlSeconds: 180 });
      await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: owner })}`);
      await page.getByRole('button', { name: /Current routing fixture/ }).click(); await page.getByRole('button', { name: 'Approve & open', exact: true }).click();
      await page.locator('.remote-screen img').waitFor(); await page.getByRole('button', { name: 'Type text', exact: true }).click();
      const text = page.getByLabel('Tap a field in the browser, then send text'); await text.fill('synthetic-preserved-notification-draft'); await page.getByLabel('Show text', { exact: true }).check();
      const notice = page.getByRole('status', { name: 'Notification notice', exact: true });
      for (const message of [notification(target.id, otherSource.publicKey), notification(randomUUID()), { type: 'open-request', requestId: target.id }, { type: 'notification-request', version: 1, requestId: target.id }]) {
        await workerMessage(context, page, message); await notice.waitFor();
        expect(await page.getByRole('dialog', { name: 'Browser request', exact: true }).getByRole('heading', { name: current.title, exact: true }).count()).toBe(1);
        expect(await text.inputValue()).toBe('synthetic-preserved-notification-draft'); expect(await page.getByLabel('Show text', { exact: true }).isChecked()).toBe(true);
        expect(watches).toEqual([current.id]); expect((await client.get(target.id)).status).toBe('pending'); expect(completions).toBe(0);
        expect(await notice.getByRole('button', { name: 'Open request', exact: true }).count()).toBe(0);
        await page.getByRole('button', { name: 'Dismiss notification notice', exact: true }).click(); await expect.poll(() => notice.count()).toBe(0);
      }
      await workerMessage(context, page, notification(target.id)); const open = notice.getByRole('button', { name: 'Open request', exact: true }); await open.waitFor();
      await readableNotice(notice);
      expect(await text.inputValue()).toBe('synthetic-preserved-notification-draft'); expect(watches).toEqual([current.id]);
      await open.scrollIntoViewIfNeeded(); const box = (await open.boundingBox())!; expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(await notice.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      if (process.env.KEEP_SAFE_QA_SCREENSHOTS) { await mkdir('.keep-safe/qa', { recursive: true }); await notice.screenshot({ path: `.keep-safe/qa/notification-open-prompt-${width}.png` }); }
      await open.click(); await page.getByRole('dialog', { name: 'Browser request', exact: true }).getByRole('heading', { name: target.title, exact: true }).waitFor();
      expect((await client.get(target.id)).status).toBe('pending'); expect(watches).toEqual([current.id]);
      await page.getByRole('button', { name: 'Back to requests', exact: true }).click(); await page.getByRole('button', { name: /Current routing fixture/ }).click();
      await page.locator('.remote-screen img').waitFor(); await page.getByRole('button', { name: 'Type text', exact: true }).click();
      expect(await text.inputValue()).toBe(''); expect(await text.getAttribute('type')).toBe('password');
      await page.getByRole('button', { name: 'Page controls', exact: true }).click();
      const focus = async (name: string) => { await page.getByRole('button', { name: `Focus ${name}`, exact: true }).click(); await page.getByText(`Focus confirmed on ${name}.`, { exact: true }).waitFor(); };
      await focus('Background email'); await text.fill(backgroundFixtureCredentials.email); await page.getByRole('button', { name: 'Send', exact: true }).click();
      await focus('Synthetic background password'); await text.fill(backgroundFixtureCredentials.password); await page.getByRole('button', { name: 'Send', exact: true }).click();
      await focus('Sign in background fixture'); await page.getByRole('button', { name: 'Press Enter in browser', exact: true }).click(); await expect.poll(() => site.readyCount).toBe(1);
      await page.getByRole('button', { name: /Done, hand back/ }).click(); await expect.poll(async () => (await client.get(current.id)).status).toBe('completed');
      const result = await client.get(current.id); const resumed = await chromium.connectOverCDP(result.browser!.cdpUrl);
      try { const remote = resumed.contexts().flatMap(context => context.pages()).find(page => page.url() === site.loginUrl)!;
        expect(await remote.locator('#password').evaluate(input => (input as HTMLInputElement).value === '')).toBe(true);
        expect((await remote.goto(site.origin + '/account'))?.status()).toBe(200); await remote.reload(); await remote.getByRole('heading', { name: 'Background session authenticated', exact: true }).waitFor();
      } finally { await resumed.close(); }
      expect(completions).toBe(1); expect((await client.get(target.id)).status).toBe('pending'); expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    } finally { await context.close(); await bridge.close(); await site.close(); }
  }, 60000);

  it('opens an exact fresh-window request after remembered pairing without automatically approving it', async () => {
    const bridge = await createBridge({ ownerToken: owner, agentToken: agent, vapid: source, port: 0, staticDir: resolve('apps/web/dist') });
    const client = new BridgeClient({ url: bridge.url, token: agent }); const context = await browser.newContext({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true }); const page = await context.newPage();
    try {
      await client.create({ agent: 'Unrelated fresh fixture', title: 'Do not select this request', url: 'https://example.invalid/other', ttlSeconds: 120 });
      const target = await client.create({ agent: 'Exact fresh fixture', title: 'The fresh notification target', url: 'https://example.invalid/login', ttlSeconds: 120 });
      await remember(context, bridge, await pair(bridge));
      await page.goto(`${bridge.url}/#${new URLSearchParams({ notificationRequest: target.id, notificationSource: source.publicKey })}`);
      await page.getByText('Bridge connected', { exact: true }).waitFor(); await page.getByRole('dialog', { name: 'Browser request', exact: true }).getByRole('heading', { name: target.title, exact: true }).waitFor();
      expect((await client.get(target.id)).status).toBe('pending'); expect(await page.locator('.remote-screen img').count()).toBe(0); expect(new URL(page.url()).hash).toBe('');
      if (process.env.KEEP_SAFE_QA_SCREENSHOTS) { await mkdir('.keep-safe/qa', { recursive: true }); await page.screenshot({ path: '.keep-safe/qa/notification-fresh-phone.png' }); }
    } finally { await context.close(); await bridge.close(); }
  });

  it.each(['wrong source', 'unknown request', 'legacy entry', 'neutral entry'])('keeps a fresh desktop notification neutral for %s with an approved first request', async reason => {
    let opens = 0; const watches: string[] = [];
    const bridge = await createBridge({ ownerToken: owner, agentToken: agent, vapid: source, port: 0, staticDir: resolve('apps/web/dist'), browserFactory: async () => { opens++; return { frame: async () => ({ data: image, width: 390, height: 720, url: 'https://example.invalid/login' }), input: async () => {}, close: async () => {} }; } });
    const client = new BridgeClient({ url: bridge.url, token: agent }); const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await context.newPage();
    page.on('websocket', socket => socket.on('framesent', frame => { const message = JSON.parse(String(frame.payload)); if (message.type === 'watch') watches.push(message.requestId); }));
    try {
      const first = await client.create({ agent: 'Approved unrelated fixture', title: 'Do not open the approved browser', url: 'https://example.invalid/login', ttlSeconds: 120 });
      expect((await fetch(`${bridge.url}/api/requests/${first.id}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' }, body: '{}' })).ok).toBe(true);
      await remember(context, bridge, await pair(bridge));
      const fragment = reason === 'legacy entry' ? new URLSearchParams({ request: first.id }) : reason === 'neutral entry' ? new URLSearchParams({ notificationInbox: '1' })
        : new URLSearchParams({ notificationRequest: reason === 'unknown request' ? randomUUID() : first.id, notificationSource: reason === 'wrong source' ? otherSource.publicKey : source.publicKey });
      await page.goto(`${bridge.url}/#${fragment}`); await page.getByText('Bridge connected', { exact: true }).waitFor(); await page.getByRole('status', { name: 'Notification notice', exact: true }).waitFor();
      await readableNotice(page.getByRole('status', { name: 'Notification notice', exact: true }));
      expect(await page.getByRole('region', { name: 'Request from Approved unrelated fixture', exact: true }).count()).toBe(0);
      expect(await page.locator('.remote-screen img').count()).toBe(0); expect(watches).toEqual([]); expect(opens).toBe(0); expect((await client.get(first.id)).browser).toBeUndefined(); expect(new URL(page.url()).hash).toBe('');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (process.env.KEEP_SAFE_QA_SCREENSHOTS && reason === 'wrong source') { await mkdir('.keep-safe/qa', { recursive: true }); await page.screenshot({ path: '.keep-safe/qa/notification-neutral-desktop.png' }); }
    } finally { await context.close(); await bridge.close(); }
  });
});
