import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';
import { startLoginFixture } from './fixtures/login-site';

describe('built mobile application', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it('completes the labeled demo flow on a phone layout without external requests', async () => {
    const bridge = await createBridge({ ownerToken: 'ui-test-owner', agentToken: 'ui-test-agent', port: 0, staticDir: resolve('apps/web/dist') });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors: string[] = [];
    const external: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(bridge.url)) external.push(request.url()); });
    try {
      await page.goto(bridge.url);
      await page.getByRole('button', { name: /Claude Code github.com/ }).click();
      await page.getByRole('button', { name: 'Approve & open' }).click();
      await page.getByRole('button', { name: /Simulate signing in/ }).click();
      await page.getByRole('button', { name: /Done, hand back/ }).click();
      await expect.poll(() => page.getByRole('heading', { name: 'Back in good hands.' }).isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await page.locator('input[type="password"]').count()).toBe(0);
      if (process.env.KEEP_SAFE_QA_SCREENSHOTS) {
        await mkdir('.keep-safe/qa', { recursive: true });
        await page.screenshot({ path: '.keep-safe/qa/mobile-demo.png', fullPage: true });
      }
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); }
  });

  it('pairs, approves, streams the actual browser, types and completes a login through the mobile interface', async () => {
    const fixture = await startLoginFixture();
    const bridge = await createBridge({ ownerToken: 'ui-test-owner', agentToken: 'ui-test-agent', port: 0, allowLocalUrls: true, staticDir: resolve('apps/web/dist') });
    const client = new BridgeClient({ url: bridge.url, token: 'ui-test-agent' });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      const request = await client.create({ agent: 'UI Test Agent', title: 'Sign in to test workspace', url: fixture.origin + '/login', ttlSeconds: 120 });
      const hash = new URLSearchParams({ bridge: bridge.url, token: 'ui-test-owner' });
      await page.goto(`${bridge.url}/#${hash}`);
      await expect.poll(() => page.getByText('Bridge connected', { exact: true }).count()).toBeGreaterThan(0);
      expect(new URL(page.url()).hash).toBe('');
      await page.getByRole('button', { name: /UI Test Agent/ }).click();
      await page.getByRole('button', { name: 'Approve & open' }).click();
      const frame = page.locator('.remote-screen img');
      await frame.waitFor({ state: 'visible' });
      await expect.poll(async () => (await client.get(request.id)).status).toBe('active');
      expect((await client.get(request.id)).browser).toBeUndefined();
      // Focus fields through the remote browser toolbar, then send synthetic text.
      await page.getByTitle('Press Tab in browser').click();
      await page.getByRole('button', { name: 'Type text', exact: true }).click();
      const input = page.getByLabel('Tap a field in the browser, then send text');
      await input.fill('fixture@example.invalid');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      expect(await input.inputValue()).toBe('');
      await page.getByTitle('Press Tab in browser').click();
      await input.fill('synthetic-test-only');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByTitle('Press Enter in browser').click();
      // A changed live frame URL proves the form submitted through the phone UI.
      await expect.poll(() => page.locator('.remote-screen img').getAttribute('src')).not.toBeNull();
      await expect.poll(() => fixture.loginCount, { timeout: 10000 }).toBe(1);
      await page.getByRole('button', { name: /Done, hand back/ }).click();
      await expect.poll(async () => (await client.get(request.id)).status).toBe('completed');
      const result = await client.get(request.id);
      const agentBrowser = await chromium.connectOverCDP(result.browser!.cdpUrl);
      try {
        const signedInPage = agentBrowser.contexts().flatMap(context => context.pages()).find(page => page.url() === fixture.origin + '/account');
        expect(signedInPage).toBeDefined();
        await signedInPage!.reload();
        expect(await signedInPage!.getByRole('heading').textContent()).toBe('Signed in successfully');
      } finally { await agentBrowser.close(); }
      if (process.env.KEEP_SAFE_QA_SCREENSHOTS) {
        await mkdir('.keep-safe/qa', { recursive: true });
        await page.screenshot({ path: '.keep-safe/qa/mobile-live.png', fullPage: true });
      }
      expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); await fixture.close(); }
  }, 45000);
});
