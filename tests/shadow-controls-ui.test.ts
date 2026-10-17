import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';
import { startShadowLoginFixture } from './fixtures/shadow-login-site';

describe('open-shadow login through the phone interface', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each([320, 390])('focuses nested fields, signs in and clears the retained password before authenticated resume at %ipx', async width => {
    const site = await startShadowLoginFixture();
    const bridge = await createBridge({ ownerToken: 'synthetic-shadow-owner', agentToken: 'synthetic-shadow-agent', port: 0, allowLocalUrls: true, staticDir: resolve('apps/web/dist') });
    const client = new BridgeClient({ url: bridge.url, token: 'synthetic-shadow-agent' });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true });
    const page = await context.newPage(); const controls: string[] = []; const errors: string[] = []; const external: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(bridge.url)) external.push(request.url()); });
    page.on('websocket', socket => socket.on('framereceived', frame => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === 'controls') controls.push(JSON.stringify(message));
    }));
    try {
      const item = await client.create({ agent: 'Component login fixture', title: 'Synthetic component sign-in', url: site.origin + '/login', ttlSeconds: 120 });
      await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: 'synthetic-shadow-owner' })}`);
      await page.getByText('Bridge connected', { exact: true }).waitFor();
      await page.getByRole('button', { name: /Component login fixture/ }).click();
      await page.getByRole('button', { name: 'Approve & open' }).click();
      await page.locator('.remote-screen img').waitFor();
      await page.getByRole('button', { name: 'Page controls', exact: true }).click();
      await page.getByRole('button', { name: 'Focus Component email', exact: true }).click();
      await page.getByText('Focus confirmed on Component email.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Type text', exact: true }).click();
      const text = page.getByLabel('Tap a field in the browser, then send text');
      await text.fill('shadow-fixture@example.invalid');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      expect(await text.inputValue()).toBe('');
      const password = page.getByRole('button', { name: 'Focus Synthetic component password', exact: true });
      await password.click();
      await page.getByText('Focus confirmed on Synthetic component password.', { exact: true }).waitFor();
      const description = await password.getAttribute('aria-describedby');
      expect(await page.locator(`[id="${description}"]`).innerText()).toContain('Password field');
      await text.fill('synthetic-shadow-password');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const before = controls.length;
      await page.getByRole('button', { name: 'Refresh page controls', exact: true }).click();
      await expect.poll(() => controls.length).toBeGreaterThan(before);
      for (const value of ['shadow-fixture@example.invalid', 'synthetic-shadow-password', 'Wrong document email label', 'Wrong document password label', 'Wrong fallback action']) {
        expect(controls.join('')).not.toContain(value);
        expect(await page.locator('.page-control-content').innerText()).not.toContain(value);
      }
      expect((await client.get(item.id)).browser).toBeUndefined();
      expect(site.loginCount).toBe(0);
      if (process.env.KEEP_SAFE_QA_SCREENSHOTS) {
        await mkdir('.keep-safe/qa', { recursive: true });
        await page.screenshot({ path: `.keep-safe/qa/shadow-controls-${width}.png`, fullPage: true });
      }
      await page.getByRole('button', { name: 'Focus Sign in component', exact: true }).click();
      await page.getByText('Focus confirmed on Sign in component.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Press Enter in browser', exact: true }).click();
      await expect.poll(() => site.loginCount).toBe(1);
      await expect.poll(() => site.readyCount).toBe(1);
      // The site has hidden its successful form but retained the password node.
      // Handback must clear it before exposing the agent's browser endpoint.
      await page.getByRole('button', { name: /Done, hand back/ }).click();
      await expect.poll(async () => (await client.get(item.id)).status).toBe('completed');
      const result = await client.get(item.id);
      const agent = await chromium.connectOverCDP(result.browser!.cdpUrl);
      try {
        const resumed = agent.contexts().flatMap(context => context.pages()).find(page => page.url() === site.origin + '/login')!;
        expect(resumed).toBeDefined();
        expect(await resumed.locator('keep-safe-login').locator('input[type="password"]').inputValue()).toBe('');
        const account = await resumed.goto(site.origin + '/account');
        expect(account?.status()).toBe(200);
        await resumed.reload();
        expect(await resumed.getByRole('heading').innerText()).toBe('Component session authenticated');
      } finally { await agent.close(); }
      expect(await page.locator('.page-control-content').count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(errors).toEqual([]); expect(external).toEqual([]);
    } finally { await context.close(); await bridge.close(); await site.close(); }
  }, 45000);
});
