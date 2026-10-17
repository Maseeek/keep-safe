import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';
import { startLoginFixture } from './fixtures/login-site';

const ownerToken = 'synthetic-controls-owner';
const agentToken = 'synthetic-controls-agent';
describe('page controls in the mobile app', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each([320, 390])('completes a real login using named controls without exposing field values at %ipx', async width => {
    const site = await startLoginFixture();
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, allowLocalUrls: true, staticDir: resolve('apps/web/dist') });
    const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const controls: string[] = []; const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => socket.on('framereceived', frame => { const message = JSON.parse(String(frame.payload)); if (message.type === 'controls') controls.push(JSON.stringify(message)); }));
    try {
      const item = await client.create({ agent: 'Control navigation test', title: 'Sign in using page controls', url: site.origin + '/login', ttlSeconds: 120 });
      await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: ownerToken })}`);
      await page.getByText('Bridge connected', { exact: true }).waitFor();
      await page.getByRole('button', { name: /Control navigation test/ }).click();
      await page.getByRole('button', { name: 'Approve & open' }).click();
      await page.locator('.remote-screen img').waitFor();
      await page.getByRole('button', { name: 'Page controls', exact: true }).click();
      await page.getByRole('button', { name: 'Focus Email', exact: true }).click();
      await page.getByText('Focus confirmed on Email.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Type text', exact: true }).click();
      const input = page.getByLabel('Tap a field in the browser, then send text');
      await input.fill('fixture@example.invalid');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByRole('button', { name: 'Focus Synthetic password', exact: true }).click();
      await page.getByText('Focus confirmed on Synthetic password.', { exact: true }).waitFor();
      const description = await page.getByRole('button', { name: 'Focus Synthetic password', exact: true }).getAttribute('aria-describedby');
      expect(await page.locator(`[id="${description}"]`).innerText()).toContain('Password field');
      await input.fill('synthetic-control-password');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const count = controls.length;
      await page.getByRole('button', { name: 'Refresh page controls', exact: true }).click();
      await expect.poll(() => controls.length).toBeGreaterThan(count);
      for (const secret of ['fixture@example.invalid', 'synthetic-control-password']) {
        expect(controls.join('').includes(secret)).toBe(false);
        expect((await page.locator('.page-control-content').innerText()).includes(secret)).toBe(false);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (process.env.KEEP_SAFE_QA_SCREENSHOTS) { await mkdir('.keep-safe/qa', { recursive: true }); await page.screenshot({ path: `.keep-safe/qa/page-controls-${width}.png`, fullPage: true }); }
      await page.getByRole('button', { name: 'Focus Sign in', exact: true }).click();
      await page.getByText('Focus confirmed on Sign in.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Press Enter in browser', exact: true }).click();
      await expect.poll(() => site.loginCount).toBe(1);
      await page.getByRole('button', { name: /Done, hand back/ }).click();
      await expect.poll(async () => (await client.get(item.id)).status).toBe('completed');
      const result = await client.get(item.id);
      const agentBrowser = await chromium.connectOverCDP(result.browser!.cdpUrl);
      try {
        const account = agentBrowser.contexts().flatMap(context => context.pages()).find(page => page.url() === site.origin + '/account');
        expect(account).toBeDefined(); await account!.reload();
        expect(await account!.getByRole('heading').textContent()).toBe('Signed in successfully');
      } finally { await agentBrowser.close(); }
      expect(await page.locator('.page-control-content').count()).toBe(0);
      expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); await site.close(); }
  }, 45000);

  it('blocks text after unconfirmed focus and ignores mismatched and late acknowledgements', async () => {
    const fixturePage = await browser.newPage(); await fixturePage.setContent('<h1>Control fixture</h1>');
    const image = (await fixturePage.screenshot({ type: 'jpeg' })).toString('base64'); await fixturePage.close();
    let finishFocus = () => {};
    const focus = new Promise<void>(resolve => { finishFocus = resolve; });
    const snapshotId = '00000000-0000-4000-8000-000000000001';
    const controlId = '00000000-0000-4000-8000-000000000002';
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, staticDir: resolve('apps/web/dist'), browserFactory: async () => ({
      frame: async () => ({ data: image, width: 390, height: 720, url: 'https://example.com' }),
      inspectControls: async () => ({ snapshotId, origin: 'https://example.com', truncated: false, controls: [{ id: controlId, role: 'textbox', name: 'Email', protected: false, disabled: false }, { id: '00000000-0000-4000-8000-000000000003', role: 'button', name: '', protected: false, disabled: false }] }),
      input: async message => { if (message.type === 'focus') await focus; }, close: async () => {},
    }) });
    const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
    await context.addInitScript(() => {
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); (window as unknown as { qaSocket: WebSocket }).qaSocket = this; }
      };
    });
    const page = await context.newPage();
    try {
      const item = await client.create({ agent: 'Focus fixture', title: 'Pending focus check', url: 'https://example.com', ttlSeconds: 120 });
      await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: ownerToken })}`);
      await page.getByRole('button', { name: /Focus fixture/ }).click(); await page.getByRole('button', { name: 'Approve & open' }).click();
      await page.locator('.remote-screen img').waitFor();
      await page.getByRole('button', { name: 'Type text', exact: true }).click();
      const input = page.getByLabel('Tap a field in the browser, then send text'); await input.fill('discard-before-focus');
      await page.getByRole('button', { name: 'Page controls', exact: true }).click();
      await page.getByRole('button', { name: 'Focus Unnamed button 2', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Focus Email', exact: true }).click();
      await expect.poll(() => input.isDisabled()).toBe(true); expect(await input.inputValue()).toBe('');
      const inject = async (id: string) => page.evaluate(({ requestId, snapshotId, controlId }) => {
        (window as unknown as { qaSocket: WebSocket }).qaSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'focused', requestId, snapshotId, controlId }) }));
      }, { requestId: item.id, snapshotId, controlId: id });
      await inject('00000000-0000-4000-8000-000000000099');
      expect(await input.isDisabled()).toBe(true);
      await page.getByRole('alert').filter({ hasText: 'did not confirm' }).waitFor();
      await inject(controlId); // Correct identifiers arriving after timeout must not unblock text.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      expect(await input.isDisabled()).toBe(true);
      expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true);
      await page.getByRole('button', { name: 'Press Tab in browser', exact: true }).click();
      await expect.poll(() => input.isEnabled()).toBe(true);
    } finally { finishFocus(); await context.close(); await bridge.close(); }
  });
});
