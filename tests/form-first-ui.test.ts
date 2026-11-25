import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';
import { startLoginFixture } from './fixtures/login-site';

const ownerToken = 'form-first-ui-owner';
const agentToken = 'form-first-ui-agent';
const email = 'form-first@example.invalid';
const secret = 'synthetic-form-pass-92';

async function startTwoStepOtpSite() {
  let logins = 0;
  let challengeMode = false;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/login') {
      res.end(`<!doctype html><html><head><title>Sign in</title></head><body>
        <h1>Workspace sign-in</h1>
        <form id="f1" method="post" action="/password">
          <label for="u">Email</label>
          <input id="u" name="email" type="email" autocomplete="username" required>
          <button type="submit">Next</button>
        </form>
        <script>document.getElementById('f1').addEventListener('submit', e => { e.preventDefault(); location.href = '/password'; });</script>
      </body></html>`);
      return;
    }
    if (req.url === '/password') {
      res.end(`<!doctype html><html><head><title>Password</title></head><body>
        <h1>Password</h1>
        <form id="f2" method="post" action="/otp">
          <label for="p">Password</label>
          <input id="p" name="password" type="password" autocomplete="current-password" required>
          <button type="submit">Sign in</button>
        </form>
        <script>document.getElementById('f2').addEventListener('submit', e => { e.preventDefault(); location.href = '${challengeMode ? '/challenge' : '/otp'}'; });</script>
      </body></html>`);
      return;
    }
    if (req.url === '/otp') {
      res.end(`<!doctype html><html><head><title>Verify</title></head><body>
        <h1>Two-factor check</h1>
        <form id="f3" method="post" action="/finish">
          <label for="c">Verification code</label>
          <input id="c" name="otp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
          <button type="submit">Verify</button>
        </form>
        <script>document.getElementById('f3').addEventListener('submit', e => { e.preventDefault(); location.href = '/finish'; });</script>
      </body></html>`);
      return;
    }
    if (req.url === '/challenge') {
      res.end(`<!doctype html><html><head><title>Approve</title></head><body>
        <h1>Check your phone</h1>
        <p>Approve sign-in in your authenticator app.</p>
      </body></html>`);
      return;
    }
    if (req.url === '/finish') {
      logins++;
      res.writeHead(303, { Location: '/account', 'Set-Cookie': 'guided=authenticated; HttpOnly; Path=/' });
      res.end();
      return;
    }
    if (req.url === '/account' && req.headers.cookie?.includes('guided=authenticated')) {
      res.end('<!doctype html><html><head><title>Signed in</title></head><body><h1>All set</h1></body></html>');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    get logins() { return logins; },
    setChallengeMode(next: boolean) { challengeMode = next; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

describe('form-first mobile sign-in with Pixel 7 autofill semantics and 2FA escalation', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each([320, 390])('opens form-first, completes two-step credentials + OTP 2FA, and hands back an authenticated browser at %ipx', async width => {
    const site = await startTwoStepOtpSite();
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, allowLocalUrls: true, staticDir: resolve('apps/web/dist') });
    const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      const req = await client.create({ agent: 'Guided Agent', title: 'Sign in to workspace', url: `${site.origin}/login`, fields: ['Email', 'Password', '2FA code'], ttlSeconds: 120 });
      await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: ownerToken })}`);
      await expect.poll(() => page.getByText('Bridge connected', { exact: true }).count()).toBeGreaterThan(0);

      await page.getByRole('button', { name: /Sign in to workspace/ }).click();
      await page.getByRole('button', { name: 'Approve & open', exact: true }).click();

      // Opens directly into Form-First with standard Android/Pixel 7 autofill form semantics.
      const form = page.locator('form.guided-login-form');
      await form.waitFor({ state: 'visible' });
      expect(await form.getAttribute('method')).toBe('post');
      expect(await form.getAttribute('autocomplete')).toBe('on');
      const userBox = page.locator('#guided-username');
      const passBox = page.locator('#guided-password');
      expect(await userBox.getAttribute('autocomplete')).toBe('username');
      expect(await passBox.getAttribute('autocomplete')).toBe('current-password');
      // Both username and password inputs are visible even on Step 1 so Android Autofill always triggers!
      expect(await userBox.isVisible()).toBe(true);
      expect(await passBox.isVisible()).toBe(true);
      expect(await page.getByRole('button', { name: /Copy site/ }).isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

      // Fill both at once (as a phone password manager does) and tap Sign in.
      await userBox.fill(email);
      await passBox.fill(secret);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();

      // Bridge completes Step 1 -> Step 2 automatically and escalates to the OTP 2FA card.
      const otpBox = page.locator('#guided-otp');
      await otpBox.waitFor({ state: 'visible', timeout: 15_000 });
      expect(await otpBox.getAttribute('autocomplete')).toBe('one-time-code');
      expect(await otpBox.getAttribute('inputmode')).toBe('numeric');
      await otpBox.fill('654321');
      await page.getByRole('button', { name: 'Verify', exact: true }).click();

      // Transitions to signed-in confirmation.
      await page.getByRole('heading', { name: /Looks like you’re signed in/ }).waitFor({ state: 'visible', timeout: 15_000 });
      expect(site.logins).toBe(1);
      expect(await page.locator('body').innerText()).not.toContain(secret);

      // Hand back via the guided card's primary button and verify agent browser continuity.
      await page.locator('.guided-card').getByRole('button', { name: /Done, hand back/ }).click();
      await expect.poll(async () => (await client.get(req.id)).status).toBe('completed');
      const done = await client.get(req.id);
      const agentBrowser = await chromium.connectOverCDP(done.browser!.cdpUrl);
      try {
        const account = agentBrowser.contexts().flatMap(c => c.pages()).find(p => p.url() === `${site.origin}/account`);
        expect(account).toBeDefined();
        await account!.reload();
        expect(await account!.locator('h1').textContent()).toBe('All set');
      } finally {
        await agentBrowser.close();
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await bridge.close();
      await site.close();
    }
  }, 90_000);

  it('escalates push-2FA challenges straight into the live browser with a challenge banner, and supports 1-tap passkey vault sign-in', async () => {
    const site = await startTwoStepOtpSite();
    site.setChallengeMode(true);
    const simpleSite = await startLoginFixture();
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, allowLocalUrls: true, staticDir: resolve('apps/web/dist') });
    const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const app = bridge.url.replace('127.0.0.1', 'localhost');
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`${app}/#${new URLSearchParams({ bridge: app, token: ownerToken })}`);
      await expect.poll(() => page.getByText('Bridge connected', { exact: true }).count()).toBeGreaterThan(0);

      // 1) Push 2FA challenge escalates to live browser with banner.
      const pushReq = await client.create({ agent: 'Push Agent', title: 'Push challenge sign-in', url: `${site.origin}/login`, ttlSeconds: 120 });
      await page.getByRole('button', { name: /Push challenge sign-in/ }).click();
      await page.getByRole('button', { name: 'Approve & open', exact: true }).click();
      await page.locator('#guided-username').waitFor({ state: 'visible' });
      await page.locator('#guided-username').fill(email);
      await page.locator('#guided-password').fill(secret);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.locator('.challenge-banner').waitFor({ state: 'visible', timeout: 15_000 });
      await page.locator('.remote-screen img').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: /Done, hand back/ }).click();
      await expect.poll(async () => (await client.get(pushReq.id)).status).toBe('completed');
      await page.getByRole('button', { name: 'Back to requests', exact: true }).click();

      // 2) Save to passkey vault during form-first sign-in, then 1-tap Unlock & sign in on next request!
      const saveReq = await client.create({ agent: 'Vault Agent', title: 'Save via form', url: `${simpleSite.origin}/login`, ttlSeconds: 120 });
      await page.getByRole('button', { name: /Save via form/ }).click();
      await page.getByRole('button', { name: 'Approve & open', exact: true }).click();
      await page.locator('#guided-username').waitFor({ state: 'visible' });
      await page.locator('#guided-username').fill(email);
      await page.locator('#guided-password').fill(secret);
      await page.getByLabel(/Save login on this phone/).check();
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('heading', { name: /Looks like you’re signed in/ }).waitFor({ state: 'visible', timeout: 15_000 });
      await page.locator('.guided-card').getByRole('button', { name: /Done, hand back/ }).click();
      await expect.poll(async () => (await client.get(saveReq.id)).status).toBe('completed');
      await page.getByRole('button', { name: 'Back to requests', exact: true }).click();

      // Next sign-in to same site offers 1-tap passkey unlock & sign in!
      const reuseReq = await client.create({ agent: 'Vault Agent', title: 'One-tap passkey sign-in', url: `${simpleSite.origin}/login`, ttlSeconds: 120 });
      await page.getByRole('button', { name: /One-tap passkey sign-in/ }).click();
      await page.getByRole('button', { name: 'Approve & open', exact: true }).click();
      const oneTap = page.getByRole('button', { name: /Unlock with passkey & sign in/ });
      await oneTap.waitFor({ state: 'visible' });
      await oneTap.click();
      await page.getByRole('heading', { name: /Looks like you’re signed in/ }).waitFor({ state: 'visible', timeout: 15_000 });
      expect(simpleSite.loginCount).toBe(2);
      await page.locator('.guided-card').getByRole('button', { name: /Done, hand back/ }).click();
      await expect.poll(async () => (await client.get(reuseReq.id)).status).toBe('completed');
      expect(errors).toEqual([]);
    } finally {
      await cdp.detach().catch(() => {});
      await context.close();
      await bridge.close();
      await site.close();
      await simpleSite.close();
    }
  }, 90_000);
});
