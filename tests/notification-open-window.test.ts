import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import webpush from 'web-push';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';

const owner = 'synthetic-open-owner'; const agent = 'synthetic-open-agent';
const source = webpush.generateVAPIDKeys();
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function workerMessage(context: BrowserContext, page: Page, message: object) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  const worker = context.serviceWorkers().find(worker => new URL(worker.url()).origin === new URL(page.url()).origin)!;
  await worker.evaluate(async message => {
    const scope = globalThis as unknown as { clients: { matchAll(options: object): Promise<Array<{ postMessage(message: object): void }>> } };
    for (const client of await scope.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage(message);
  }, message);
}

it.each([390, 1440])('opens the notified request in an already open app at %ipx', async width => {
  const bridge = await createBridge({ ownerToken: owner, agentToken: agent, vapid: source, port: 0, staticDir: resolve('apps/web/dist') });
  const client = new BridgeClient({ url: bridge.url, token: agent });
  const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 }); const page = await context.newPage();
  try {
    await client.create({ agent: 'Older fixture', title: 'An older waiting request', url: 'https://example.invalid/other', ttlSeconds: 120 });
    await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: owner })}`);
    await page.getByText('Bridge connected', { exact: true }).waitFor();
    await page.getByRole('button', { name: /Older fixture/ }).first().waitFor();
    const target = await client.create({ agent: 'New fixture', title: 'The notified request', url: 'https://example.invalid/login', ttlSeconds: 120 });
    await workerMessage(context, page, { type: 'notification-request', version: 1, requestId: target.id, sourceKey: source.publicKey });
    await page.getByRole('heading', { name: target.title, exact: true }).waitFor({ timeout: 5000 });
    expect(await page.getByRole('status', { name: 'Notification notice', exact: true }).count()).toBe(0);
  } finally { await context.close(); await bridge.close(); }
});

it('opens the notified request on a cold start after the computer moved to the address the notification gave', async () => {
  const bridge = await createBridge({ ownerToken: owner, agentToken: agent, vapid: source, port: 0, staticDir: resolve('apps/web/dist') });
  const client = new BridgeClient({ url: bridge.url, token: agent });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true }); const page = await context.newPage();
  try {
    await client.create({ agent: 'Older fixture', title: 'An older waiting request', url: 'https://example.invalid/other', ttlSeconds: 120 });
    const target = await client.create({ agent: 'New fixture', title: 'The notified request', url: 'https://example.invalid/login', ttlSeconds: 120 });
    const response = await fetch(bridge.url + '/api/devices', { method: 'POST', headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic moved phone' }) });
    const device = await response.json() as { token: string; device: object };
    const moved = `http://localhost:${new URL(bridge.url).port}`;
    await page.goto(bridge.url);
    await page.evaluate(async ({ value, record }) => {
      localStorage.setItem('keep-safe.device.v1', JSON.stringify(value));
      await (await caches.open('keep-safe-link-v1')).put('/__keep-safe/link', new Response(JSON.stringify(record)));
    }, { value: { version: 1, url: 'http://127.0.0.1:9', token: device.token, device: device.device, source: source.publicKey }, record: { sourceKey: source.publicKey, url: moved, at: Date.now() } });
    await page.goto('about:blank');
    await page.goto(`${bridge.url}/#${new URLSearchParams({ notificationRequest: target.id, notificationSource: source.publicKey })}`);
    await page.getByRole('dialog', { name: 'Browser request', exact: true }).getByRole('heading', { name: target.title, exact: true }).waitFor({ timeout: 20_000 });
    expect(await page.getByRole('status', { name: 'Notification notice', exact: true }).count()).toBe(0);
    expect((await client.get(target.id)).status).toBe('pending');
  } finally { await context.close(); await bridge.close(); }
}, 30000);
