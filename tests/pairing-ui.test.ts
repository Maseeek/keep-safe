import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';
import { startLoginFixture } from './fixtures/login-site';

const ownerToken = 'pairing-ui-owner-secret';
const agentToken = 'pairing-ui-agent-secret';
const deviceKey = 'keep-safe.device.v1';
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function start(options: Parameters<typeof createBridge>[0] | object = {}) {
  const bridge = await createBridge({ ownerToken, agentToken, port: 0, staticDir: resolve('apps/web/dist'), computerName: 'test-desk', ...options });
  const invite = async () => {
    const response = await fetch(`${bridge.url}/api/pairing`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(201);
    return (await response.json() as { code: string }).code;
  };
  return { bridge, invite };
}
const stored = (page: Page) => page.evaluate(key => ({ local: localStorage.getItem(key), session: JSON.stringify({ ...sessionStorage }) }), deviceKey);

describe('pairing and onboarding', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it('pairs a phone straight from a scanned link, without ever holding the owner key', async () => {
    const { bridge, invite } = await start();
    const context = await browser.newContext(phone);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      const code = await invite();
      await page.goto(`${bridge.url}/#pair=${code}`);
      await page.getByRole('heading', { name: 'Paired with test-desk', exact: true }).waitFor();
      // The code leaves the address bar before it is used.
      expect(new URL(page.url()).hash).toBe('');
      const saved = await stored(page);
      expect(saved.local).not.toBeNull();
      expect(JSON.stringify(saved)).not.toContain(ownerToken);
      expect(JSON.stringify(saved)).not.toContain(code);
      const device = JSON.parse(saved.local!) as { token: string; device: { name: string } };
      expect(device.token).toMatch(/^[a-f0-9]{64}$/);
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.getByText('Bridge connected', { exact: true }).waitFor();

      // A fresh window on the same phone reconnects with the phone's own key.
      const again = await context.newPage();
      await again.goto(bridge.url);
      await again.getByText('Bridge connected', { exact: true }).waitFor();
      // The link is single use.
      const other = await browser.newContext(phone);
      try {
        const second = await other.newPage();
        await second.goto(`${bridge.url}/#pair=${code}`);
        await second.getByRole('heading', { name: 'That code did not work', exact: true }).waitFor();
        expect((await stored(second)).local).toBeNull();
      } finally { await other.close(); }
      expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); }
  });

  it.each([320, 390])('walks a new phone from the welcome screen to a typed code at %ipx', async width => {
    const { bridge, invite } = await start();
    const context = await browser.newContext({ ...phone, viewport: { width, height: 844 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const fits = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    try {
      await page.goto(bridge.url);
      await page.getByRole('heading', { name: 'Sign in for your agents, from your phone.', exact: true }).waitFor();
      await fits();
      await page.getByRole('button', { name: /Get started/ }).click();
      // The computer step carries the one prompt an agent needs.
      const prompt = page.locator('.prompt-card pre');
      expect(await prompt.innerText()).toContain('npx -y github:Maseeek/keep-safe setup');
      expect(await prompt.innerText()).toContain('Never ask me for passwords in chat.');
      await fits();
      await page.getByRole('button', { name: /I can see the QR code/ }).click();
      const scan = page.getByRole('button', { name: /Scan QR code/ });
      const box = (await scan.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      await fits();

      const field = page.getByLabel('Pairing code or link', { exact: true });
      expect(await field.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
      await field.fill('ZZZZ-9999');
      await page.getByRole('button', { name: 'Pair this phone', exact: true }).click();
      await expect.poll(() => page.getByRole('alert').innerText()).toContain('not valid any more');
      expect((await stored(page)).local).toBeNull();

      const code = await invite();
      await field.fill(`${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()}`);
      await page.getByRole('button', { name: 'Pair this phone', exact: true }).click();
      await page.getByRole('heading', { name: 'Paired with test-desk', exact: true }).waitFor();
      await fits();
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.getByText('Bridge connected', { exact: true }).waitFor();
      // The paired computer is named on the Connect tab.
      await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByRole('heading', { name: 'test-desk', exact: true }).waitFor();
      await fits();
      expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); }
  });

  it('offers the setup prompt and the demo to a visitor on a computer', async () => {
    const { bridge } = await start();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto(bridge.url);
      await page.getByRole('heading', { level: 1 }).filter({ hasText: 'Your agent hit a login page.' }).waitFor();
      expect(await page.locator('.prompt-card pre').innerText()).toContain('npx -y github:Maseeek/keep-safe setup');
      await page.getByRole('img', { name: 'QR code that opens Keep Safe on your phone' }).waitFor();
      await page.getByRole('button', { name: 'Try the demo', exact: true }).click();
      await page.getByText('Demo mode', { exact: true }).waitFor();
      expect(await page.locator('.demo-banner').innerText()).toContain('Nothing is real.');
      await page.locator('.demo-banner').getByRole('button', { name: /Set up/ }).click();
      await page.getByRole('heading', { level: 1 }).filter({ hasText: 'Your agent hit a login page.' }).waitFor();
    } finally { await context.close(); await bridge.close(); }
  });

  it('shows the pairing QR code on the computer and confirms when the phone has used it', async () => {
    const { bridge, invite } = await start();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    try {
      const code = await invite();
      // The short address a person clicks in a chat: the page asks the bridge for the link.
      await page.goto(`${bridge.url}/#qr=${code}`);
      await page.getByRole('heading', { name: 'Scan with your phone', exact: true }).waitFor();
      await page.getByRole('img', { name: 'Pairing QR code', exact: true }).waitFor();
      // Nothing to type by default: the code and link sit behind one disclosure.
      expect(await page.locator('.desk-code strong').isVisible()).toBe(false);
      await page.getByText('Cannot scan?', { exact: true }).click();
      expect(await page.locator('.desk-code strong').innerText()).toBe(`${code.slice(0, 4)}-${code.slice(4)}`);
      await page.getByRole('button', { name: 'Copy pairing link', exact: true }).waitFor();
      // The page holds no key: it only watches the code it was given.
      expect(await page.content()).not.toContain(ownerToken);
      const claim = await fetch(`${bridge.url}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'Pocket phone' }) });
      expect(claim.status).toBe(201);
      await page.getByRole('heading', { name: 'Pocket phone is paired', exact: true }).waitFor();
      expect(await page.getByRole('img', { name: 'Pairing QR code', exact: true }).count()).toBe(0);

      // The longer form that carries the whole link still works.
      const next = await invite();
      await page.goto(`${bridge.url}/#${new URLSearchParams({ desk: `${bridge.url}/#pair=${next}` })}`);
      await page.reload();
      await page.getByRole('img', { name: 'Pairing QR code', exact: true }).waitFor();
      // A link that is not a pairing link is ignored rather than drawn as a QR code.
      await page.goto(`${bridge.url}/#${new URLSearchParams({ desk: 'https://example.com/phish' })}`);
      await page.reload();
      await page.getByRole('heading', { level: 1 }).filter({ hasText: 'Your agent hit a login page.' }).waitFor();
    } finally { await context.close(); await bridge.close(); }
  });

  it('keeps the same phone when it scans again, and follows the computer to a new address', async () => {
    const { bridge, invite } = await start();
    const context = await browser.newContext(phone);
    const page = await context.newPage();
    const devices = async () => (await (await fetch(`${bridge.url}/api/devices`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json() as { devices: { id: string }[] }).devices;
    try {
      await page.goto(`${bridge.url}/#pair=${await invite()}`);
      await page.getByRole('heading', { name: 'Paired with test-desk', exact: true }).waitFor();
      const first = JSON.parse((await stored(page)).local!) as { token: string; url: string; source: string; device: { id: string } };
      expect(first.source).toBe(bridge.info.vapidPublicKey ?? first.source);

      // Scanning a second code on a paired phone re-links it: same key, same entry.
      await page.goto(`${bridge.url}/#pair=${await invite()}`);
      await page.reload();
      await page.getByRole('heading', { name: 'Paired with test-desk', exact: true }).waitFor();
      const second = JSON.parse((await stored(page)).local!) as { token: string; device: { id: string } };
      expect(second.token).toBe(first.token);
      expect(second.device.id).toBe(first.device.id);
      expect(await devices()).toHaveLength(1);

      // The computer's address changed while the phone was away. A notification
      // left the new one behind, so the phone finds its way without pairing again.
      const source = 'B' + 'A'.repeat(86);
      const moved = `http://localhost:${new URL(bridge.url).port}`;
      await page.evaluate(async ({ key, record, source }) => {
        const saved = JSON.parse(localStorage.getItem(key)!);
        localStorage.setItem(key, JSON.stringify({ ...saved, url: 'http://127.0.0.1:9', source }));
        sessionStorage.clear();
        await (await caches.open('keep-safe-link-v1')).put('/__keep-safe/link', new Response(JSON.stringify(record)));
      }, { key: deviceKey, source, record: { sourceKey: source, url: moved, at: Date.now() } });
      await page.goto(bridge.url);
      await page.reload();
      await page.getByText('Bridge connected', { exact: true }).waitFor({ timeout: 20_000 });
      const followed = JSON.parse((await stored(page)).local!) as { token: string; url: string };
      expect(followed.url).toBe(moved);
      expect(followed.token).toBe(first.token);
      expect(await devices()).toHaveLength(1);

      // An address from some other computer's notification is ignored.
      await page.evaluate(async ({ key }) => {
        const saved = JSON.parse(localStorage.getItem(key)!);
        localStorage.setItem(key, JSON.stringify({ ...saved, url: 'http://127.0.0.1:9' }));
        sessionStorage.clear();
        await (await caches.open('keep-safe-link-v1')).put('/__keep-safe/link', new Response(JSON.stringify({ sourceKey: 'C' + 'A'.repeat(86), url: 'http://localhost:1', at: Date.now() })));
      }, { key: deviceKey });
      await page.reload();
      await page.getByText('Looking for your computer…', { exact: true }).waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: /Scan new code/ }).waitFor();
      expect((JSON.parse((await stored(page)).local!) as { url: string }).url).toBe('http://127.0.0.1:9');
    } finally { await context.close(); await bridge.close(); }
  });

  it('opens a pairing link for an app the computer serves itself instead of rejecting it', async () => {
    const { bridge } = await start();
    const context = await browser.newContext(phone);
    const page = await context.newPage();
    try {
      await page.route('http://100.100.100.100:4318/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>App on the computer</h1>' }));
      await page.goto(bridge.url);
      await page.getByRole('button', { name: /Get started/ }).click();
      await page.getByRole('button', { name: /I can see the QR code/ }).click();
      await page.getByLabel('Pairing code or link', { exact: true }).fill('http://100.100.100.100:4318/#pair=ABCD2345');
      await page.getByRole('button', { name: 'Pair this phone', exact: true }).click();
      await page.getByRole('heading', { name: 'App on the computer', exact: true }).waitFor();
      // Anything else is refused with a plain message, and nothing is opened.
      await page.goto(bridge.url);
      await page.getByRole('button', { name: /Get started/ }).click();
      await page.getByRole('button', { name: /I can see the QR code/ }).click();
      await page.getByLabel('Pairing code or link', { exact: true }).fill('https://example.com/#token=abc');
      await page.getByRole('button', { name: 'Pair this phone', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'That is not a Keep Safe pairing code.' }).waitFor();
      expect(new URL(page.url()).origin).toBe(bridge.url);
    } finally { await context.close(); await bridge.close(); }
  });

  it('fits the website to the phone and types into it live with the phone keyboard', async () => {
    const fixture = await startLoginFixture();
    const { bridge, invite } = await start({ allowLocalUrls: true });
    const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const context = await browser.newContext(phone);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const sent: string[] = [];
    page.on('websocket', socket => socket.on('framesent', frame => { const text = String(frame.payload); if (/"type":"(text|key|click|watch|resize)"/.test(text)) sent.push(text); }));
    try {
      const request = await client.create({ agent: 'Live typing fixture', title: 'Sign in to test workspace', url: fixture.origin + '/login', ttlSeconds: 120 });
      await page.goto(`${bridge.url}/#pair=${await invite()}`);
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.getByRole('button', { name: /Live typing fixture/ }).click();
      await page.getByRole('button', { name: 'Approve & open', exact: true }).click();
      const image = page.locator('.remote-screen img');
      await image.waitFor();
      // The remote page is laid out for this screen: full width, sharp, and using nearly all of the height.
      const measure = () => image.evaluate(element => { const img = element as HTMLImageElement; const box = img.getBoundingClientRect(); return { width: Number(img.getAttribute('width')), height: Number(img.getAttribute('height')), natural: img.naturalWidth, shownWidth: Math.round(box.width), shownHeight: Math.round(box.height) }; });
      await expect.poll(async () => (await measure()).shownWidth).toBe(390);
      const size = await measure();
      expect(size.width).toBe(390);
      expect(size.natural).toBe(780);
      expect(size.height).toBeGreaterThan(520);
      expect(size.shownHeight).toBe(size.height);
      // Sized once, before the browser opened: no second layout of the website.
      expect(sent.filter(text => text.includes('"resize"'))).toEqual([]);
      expect(JSON.parse(sent.find(text => text.includes('"watch"'))!).viewport).toMatchObject({ width: 390, scale: 2, touch: true });
      // The tab bar gives its space to the page during a live session.
      expect(await page.getByRole('navigation', { name: 'Mobile navigation' }).isVisible()).toBe(false);

      // Find the email field on an identical page, then tap the same spot in the live image.
      const twin = await browser.newPage({ viewport: { width: size.width, height: size.height } });
      await twin.goto(fixture.origin + '/login');
      const email = (await twin.locator('#email').boundingBox())!;
      await twin.close();
      const box = (await image.boundingBox())!;
      await page.touchscreen.tap(box.x + email.x + email.width / 2, box.y + email.y + email.height / 2);
      // The tap focused a text field, so the phone's keyboard target takes focus by itself.
      const capture = page.getByLabel('Type into the remote page', { exact: true });
      await expect.poll(() => capture.evaluate(element => document.activeElement === element)).toBe(true);
      expect(await capture.getAttribute('type')).toBe('password');
      expect(await capture.getAttribute('inputmode')).toBe('email');
      await page.keyboard.type('fixture@example.invalid');
      await page.keyboard.press('Tab');
      await page.keyboard.type('synthetic-test-onlyX');
      await page.keyboard.press('Backspace');
      // Nothing typed stays on the phone: only a one-character placeholder remains.
      expect((await capture.inputValue()).length).toBe(1);
      expect(await page.locator('body').innerText()).not.toContain('synthetic-test-only');
      await page.keyboard.press('Enter');
      await expect.poll(() => fixture.loginCount, { timeout: 10000 }).toBe(1);
      const typed = sent.filter(text => text.includes('"type":"text"')).map(text => (JSON.parse(text) as { text: string }).text).join('');
      expect(typed).toBe('fixture@example.invalidsynthetic-test-onlyX');
      expect(sent.filter(text => text.includes('"Backspace"')).length).toBe(1);

      // Full screen is a toggle on the live view.
      const full = page.getByRole('button', { name: 'Full screen', exact: true });
      await full.click();
      await page.getByRole('button', { name: 'Exit full screen', exact: true }).click();
      expect(await full.getAttribute('aria-pressed')).toBe('false');

      await page.getByRole('button', { name: /Done, hand back/ }).click();
      await expect.poll(async () => (await client.get(request.id)).status).toBe('completed');
      const result = await client.get(request.id);
      const agent = await chromium.connectOverCDP(result.browser!.cdpUrl);
      try {
        const account = agent.contexts().flatMap(item => item.pages()).find(item => item.url() === fixture.origin + '/account');
        expect(account).toBeDefined();
        await account!.reload();
        expect(await account!.getByRole('heading').textContent()).toBe('Signed in successfully');
      } finally { await agent.close(); }
      expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); await fixture.close(); }
  }, 60000);
});
