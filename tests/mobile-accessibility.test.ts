import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser, type Locator } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';

async function touchTarget(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await target.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const hitTest = await target.evaluate(element => {
    const box = element.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { reachable: top === element || element.contains(top), target: element.getAttribute('aria-label') || element.textContent, x: box.x, y: box.y, hit: top?.outerHTML.slice(0, 250) };
  });
  if (!hitTest.reachable && process.env.KEEP_SAFE_QA_SCREENSHOTS) await target.page().screenshot({ path: '.keep-safe/qa/unreachable-target.png' });
  expect(hitTest.reachable, JSON.stringify(hitTest)).toBe(true);
}

async function textContrast(target: Locator) {
  const colors = await target.evaluate(element => ({ foreground: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(value => Number(value) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(colors.foreground), luminance(colors.background)].sort((a, b) => a - b);
  return (values[1] + 0.05) / (values[0] + 0.05);
}

describe('mobile readability and keyboard access', () => {
  let browser: Browser;
  let image: string;
  beforeAll(async () => {
    browser = await chromium.launch();
    const fixture = await browser.newPage({ viewport: { width: 390, height: 720 } });
    await fixture.setContent('<h1>Synthetic browser fixture</h1>');
    image = (await fixture.screenshot({ type: 'jpeg' })).toString('base64');
    await fixture.close();
  });
  afterAll(async () => { await browser?.close(); });

  it.each([320, 390])('keeps readable request controls and returns modal focus at %ipx', async width => {
    const bridge = await createBridge({ ownerToken: 'access-owner', agentToken: 'access-agent', port: 0, staticDir: resolve('apps/web/dist') });
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
      await page.goto(bridge.url);
      const filters = page.getByRole('group', { name: 'Filter requests' }).getByRole('button');
      for (const button of await filters.all()) await touchTarget(button);
      const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
      for (const button of await nav.getByRole('button').all()) await touchTarget(button);
      expect(await page.getByLabel('Search requests').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
      await page.getByRole('button', { name: /Claude Code github.com/ }).click();
      expect((await page.locator('.topbar').boundingBox())!.y).toBe(0);
      expect(await page.locator('.reason-box p').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
      const decline = page.getByRole('button', { name: 'Decline', exact: true });
      const approve = page.getByRole('button', { name: 'Approve & open' });
      await touchTarget(decline);
      await touchTarget(approve);
      for (const close of ['Cancel', 'Escape']) {
        await decline.click();
        const confirmation = page.getByRole('alertdialog', { name: 'Decline this request' });
        await confirmation.waitFor();
        await page.keyboard.press('Tab');
        expect(await confirmation.evaluate(element => element.contains(document.activeElement))).toBe(true);
        if (close === 'Cancel') await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
        else await page.keyboard.press('Escape');
        await expect.poll(() => confirmation.count()).toBe(0);
        expect(await decline.evaluate(element => element === document.activeElement)).toBe(true);
        await page.keyboard.press('Tab');
        expect(await approve.evaluate(element => element === document.activeElement)).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (process.env.KEEP_SAFE_QA_SCREENSHOTS) {
        await mkdir('.keep-safe/qa', { recursive: true });
        await page.screenshot({ path: `.keep-safe/qa/readable-phone-${width}.png` });
      }
    } finally { await context.close(); await bridge.close(); }
  });

  it('keeps named live controls tappable and lets a phone inspect an entire long origin', async () => {
    const host = `${'a'.repeat(55)}.${'b'.repeat(50)}.example`;
    const url = `https://${host}:8443/login?code=private-fixture-value`;
    let frameUrl = url;
    const bridge = await createBridge({
      ownerToken: 'origin-owner', agentToken: 'origin-agent', port: 0, staticDir: resolve('apps/web/dist'),
      browserFactory: async () => ({
        frame: async () => ({ data: image, width: 390, height: 720, url: frameUrl }),
        input: async () => {}, close: async () => {},
      }),
    });
    const context = await browser.newContext({ viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const client = new BridgeClient({ url: bridge.url, token: 'origin-agent' });
    try {
      await client.create({ agent: 'Accessibility test', title: 'Inspect the website origin', url });
      await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: 'origin-owner' })}`);
      await page.getByRole('button', { name: /Accessibility test/ }).click();
      await page.getByRole('button', { name: 'Approve & open' }).click();
      await page.locator('.remote-screen img').waitFor();
      const notice = page.locator('.toast-inline');
      expect(await notice.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect((await notice.boundingBox())!.width).toBeLessThanOrEqual(320);
      await touchTarget(notice.getByRole('button', { name: 'Dismiss notification' }));
      for (const name of ['Type text', 'Press Tab in browser', 'Press Enter in browser', 'Press Backspace in browser', 'Scroll browser up', 'Scroll browser down']) {
        await touchTarget(page.getByRole('button', { name, exact: true }));
      }
      const origin = page.getByRole('button', { name: `Website origin: https://${host}:8443`, exact: true });
      await touchTarget(origin);
      await origin.click();
      expect(await origin.getAttribute('aria-expanded')).toBe('true');
      expect(await textContrast(origin)).toBeGreaterThanOrEqual(4.5);
      const expanded = page.locator('#full-browser-origin');
      expect(await expanded.innerText()).toContain(`https://${host}:8443`);
      expect(await expanded.innerText()).not.toContain('private-fixture-value');
      expect((await expanded.boundingBox())!.width).toBeLessThanOrEqual(320);
      frameUrl = `http://${host}:8443/redirect`;
      const warning = page.locator('.redirect-note');
      await expect.poll(() => warning.innerText()).toContain(`http://${host}:8443`);
      expect(await textContrast(warning)).toBeGreaterThanOrEqual(4.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    } finally { await context.close(); await bridge.close(); }
  });

  it('keeps the complete forget-phone confirmation inside its buttons at 320px', async () => {
    const bridge = await createBridge({ ownerToken: 'forget-owner', agentToken: 'forget-agent', port: 0, staticDir: resolve('apps/web/dist') });
    const context = await browser.newContext({ viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
      await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: 'forget-owner' })}`);
      await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByRole('button', { name: 'Remember this phone', exact: true }).click();
      await page.getByLabel('Name this phone', { exact: true }).fill('Narrow phone');
      await page.getByRole('button', { name: 'Remember for 7 days', exact: true }).click();
      await page.getByRole('button', { name: 'Forget this phone', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Forget this phone?' });
      for (const button of await dialog.getByRole('button').all()) await touchTarget(button);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await dialog.getByRole('button', { name: 'Forget this phone', exact: true }).click();
      await expect.poll(() => page.evaluate(() => localStorage.getItem('keep-safe.device.v1'))).toBeNull();
    } finally { await context.close(); await bridge.close(); }
  });
});
