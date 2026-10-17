import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser, type Locator } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';
import type { PageControlsSnapshot } from '../packages/shared/src/protocol';
import { startFrameLoginFixture } from './fixtures/frame-login-site';

const ownerToken = 'synthetic-frame-owner';
const agentToken = 'synthetic-frame-agent';
const modes = [
  { width: 320, crossOrigin: false }, { width: 390, crossOrigin: false },
  { width: 320, crossOrigin: true }, { width: 390, crossOrigin: true },
];
async function describedText(button: Locator) {
  return button.evaluate(element => (element.getAttribute('aria-describedby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '));
}
async function targetFits(button: Locator) {
  await button.scrollIntoViewIfNeeded();
  const box = (await button.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await button.evaluate(element => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === element || element.contains(hit);
  })).toBe(true);
}

describe('embedded login through the phone interface', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each(modes)('names the real frame origin and resumes an authenticated embedded login at $width px (cross-origin: $crossOrigin)', async ({ width, crossOrigin }) => {
    const site = await startFrameLoginFixture({ crossOrigin });
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, allowLocalUrls: true, staticDir: resolve('apps/web/dist') });
    const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const snapshots: PageControlsSnapshot[] = []; const errors: string[] = []; const external: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === bridge.url) return route.continue();
      external.push(new URL(route.request().url()).origin); return route.abort();
    });
    page.on('websocket', socket => socket.on('framereceived', frame => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === 'controls') snapshots.push(message.snapshot as PageControlsSnapshot);
    }));
    try {
      const request = await client.create({ agent: 'Embedded login fixture', title: 'Synthetic embedded sign-in', url: site.origin + '/workspace', ttlSeconds: 120 });
      await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: ownerToken })}`);
      await page.getByText('Bridge connected', { exact: true }).waitFor();
      await page.getByRole('button', { name: /Embedded login fixture/ }).click();
      await page.getByRole('button', { name: 'Approve & open', exact: true }).click();
      await page.locator('.remote-screen img').waitFor();
      await expect.poll(() => site.formReadyCount).toBe(1);
      await page.getByRole('button', { name: 'Page controls', exact: true }).click();
      const email = page.getByRole('button', { name: 'Focus Embedded email', exact: true });
      await email.waitFor();
      await expect.poll(() => snapshots.length).toBeGreaterThan(0);
      const snapshot = snapshots.at(-1)!;
      expect(snapshot.origin).toBe(site.origin);
      const main = snapshot.controls.find(control => control.name === 'Top page help')!;
      expect(main).toBeDefined(); expect(main.embedded).toBeUndefined(); expect(main.frameOrigin).toBeUndefined();
      for (const name of ['Embedded email', 'Synthetic embedded password', 'Sign in embedded page']) {
        const control = snapshot.controls.find(control => control.name === name)!;
        expect(control).toMatchObject({ embedded: true, frameOrigin: site.frameOrigin });
      }
      expect(crossOrigin ? site.frameOrigin !== site.origin : site.frameOrigin === site.origin).toBe(true);
      expect(await describedText(email)).toContain(`Embedded page · ${site.frameOrigin}`);
      await targetFits(email); await email.click();
      await page.getByText(`Focus confirmed on Embedded email in ${site.frameOrigin}.`, { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Type text', exact: true }).click();
      const text = page.getByLabel('Tap a field in the browser, then send text');
      await text.fill('embedded-fixture@example.invalid');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      expect(await text.inputValue()).toBe('');
      const password = page.getByRole('button', { name: 'Focus Synthetic embedded password', exact: true });
      expect(await describedText(password)).toContain('Password field');
      expect(await describedText(password)).toContain(`Embedded page · ${site.frameOrigin}`);
      await targetFits(password); await password.click();
      await page.getByText(`Focus confirmed on Synthetic embedded password in ${site.frameOrigin}.`, { exact: true }).waitFor();
      await text.fill('synthetic-embedded-password');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      expect(await text.inputValue()).toBe('');
      const count = snapshots.length;
      await page.getByRole('button', { name: 'Refresh page controls', exact: true }).click();
      await expect.poll(() => snapshots.length).toBeGreaterThan(count);
      for (const excluded of ['embedded-fixture@example.invalid', 'synthetic-embedded-password', '/private-embedded-form', 'frame_hint', 'synthetic-query-only', 'synthetic-fragment-only', '/private-help', 'synthetic-link-only']) {
        expect(JSON.stringify(snapshots)).not.toContain(excluded);
        expect(await page.locator('.page-control-content').innerText()).not.toContain(excluded);
      }
      expect((await client.get(request.id)).browser).toBeUndefined();
      expect(site.loginCount).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (process.env.KEEP_SAFE_QA_SCREENSHOTS) {
        await mkdir('.keep-safe/qa', { recursive: true });
        await page.screenshot({ path: `.keep-safe/qa/frame-controls-${crossOrigin ? 'cross' : 'same'}-${width}.png`, fullPage: true });
      }
      const submit = page.getByRole('button', { name: 'Focus Sign in embedded page', exact: true });
      await targetFits(submit); await submit.click();
      await page.getByText(`Focus confirmed on Sign in embedded page in ${site.frameOrigin}.`, { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Press Enter in browser', exact: true }).click();
      await expect.poll(() => site.loginCount).toBe(1);
      await expect.poll(() => site.readyCount).toBe(1);
      expect((await client.get(request.id)).browser).toBeUndefined();
      await page.getByRole('button', { name: /Done, hand back/ }).click();
      await expect.poll(async () => (await client.get(request.id)).status).toBe('completed');
      const result = await client.get(request.id);
      const agent = await chromium.connectOverCDP(result.browser!.cdpUrl);
      try {
        const resumed = agent.contexts().flatMap(context => context.pages()).find(page => page.url() === site.origin + '/workspace')!;
        expect(resumed).toBeDefined();
        const embedded = resumed.frames().find(frame => frame.parentFrame() && new URL(frame.url()).origin === site.frameOrigin)!;
        expect(embedded).toBeDefined();
        // Only an empty/nonempty verdict leaves the retained remote field.
        expect(await embedded.locator('#password').evaluate(element => (element as HTMLInputElement).value === '')).toBe(true);
        await resumed.reload();
        await resumed.frameLocator('iframe').getByRole('heading', { name: 'Embedded session authenticated', exact: true }).waitFor();
        expect(site.loginCount).toBe(1);
      } finally { await agent.close(); }
      expect(await page.locator('.page-control-content').count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(external).toEqual([]); expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); await site.close(); }
  }, 45000);

  it.each([320, 390])('wraps a complete embedded origin in the control and focus description at %ipx', async width => {
    const source = await browser.newPage();
    await source.setContent('<h1>Synthetic origin layout fixture</h1>');
    const jpeg = (await source.screenshot({ type: 'jpeg' })).toString('base64');
    await source.close();
    const origin = `https://${'component'.repeat(6)}.${'login'.repeat(12)}.identity.example.invalid:8443`;
    const snapshotId = '00000000-0000-4000-8000-000000000001';
    const controlId = '00000000-0000-4000-8000-000000000002';
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, staticDir: resolve('apps/web/dist'), browserFactory: async () => ({
      frame: async () => ({ data: jpeg, width: 390, height: 720, url: 'https://example.com' }),
      inspectControls: async () => ({ snapshotId, origin: 'https://example.com', truncated: false, controls: [{ id: controlId, role: 'button', name: 'Origin layout action', protected: false, disabled: false, embedded: true, frameOrigin: origin }] }),
      input: async () => {}, close: async () => {},
    }) });
    const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true });
    const page = await context.newPage(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await client.create({ agent: 'Origin layout fixture', title: 'Synthetic origin wrapping', url: 'https://example.com', ttlSeconds: 120 });
      await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: ownerToken })}`);
      await page.getByRole('button', { name: /Origin layout fixture/ }).click();
      await page.getByRole('button', { name: 'Approve & open', exact: true }).click();
      await page.locator('.remote-screen img').waitFor();
      await page.getByRole('button', { name: 'Page controls', exact: true }).click();
      const button = page.getByRole('button', { name: 'Focus Origin layout action', exact: true });
      await button.waitFor();
      expect(await describedText(button)).toContain(`Embedded page · ${origin}`);
      expect(await button.locator('.page-control-frame').innerText()).toBe(`Embedded page · ${origin}`);
      expect(await button.locator('.page-control-frame').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await targetFits(button); await button.click();
      await page.getByText(`Focus confirmed on Origin layout action in ${origin}.`, { exact: true }).waitFor();
      expect(await page.locator('.page-control-focus > span').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); }
  });
});
