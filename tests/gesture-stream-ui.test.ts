import { resolve } from 'node:path';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';
import { gestureFixtureValues, startGestureFixture } from './fixtures/gesture-site';
import { openMoreTools } from './helpers/live-browser';

const ownerToken = 'synthetic-gesture-owner'; const agentToken = 'synthetic-gesture-agent';
type Point = { x: number; y: number; id?: number };
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
/** `timestamp` (seconds) gives the simulated finger exact timing, as a real
 * hand has, however busy the test computer is. */
async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: Point[] = [], timestamp?: number) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((point, index) => ({ x: point.x, y: point.y, id: point.id ?? index, radiusX: 1, radiusY: 1, force: 1 })), ...(timestamp !== undefined ? { timestamp } : {}) });
}
/** Where a point of the remote page is on this screen right now, through any zoom. */
async function onScreen(page: Page, x: number, y: number) {
  return page.locator('.remote-screen img').evaluate((element, point) => {
    const image = element as HTMLImageElement; const box = image.getBoundingClientRect();
    return { x: box.left + point.x * box.width / Number(image.getAttribute('width')), y: box.top + point.y * box.height / Number(image.getAttribute('height')) };
  }, { x, y });
}

describe('touching the live page as the website itself', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  async function open(context: Awaited<ReturnType<Browser['newContext']>>) {
    const site = await startGestureFixture();
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, allowLocalUrls: true, staticDir: resolve('apps/web/dist') });
    const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const page = await context.newPage(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const sent: Array<{ type: string; phase?: string; tap?: boolean }> = []; let binaryFrames = 0; let jsonFrames = 0;
    page.on('websocket', socket => {
      socket.on('framesent', frame => { const message = JSON.parse(String(frame.payload)); if (['touch', 'mouse', 'click', 'scroll'].includes(message.type)) sent.push(message); });
      socket.on('framereceived', frame => { if (typeof frame.payload !== 'string') binaryFrames++; else if (JSON.parse(frame.payload).type === 'frame') jsonFrames++; });
    });
    const request = await client.create({ agent: 'Gesture fixture', title: 'Synthetic gesture practice', url: site.url, ttlSeconds: 120 });
    await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: ownerToken })}`);
    await page.getByRole('button', { name: /Gesture fixture/ }).click(); await page.getByRole('button', { name: 'Approve & open', exact: true }).click();
    await page.locator('.remote-screen img').waitFor(); await expect.poll(() => site.count('ready')).toBe(1);
    await expect.poll(() => page.locator('.remote-screen img').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const handBack = async () => {
      await page.getByRole('button', { name: /Done, hand back/ }).click();
      await expect.poll(async () => (await client.get(request.id)).status).toBe('completed');
      const agent = await chromium.connectOverCDP((await client.get(request.id)).browser!.cdpUrl);
      return { agent, remote: agent.contexts().flatMap(item => item.pages()).find(item => item.url() === site.url)! };
    };
    return { site, bridge, page, errors, sent, handBack, get binaryFrames() { return binaryFrames; }, get jsonFrames() { return jsonFrames; }, close: async () => { await context.close(); await bridge.close(); await site.close(); } };
  }

  it.each([320, 390])('drags a puzzle, zooms with two fingers, scrolls with momentum and taps at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const test = await open(context); const { page, site } = test; const cdp = await context.newCDPSession(page);
    try {
      const image = page.locator('.remote-screen img');
      expect(await image.evaluate(element => getComputedStyle(element).touchAction)).toBe('none');
      expect(await image.getAttribute('alt')).toContain('Pinch with two fingers to zoom');
      // The picture arrives as a pushed binary stream, at this phone's pixel density.
      expect(test.jsonFrames).toBe(0); expect(test.binaryFrames).toBeGreaterThan(0);
      expect(await image.evaluate(element => (element as HTMLImageElement).naturalWidth / Number(element.getAttribute('width')))).toBe(2);

      // A drag puzzle: press the knob, drag it to the end at a human pace, let go.
      const knob = await onScreen(page, 48, 138); const end = await onScreen(page, 300, 138);
      await touch(cdp, 'touchStart', [knob]);
      for (let step = 1; step <= 24; step++) { await touch(cdp, 'touchMove', [{ x: knob.x + (end.x - knob.x) * (1 - (1 - step / 24) ** 3), y: knob.y }]); await pause(16); }
      await touch(cdp, 'touchEnd');
      await expect.poll(() => site.count('puzzle-solved'), { timeout: 5000 }).toBe(1);
      expect(test.sent.filter(message => message.type !== 'touch')).toEqual([]);
      expect(test.sent[0].phase).toBe('start'); expect(test.sent.at(-1)).toMatchObject({ phase: 'end' }); expect(test.sent.at(-1)!.tap).toBeUndefined();
      expect(test.sent.filter(message => message.phase === 'move').length).toBeGreaterThan(3);

      // Two fingers zoom this view. The website sees no touch from them.
      const count = test.sent.length;
      const middle = await onScreen(page, 270, 410);
      await touch(cdp, 'touchStart', [{ x: middle.x - 15, y: middle.y, id: 0 }]);
      await touch(cdp, 'touchStart', [{ x: middle.x - 15, y: middle.y, id: 0 }, { x: middle.x + 15, y: middle.y, id: 1 }]);
      for (let step = 1; step <= 10; step++) { await touch(cdp, 'touchMove', [{ x: middle.x - 15 - step * 3, y: middle.y, id: 0 }, { x: middle.x + 15 + step * 3, y: middle.y, id: 1 }]); await pause(16); }
      await touch(cdp, 'touchEnd');
      const zoom = await image.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
      expect(zoom).toBeCloseTo(3, 1);
      // The first finger touched the page for an instant and was taken back.
      expect(test.sent.slice(count).map(message => message.phase)).toEqual(['start', 'cancel']);
      // The point between the fingers stayed where it was while the picture grew.
      const after = await onScreen(page, 270, 410);
      expect(Math.abs(after.x - middle.x)).toBeLessThan(3); expect(Math.abs(after.y - middle.y)).toBeLessThan(3);
      // The zoomed picture still fills the space the page had, and a tap lands on what is shown.
      const stage = (await page.locator('.remote-screen').boundingBox())!; const shown = (await image.boundingBox())!;
      expect(shown.x).toBeLessThanOrEqual(stage.x + 1); expect(shown.x + shown.width).toBeGreaterThanOrEqual(stage.x + stage.width - 1);
      const corner = await onScreen(page, 275, 410);
      await touch(cdp, 'touchStart', [corner]); await touch(cdp, 'touchEnd');
      await expect.poll(() => site.count('corner-tapped'), { timeout: 5000 }).toBe(1);
      expect(test.sent.at(-1)).toMatchObject({ type: 'touch', phase: 'end', tap: true });
      const reset = page.getByRole('button', { name: 'Reset zoom', exact: true });
      const resetBox = (await reset.boundingBox())!; expect(resetBox.height).toBeGreaterThanOrEqual(44);
      await reset.click();
      expect(await image.evaluate(element => getComputedStyle(element).transform)).toBe('none');
      expect(await reset.count()).toBe(0);

      // A tap in a text field brings up the phone keyboard target.
      const field = await onScreen(page, 100, 48);
      await touch(cdp, 'touchStart', [field]); await touch(cdp, 'touchEnd');
      await expect.poll(() => site.count('field-focused')).toBe(1);
      const capture = page.getByLabel('Type into the remote page', { exact: true });
      await expect.poll(() => capture.evaluate(element => document.activeElement === element)).toBe(true);
      expect(await capture.getAttribute('inputmode')).toBe('email');

      // A flick scrolls the website and momentum carries it past where the finger stopped.
      const from = await onScreen(page, 195, 470); const to = await onScreen(page, 195, 110);
      const began = Date.now() / 1000;
      await touch(cdp, 'touchStart', [from], began);
      for (let step = 1; step <= 8; step++) { await touch(cdp, 'touchMove', [{ x: from.x, y: from.y + (to.y - from.y) * step / 8 }], began + step * 0.016); await pause(16); }
      await touch(cdp, 'touchEnd', [], began + 9 * 0.016);
      await expect.poll(() => site.count('scrolled-far'), { timeout: 5000 }).toBe(1);
      expect(test.sent.filter(message => message.type !== 'touch')).toEqual([]);

      const { agent, remote } = await test.handBack();
      try {
        expect(await remote.evaluate(() => (window as unknown as { gesture: { events: string[]; pointerTypes: string[] } }).gesture)).toEqual({ events: ['down', 'up'], pointerTypes: ['touch'] });
        // The website was never zoomed: the zoom lived on the phone.
        expect(await remote.evaluate(() => window.visualViewport!.scale)).toBe(1);
      } finally { await agent.close(); }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(test.errors).toEqual([]);
    } finally { await cdp.detach().catch(() => {}); await test.close(); }
  }, 60000);

  it.each([320, 390])('switches windows, copies a selection, pastes and takes a password manager fill at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const test = await open(context); const { page, site } = test; const cdp = await context.newCDPSession(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: test.bridge.url });
    const tapAt = async (x: number, y: number) => { const point = await onScreen(page, x, y); await touch(cdp, 'touchStart', [point]); await touch(cdp, 'touchEnd'); };
    const tall = async (name: string) => { const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!; expect(box.height).toBeGreaterThanOrEqual(44); };
    try {
      // One window: no strip.
      expect(await page.locator('.window-tabs').count()).toBe(0);
      // The page opens a second window. The strip appears with it showing.
      await tapAt(120, 410);
      await expect.poll(() => site.count('window-ready'), { timeout: 5000 }).toBe(1);
      const strip = page.getByRole('group', { name: 'Windows this sign-in opened', exact: true });
      await strip.waitFor();
      await page.getByRole('button', { name: 'Synthetic second window, showing now', exact: true }).waitFor();
      await tall('Show Synthetic gesture practice'); await tall('Close Synthetic second window');
      // Back to the first window. Touches land on it again.
      await page.getByRole('button', { name: 'Show Synthetic gesture practice', exact: true }).click();
      await page.getByRole('button', { name: 'Synthetic gesture practice, showing now', exact: true }).waitFor();
      await pause(300);
      await tapAt(275, 410);
      await expect.poll(() => site.count('corner-tapped'), { timeout: 5000 }).toBe(1);
      expect(site.count('window-tapped')).toBe(0);
      await page.getByRole('button', { name: 'Close Synthetic second window', exact: true }).click();
      await expect.poll(() => page.locator('.window-tabs').count(), { timeout: 5000 }).toBe(0);

      // Select, drag a finger across two words, Copy: they are on this device's clipboard.
      await openMoreTools(page);
      const select = page.getByRole('button', { name: 'Select text on the page by dragging', exact: true });
      await tall('Select text on the page by dragging');
      await select.click();
      expect(await page.getByRole('button', { name: 'Stop selecting text', exact: true }).getAttribute('aria-pressed')).toBe('true');
      const from = await onScreen(page, 21, 305); const to = await onScreen(page, 153, 305);
      await touch(cdp, 'touchStart', [from]);
      for (let step = 1; step <= 10; step++) { await touch(cdp, 'touchMove', [{ x: from.x + (to.x - from.x) * step / 10, y: from.y }]); await pause(16); }
      await touch(cdp, 'touchEnd'); await pause(200);
      // The finger went to the page as a mouse, so it selected instead of scrolling.
      const drag = test.sent.slice(-3);
      expect(drag.every(message => message.type === 'mouse')).toBe(true);
      await page.getByRole('button', { name: 'Copy the selected text to this device', exact: true }).click();
      // Shows what the notice said instead, if anything went wrong.
      await expect.poll(() => page.locator('.tool-notice').innerText(), { timeout: 10000 }).toBe('Copied 11 characters to this device.');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('alpha bravo');
      // Copying turns Select off again.
      await page.getByRole('button', { name: 'Select text on the page by dragging', exact: true }).waitFor();

      // Paste: the clipboard's text goes to the field the owner tapped, replacing what was selected there.
      await page.evaluate(text => navigator.clipboard.writeText(text), gestureFixtureValues.pasted);
      await tapAt(100, 48);
      await expect.poll(() => site.count('field-focused')).toBe(1);
      await page.getByRole('button', { name: "Paste this device's clipboard into the page", exact: true }).click();
      await expect.poll(() => site.count('paste-arrived'), { timeout: 5000 }).toBe(1);
      await expect.poll(() => page.locator('.tool-notice').innerText(), { timeout: 10000 }).toBe('Pasted into the page.');

      // Passwords: visible in the toolbar without horizontal scrolling, suggested on an email/password field,
      // and focuses the matching box straight away without LiveKeyboard stealing focus back.
      const passwordsButton = page.getByRole('button', { name: 'Passwords', exact: true });
      const passwordsBox = (await passwordsButton.boundingBox())!;
      expect(passwordsBox.height).toBeGreaterThanOrEqual(44);
      expect(passwordsBox.x).toBeGreaterThanOrEqual(0);
      expect(passwordsBox.x + passwordsBox.width).toBeLessThanOrEqual(width + 1);
      expect(await passwordsButton.evaluate(element => element.classList.contains('is-suggested'))).toBe(true);
      await passwordsButton.click();
      const user = page.getByLabel('Username or email', { exact: true }); const secret = page.getByLabel('Password', { exact: true });
      // Opening Passwords after tapping the email field focuses Username synchronously for the phone password manager.
      expect(await user.evaluate(element => document.activeElement === element)).toBe(true);
      expect(await user.getAttribute('autocomplete')).toBe('username');
      expect(await secret.getAttribute('autocomplete')).toBe('current-password');
      expect(await secret.getAttribute('type')).toBe('password');
      expect(await user.evaluate(element => element.closest('form')?.getAttribute('autocomplete'))).toBe('on');
      expect(await user.evaluate(element => element.closest('form')?.getAttribute('method'))).toBe('post');
      expect(await page.getByRole('button', { name: 'Send password', exact: true }).getAttribute('type')).toBe('submit');
      expect(await page.locator('.credential-site-hint').innerText()).toContain('127.0.0.1');
      await user.fill(gestureFixtureValues.user); await secret.fill(gestureFixtureValues.secret);
      expect(await page.getByRole('button', { name: 'Send username', exact: true }).evaluate(element => element.classList.contains('button-accent'))).toBe(true);
      expect(await page.getByRole('button', { name: 'Send password', exact: true }).evaluate(element => element.classList.contains('button-accent'))).toBe(true);
      // The username replaces the pasted text in the page field.
      await page.getByRole('button', { name: 'More keys', exact: true }).click();
      await page.getByRole('button', { name: 'Select all in browser', exact: true }).click();
      await page.getByRole('button', { name: 'More keys', exact: true }).click();
      await page.getByRole('button', { name: 'Send username', exact: true }).click();
      await expect.poll(() => site.count('user-arrived'), { timeout: 5000 }).toBe(1);
      expect(await user.inputValue()).toBe('');
      await expect.poll(() => page.locator('.tool-notice').innerText(), { timeout: 5000 }).toContain('Tap the password field');
      // Tapping the remote password field while Passwords is open must not let LiveKeyboard steal focus or hide the form.
      await tapAt(100, 494);
      await expect.poll(() => page.locator('#credential-form p').innerText(), { timeout: 5000 }).toContain('Password field focused');
      expect(await page.locator('.live-keyboard-input').evaluate(element => document.activeElement === element)).toBe(false);
      expect(await secret.isVisible()).toBe(true);
      expect(await secret.inputValue()).toBe(gestureFixtureValues.secret);
      await page.getByRole('button', { name: 'Send password', exact: true }).click();
      await expect.poll(() => site.count('secret-arrived'), { timeout: 5000 }).toBe(1);
      expect(await secret.inputValue()).toBe('');
      // Closing and reopening Passwords while the password field is focused focuses the Password box straight away.
      await user.fill(gestureFixtureValues.user);
      const closePasswords = page.getByRole('button', { name: 'Close password manager boxes', exact: true });
      expect((await closePasswords.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await closePasswords.click();
      expect(await page.locator('#credential-form').count()).toBe(0);
      await passwordsButton.click();
      expect(await user.inputValue()).toBe('');
      expect(await secret.evaluate(element => document.activeElement === element)).toBe(true);
      // Nothing filled or pasted is left in the phone app's own page.
      expect(await page.locator('body').innerText()).not.toContain(gestureFixtureValues.secret);
      expect(await page.locator('body').innerText()).not.toContain(gestureFixtureValues.user);

      // Leaving the app clears a filled box that was never sent.
      await user.fill(gestureFixtureValues.user);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      await expect.poll(() => page.locator('#credential-username').count()).toBe(0);
      // Coming back to the app, as from the app switcher.
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      await page.getByRole('button', { name: 'Resume browser', exact: true }).click();
      await page.locator('.remote-screen img').waitFor();
      await page.getByRole('button', { name: 'Passwords', exact: true }).click();
      expect(await page.getByLabel('Username or email', { exact: true }).inputValue()).toBe('');

      const { agent, remote } = await test.handBack();
      try {
        // Handback cleared the password field. The username stayed, as it would.
        expect(await remote.locator('#secret').inputValue()).toBe('');
        expect(await remote.locator('#field').inputValue()).toBe(gestureFixtureValues.user);
      } finally { await agent.close(); }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(test.errors).toEqual([]);
    } finally { await cdp.detach().catch(() => {}); await test.close(); }
  }, 60000);

  it('hovers, drags and scrolls with a mouse on a computer', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const test = await open(context); const { page, site } = test;
    try {
      const image = page.locator('.remote-screen img');
      expect(await image.evaluate(element => element.classList.contains('takes-gestures'))).toBe(true);
      const hover = await onScreen(page, 100, 228);
      await page.mouse.move(hover.x, hover.y);
      await expect.poll(() => site.count('hovered'), { timeout: 5000 }).toBe(1);
      const knob = await onScreen(page, 48, 138); const end = await onScreen(page, 310, 138);
      await page.mouse.move(knob.x, knob.y); await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 12 }); await page.mouse.up();
      await expect.poll(() => site.count('puzzle-solved'), { timeout: 5000 }).toBe(1);
      expect(test.sent.filter(message => message.type !== 'mouse')).toEqual([]);
      expect(test.sent.filter(message => message.phase === 'down').length).toBe(1);
      expect(test.sent.at(-1)).toMatchObject({ type: 'mouse', phase: 'up' });
      // A click in the field moves typing there without touching the Keyboard button.
      const field = await onScreen(page, 100, 48);
      await page.mouse.click(field.x, field.y);
      await expect.poll(() => site.count('field-focused')).toBe(1);
      await expect.poll(() => page.getByLabel('Type into the remote page', { exact: true }).evaluate(element => document.activeElement === element)).toBe(true);
      await page.mouse.wheel(0, 700);
      await expect.poll(() => site.count('scrolled-far'), { timeout: 5000 }).toBe(1);
      const { agent, remote } = await test.handBack();
      try { expect(await remote.evaluate(() => (window as unknown as { gesture: { pointerTypes: string[] } }).gesture.pointerTypes)).toEqual(['mouse']); } finally { await agent.close(); }
      expect(test.errors).toEqual([]);
    } finally { await test.close(); }
  }, 60000);
});
