import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';
import { startGestureFixture } from './fixtures/gesture-site';

const ownerToken = 'synthetic-raise-owner'; const agentToken = 'synthetic-raise-agent';
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
type RaiseWindow = Window & { raise: { shows: number; focusedDuringTap: number } };

/** Where a point of the remote page is on this screen right now. */
async function onScreen(page: Page, x: number, y: number) {
  return page.locator('.remote-screen img').evaluate((element, point) => {
    const image = element as HTMLImageElement; const box = image.getBoundingClientRect();
    return { x: box.left + point.x * box.width / Number(image.getAttribute('width')), y: box.top + point.y * box.height / Number(image.getAttribute('height')) };
  }, { x, y });
}

// Phones open their keyboard only for a page the owner is touching, and the
// bridge says whether a tap landed in a text field only after the tap. Chrome
// on Android has navigator.virtualKeyboard: the app focuses its typing box
// during the tap with the keyboard held down, then opens it on the answer.
describe('raising the phone keyboard from a tap on the live page', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  async function open(context: BrowserContext) {
    const site = await startGestureFixture();
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, allowLocalUrls: true, staticDir: resolve('apps/web/dist') });
    const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const page = await context.newPage(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await client.create({ agent: 'Raise fixture', title: 'Synthetic keyboard raise', url: site.url, ttlSeconds: 120 });
    await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: ownerToken })}`);
    await page.getByRole('button', { name: /Raise fixture/ }).click(); await page.getByRole('button', { name: 'Approve & open', exact: true }).click();
    await page.locator('.remote-screen img').waitFor(); await expect.poll(() => site.count('ready')).toBe(1);
    await expect.poll(() => page.locator('.remote-screen img').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const tapAt = async (x: number, y: number) => { const point = await onScreen(page, x, y); await page.touchscreen.tap(point.x, point.y); };
    return { page, errors, tapAt, close: async () => { await context.close(); await bridge.close(); await site.close(); } };
  }
  const typingBox = (page: Page) => page.locator('.live-keyboard-input');
  const focused = (page: Page) => typingBox(page).evaluate(element => element === document.activeElement);

  it('focuses during the tap with the keyboard held down, opens it for a text field and lets go otherwise', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await context.addInitScript(() => {
      const raise = { shows: 0, focusedDuringTap: 0 };
      (window as unknown as RaiseWindow).raise = raise;
      Object.defineProperty(navigator, 'virtualKeyboard', { configurable: true, value: { overlaysContent: false, show() { raise.shows++; }, hide() {} } });
      // A focus that arrives within the touch's own events is inside the gesture.
      let touching = false;
      addEventListener('pointerdown', () => { touching = true; }, true);
      addEventListener('pointerup', () => { setTimeout(() => { touching = false; }); }, true);
      addEventListener('focusin', event => { if (touching && (event.target as Element).classList?.contains('live-keyboard-input')) raise.focusedDuringTap++; }, true);
    });
    const { page, errors, tapAt, close } = await open(context);
    const button = page.locator('.live-keyboard button');
    try {
      // A tap on plain content: focus is taken in the tap, the keyboard never
      // opens, and focus is let go once the bridge says it was not a field.
      await tapAt(100, 228);
      await expect.poll(() => page.evaluate(() => (window as unknown as RaiseWindow).raise.focusedDuringTap), { timeout: 5000 }).toBe(1);
      await expect.poll(() => focused(page), { timeout: 5000 }).toBe(false);
      expect(await page.evaluate(() => (window as unknown as RaiseWindow).raise.shows)).toBe(0);
      expect(await button.getAttribute('aria-pressed')).toBe('false');
      expect(await typingBox(page).getAttribute('virtualkeyboardpolicy')).toBeNull();

      // A tap on the email field: the same in-tap focus, then the keyboard opens for an email address.
      await tapAt(100, 48);
      await expect.poll(() => page.evaluate(() => (window as unknown as RaiseWindow).raise.shows), { timeout: 5000 }).toBe(1);
      expect(await page.evaluate(() => (window as unknown as RaiseWindow).raise.focusedDuringTap)).toBe(2);
      expect(await focused(page)).toBe(true);
      expect(await button.getAttribute('aria-pressed')).toBe('true');
      expect(await typingBox(page).getAttribute('inputmode')).toBe('email');

      // With the keyboard open, a tap elsewhere in the page keeps it open, as before.
      await tapAt(100, 228);
      await pause(800);
      expect(await focused(page)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as RaiseWindow).raise.shows)).toBe(1);
      expect(errors).toEqual([]);
    } finally { await close(); }
  }, 60_000);

  it('keeps focusing on the answer where the browser cannot open the keyboard on request', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await context.addInitScript(() => { Object.defineProperty(navigator, 'virtualKeyboard', { configurable: true, value: undefined }); });
    const { page, errors, tapAt, close } = await open(context);
    try {
      await tapAt(100, 228);
      await pause(800);
      expect(await focused(page)).toBe(false);
      await tapAt(100, 48);
      await expect.poll(() => focused(page), { timeout: 5000 }).toBe(true);
      expect(await typingBox(page).getAttribute('virtualkeyboardpolicy')).toBeNull();
      expect(errors).toEqual([]);
    } finally { await close(); }
  }, 60_000);
});
