import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { findDesktopTools } from '../packages/bridge/src/desktop';
import { BridgeClient } from '../packages/mcp/src/client';
import { startLoginFixture } from './fixtures/login-site';
import { switchToLiveBrowser } from './helpers/live-browser';

const tools = await findDesktopTools();
// The owner's sign-in on a private display, from the built phone app. Opens
// real Chrome (a window, with Xephyr), so it runs only on request:
// KEEP_SAFE_BROWSER=chrome npx vitest run tests/desktop-sign-in-ui.test.ts
describe.skipIf(process.env.KEEP_SAFE_BROWSER !== 'chrome' || !tools)('desktop sign-in from the phone', () => {
  it('signs in with a tap that raises the phone keyboard, password boxes and Back, then gives the agent the signed-in browser', async () => {
    const fixture = await startLoginFixture();
    const bridge = await createBridge({ ownerToken: 'desktop-owner', agentToken: 'desktop-agent', port: 0, allowLocalUrls: true, staticDir: resolve('apps/web/dist') });
    const client = new BridgeClient({ url: bridge.url, token: 'desktop-agent' });
    const phone = await chromium.launch();
    let agent: Browser | undefined;
    try {
      const status = await (await fetch(`${bridge.url}/api/status`, { headers: { Authorization: 'Bearer desktop-agent' } })).json() as { browser?: string; signIn?: string };
      expect(status).toMatchObject({ browser: 'chrome', signIn: tools!.server.kind });
      const request = await client.create({ agent: 'Desktop test', title: 'Sign in to the test workspace', url: `${fixture.origin}/login`, ttlSeconds: 180 });
      const context = await phone.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: 'desktop-owner' })}`);
      await page.getByRole('button', { name: /Desktop test/ }).click();
      await page.getByRole('button', { name: 'Approve & open' }).click();
      const liveTab = page.getByRole('tab', { name: 'Live browser', exact: true });
      const screen = page.locator('.remote-screen img');
      await Promise.race([liveTab.waitFor({ state: 'visible', timeout: 20_000 }), screen.waitFor({ state: 'visible', timeout: 20_000 })]);
      if (await liveTab.isVisible()) await switchToLiveBrowser(page);
      await screen.waitFor({ state: 'visible', timeout: 20_000 });
      await expect.poll(() => page.locator('.address').innerText()).toBe('Address shown in page');
      // Nothing for the agent while the owner signs in.
      expect((await client.get(request.id)).browser).toBeUndefined();
      await page.waitForTimeout(1500);
      // A tap on the email field, below Chrome's toolbar, raises the phone's
      // own keyboard, set for an email address. Chrome reports focus a few
      // seconds after the sign-in starts, so the first taps may not.
      const box = (await screen.boundingBox())!;
      const keyboard = page.locator('.live-keyboard-input');
      await expect.poll(async () => {
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * (350 / 720));
        await page.waitForTimeout(700);
        return keyboard.evaluate(element => element === document.activeElement);
      }, { timeout: 20_000, interval: 500 }).toBe(true);
      expect(await keyboard.getAttribute('inputmode')).toBe('email');
      await page.keyboard.type('fixture@example.invalid');
      await page.getByRole('button', { name: 'Press Tab in browser' }).click();
      await page.getByRole('button', { name: /Passwords/ }).click();
      await page.locator('#credential-password').fill('synthetic-test-only');
      await page.getByRole('button', { name: 'Send password' }).click();
      await page.getByRole('button', { name: 'Press Enter in browser' }).click();
      await expect.poll(() => fixture.loginCount, { timeout: 10_000 }).toBe(1);
      await page.waitForTimeout(1000);
      // Back to the sign-in page, with Chrome's own shortcut on the private display.
      await page.getByRole('button', { name: 'Back in the website' }).click();
      await page.waitForTimeout(1500);
      await page.getByRole('button', { name: 'Done, hand back' }).click();
      const result = await client.wait(request.id, 30);
      expect(result.status).toBe('completed');
      expect(result.browser?.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(result.browser?.pageUrl).toBe(`${fixture.origin}/login`);
      agent = await chromium.connectOverCDP(result.browser!.cdpUrl);
      const resumed = agent.contexts().flatMap(item => item.pages()).find(item => item.url() === `${fixture.origin}/login`)!;
      // The session cookie from the sign-in survived the restart into the agent's Chrome.
      await resumed.goto(`${fixture.origin}/account`);
      expect(await resumed.locator('h1').textContent()).toBe('Signed in successfully');
      expect(fixture.loginCount).toBe(1);
      expect(errors).toEqual([]);
      await context.close();
    } finally {
      await agent?.close();
      await phone.close();
      await bridge.close();
      await fixture.close();
    }
  }, 120_000);
});
