import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser, type Locator } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';
import { navigationFixtureCredentials, startNavigationLoginFixture } from './fixtures/navigation-login-site';

async function usableTarget(button: Locator) {
  await button.scrollIntoViewIfNeeded();
  const box = (await button.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await button.evaluate(element => { const box = element.getBoundingClientRect(); const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return hit === element || element.contains(hit); })).toBe(true);
}

describe('website navigation through the phone interface', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each([320, 390])('recovers a wrong route and stalled page before authenticated handback at %ipx', async width => {
    const site = await startNavigationLoginFixture();
    const owner = 'synthetic-navigation-owner'; const agent = 'synthetic-navigation-agent';
    const bridge = await createBridge({ ownerToken: owner, agentToken: agent, port: 0, allowLocalUrls: true, staticDir: resolve('apps/web/dist') });
    const client = new BridgeClient({ url: bridge.url, token: agent });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true });
    const page = await context.newPage(); const errors: string[] = []; const external: string[] = [];
    let framePath = ''; let frameEpoch = ''; let completes = 0;
    const directions: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => { if (new URL(route.request().url()).origin === bridge.url) return route.continue(); external.push(new URL(route.request().url()).origin); return route.abort(); });
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/complete')) completes++; });
    page.on('websocket', socket => {
      socket.on('framereceived', frame => { const message = JSON.parse(String(frame.payload)); if (message.type === 'frame') { framePath = new URL(message.url).pathname; frameEpoch = message.frameEpoch; } });
      // Store action names only. Do not log browser text, images or form values.
      socket.on('framesent', frame => { const message = JSON.parse(String(frame.payload)); if (message.type === 'navigate') directions.push(message.direction); });
    });
    const focus = async (name: string) => {
      const refresh = page.getByRole('button', { name: 'Refresh page controls', exact: true });
      if (await refresh.count()) await refresh.click();
      else await page.getByRole('button', { name: 'Page controls', exact: true }).click();
      const target = page.getByRole('button', { name: `Focus ${name}`, exact: true }); await usableTarget(target); await target.click();
      await page.getByText(`Focus confirmed on ${name}.`, { exact: true }).waitFor();
    };
    const pressEnter = () => page.getByRole('button', { name: 'Press Enter in browser', exact: true }).click();
    const navigate = async (name: string, path: string) => {
      const button = page.getByRole('button', { name, exact: true }); await usableTarget(button);
      const before = frameEpoch; await button.click();
      await expect.poll(() => frameEpoch).not.toBe(before);
      await expect.poll(() => framePath).toBe(path);
      await expect.poll(() => button.isEnabled()).toBe(true);
      await page.locator('.remote-screen img').waitFor();
      expect((await client.get(request.id)).browser).toBeUndefined(); expect(completes).toBe(0);
    };
    const request = await client.create({ agent: 'Navigation login fixture', title: 'Synthetic website navigation', url: site.startUrl, ttlSeconds: 120 });
    try {
      await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: owner })}`);
      await page.getByRole('button', { name: /Navigation login fixture/ }).click(); await page.getByRole('button', { name: 'Approve & open', exact: true }).click();
      await page.locator('.remote-screen img').waitFor(); await expect.poll(() => framePath).toBe('/start');
      if (process.env.KEEP_SAFE_QA_SCREENSHOTS) {
        await page.getByRole('group', { name: 'Website navigation', exact: true }).scrollIntoViewIfNeeded();
        await mkdir('.keep-safe/qa', { recursive: true }); await page.screenshot({ path: `.keep-safe/qa/navigation-controls-${width}.png` });
      }
      await focus('Wrong sign-in route'); await pressEnter(); await expect.poll(() => framePath).toBe('/wrong');
      await page.getByRole('button', { name: 'Type text', exact: true }).click();
      const text = page.getByLabel('Tap a field in the browser, then send text');
      await text.fill('synthetic-unsent-navigation-draft'); await page.getByLabel('Show text', { exact: true }).check();
      await navigate('Back in the website', '/start');
      if (!(await text.count())) await page.getByRole('button', { name: 'Type text', exact: true }).click();
      expect(await text.inputValue()).toBe(''); expect(await text.getAttribute('type')).toBe('password'); expect(await page.getByLabel('Show text', { exact: true }).isChecked()).toBe(false);
      expect(await text.isDisabled()).toBe(true);
      await navigate('Forward in the website', '/wrong'); await navigate('Back in the website', '/start');
      await focus('Practice login'); await pressEnter(); await expect.poll(() => framePath).toBe('/login');
      expect(site.loginViews).toBe(1); await navigate('Reload website', '/login'); await expect.poll(() => site.loginViews).toBe(2);
      await focus('Synthetic navigation password');
      if (!(await text.count())) await page.getByRole('button', { name: 'Type text', exact: true }).click();
      await text.fill('synthetic-discarded-on-reload'); await page.getByRole('button', { name: 'Send', exact: true }).click();
      // Same-URL reload must still discard local drafts and require renewed focus.
      await text.fill('synthetic-unsent-same-url-draft'); await page.getByLabel('Show text', { exact: true }).check();
      await navigate('Reload website', '/login'); await expect.poll(() => site.loginViews).toBe(3);
      if (!(await text.count())) await page.getByRole('button', { name: 'Type text', exact: true }).click();
      expect(await text.inputValue()).toBe(''); expect(await text.getAttribute('type')).toBe('password'); expect(await text.isDisabled()).toBe(true);
      await focus('Navigation email'); await text.fill(navigationFixtureCredentials.email); await page.getByRole('button', { name: 'Send', exact: true }).click();
      await focus('Synthetic navigation password'); await text.fill(navigationFixtureCredentials.password); await page.getByRole('button', { name: 'Send', exact: true }).click();
      await focus('Sign in navigation fixture'); await pressEnter(); await expect.poll(() => site.readyCount).toBe(1); expect(site.loginCount).toBe(1);
      if (process.env.KEEP_SAFE_QA_SCREENSHOTS) { await mkdir('.keep-safe/qa', { recursive: true }); await page.screenshot({ path: `.keep-safe/qa/navigation-${width}.png`, fullPage: true }); }
      await page.getByRole('button', { name: /Done, hand back/ }).click(); await expect.poll(async () => (await client.get(request.id)).status).toBe('completed');
      const result = await client.get(request.id); const resumed = await chromium.connectOverCDP(result.browser!.cdpUrl);
      try { const remote = resumed.contexts().flatMap(context => context.pages()).find(page => page.url() === site.loginUrl)!;
        expect(await remote.locator('#password').evaluate(input => (input as HTMLInputElement).value === '')).toBe(true);
        expect((await remote.goto(site.origin + '/account'))?.status()).toBe(200); await remote.reload(); await remote.getByRole('heading', { name: 'Navigation session authenticated', exact: true }).waitFor();
      } finally { await resumed.close(); }
      expect(directions).toEqual(['back', 'forward', 'back', 'reload', 'reload']); expect(completes).toBe(1); expect(errors).toEqual([]); expect(external).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    } finally { await context.close(); await bridge.close(); await site.close(); }
  }, 60000);
});
