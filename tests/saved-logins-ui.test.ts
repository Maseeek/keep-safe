import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';
import { startLoginFixture } from './fixtures/login-site';

const ownerToken = 'saved-logins-owner'; const agentToken = 'saved-logins-agent';
// Synthetic values for a local fixture only.
const email = 'vault-fixture@example.invalid'; const secret = 'synthetic-vault-only-7Qx';

describe('logins saved on the phone', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each([320, 390])('saves a login with a passkey, fills it into the next sign-in, and never into the wrong field, at %ipx', async width => {
    const fixture = await startLoginFixture();
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, allowLocalUrls: true, staticDir: resolve('apps/web/dist') });
    const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage(); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // A passkey needs a domain name: WebAuthn refuses an IP address.
    const app = bridge.url.replace('127.0.0.1', 'localhost');
    const sent: string[] = [];
    page.on('websocket', socket => socket.on('framesent', frame => sent.push(String(frame.payload))));
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true,
    } });
    try {
      const open = async (title: string) => {
        const request = await client.create({ agent: 'Vault Agent', title, url: fixture.origin + '/login', fields: ['Email', 'Password'], ttlSeconds: 120 });
        await page.getByRole('button', { name: new RegExp(title) }).click();
        await page.getByText('Have ready: Email, Password', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Approve & open', exact: true }).click();
        await page.locator('.remote-screen img').waitFor();
        await expect.poll(async () => (await client.get(request.id)).status).toBe('active');
        return request;
      };
      const handBack = async (id: string) => {
        await page.getByRole('button', { name: /Done, hand back/ }).click();
        await expect.poll(async () => (await client.get(id)).status).toBe('completed');
        await page.getByRole('button', { name: 'Back to requests', exact: true }).click();
      };
      const passwords = page.getByRole('button', { name: 'Passwords', exact: true });
      const tab = () => page.getByTitle('Press Tab in browser').click();

      await page.goto(`${app}/#${new URLSearchParams({ bridge: app, token: ownerToken })}`);
      await expect.poll(() => page.getByText('Bridge connected', { exact: true }).count()).toBeGreaterThan(0);

      // First sign-in: the owner's password manager fills the boxes, and they save them.
      const first = await open('First vault sign-in');
      await passwords.click();
      await page.getByText(`Saved on this phone for ${new URL(fixture.origin).host}`, { exact: true }).waitFor();
      await page.getByText('Nothing saved yet. Fill the boxes below, then save them.', { exact: true }).waitFor();
      await page.getByLabel('Username or email', { exact: true }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill(secret);
      await page.getByRole('button', { name: 'Save to this phone', exact: true }).click();
      await expect.poll(() => page.locator('.tool-notice').innerText()).toBe(`Saved on this phone for ${new URL(fixture.origin).host}.`);
      // Storage holds the site and ciphertext, never the values.
      const stored = await page.evaluate(() => localStorage.getItem('keep-safe.vault.v1') ?? '');
      expect(stored).toContain(fixture.origin);
      expect(stored).not.toContain(email); expect(stored).not.toContain(secret);
      // Saving typed nothing into the page.
      expect(sent.filter(text => text.includes(secret) || text.includes(email))).toEqual([]);
      await handBack(first.id);

      // Second sign-in: the saved login fills the fields the owner chose.
      const second = await open('Second vault sign-in');
      await passwords.click();
      // A new opening of the panel needs a new approval.
      const unlock = page.getByRole('button', { name: 'Unlock with passkey', exact: true });
      await unlock.click();
      expect((await page.getByRole('button', { name: /^Fill / }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
      // Nothing tapped yet: filling is not offered.
      expect(await page.getByRole('button', { name: /^Fill / }).isDisabled()).toBe(true);
      await page.getByText(email, { exact: true }).waitFor();
      expect(await page.locator('body').innerText()).not.toContain(secret);

      await tab();
      await page.getByRole('button', { name: `Fill username for ${email}`, exact: true }).click();
      await expect.poll(() => page.locator('.tool-notice').innerText()).toBe('Username filled. Tap the password field next.');
      await tab();
      await page.getByRole('button', { name: `Fill password for ${email}`, exact: true }).click();
      await expect.poll(() => page.locator('.tool-notice').innerText()).toBe(`Password for ${new URL(fixture.origin).host} filled.`);
      // Each value went to the page once, as typing, and nowhere else.
      expect(sent.filter(text => text.includes(secret))).toHaveLength(1);
      expect(sent.filter(text => text.includes(email))).toHaveLength(1);
      expect(await page.locator('body').innerText()).not.toContain(secret);
      await page.getByTitle('Press Enter in browser').click();
      await expect.poll(() => fixture.loginCount, { timeout: 10000 }).toBe(1);
      // The page changed, so the old tap no longer counts, and the button says so.
      await expect.poll(() => page.getByRole('button', { name: /^Fill / }).isDisabled()).toBe(true);
      await handBack(second.id);

      // A password is never typed into a field that is not a password field.
      const third = await open('Third vault sign-in');
      await passwords.click();
      await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
      await tab();
      const before = sent.length;
      await page.getByRole('button', { name: `Fill username for ${email}`, exact: true }).click();
      await expect.poll(() => sent.length).toBeGreaterThan(before);
      expect(sent.slice(before).some(text => text.includes(secret))).toBe(false);

      // Closing the panel locks it. A refused passkey leaves it locked and fills nothing.
      // (Chromium's virtual authenticator refuses everything after one refusal, so this comes last.)
      await passwords.click(); await passwords.click();
      await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
      await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'The passkey was not approved.' }).waitFor();
      expect(await page.getByRole('button', { name: /^Fill / }).count()).toBe(0);
      await handBack(third.id);

      // Settings lists the site without the account, and can forget everything.
      await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('button', { name: `Delete saved login for ${new URL(fixture.origin).host}`, exact: true }).waitFor();
      expect(await page.locator('body').innerText()).not.toContain(email);
      await page.getByRole('button', { name: 'Forget saved logins…', exact: true }).click();
      await page.getByRole('button', { name: 'Forget all saved logins', exact: true }).click();
      expect(await page.evaluate(() => localStorage.getItem('keep-safe.vault.v1'))).toBeNull();

      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await cdp.detach().catch(() => {}); await context.close(); await bridge.close(); await fixture.close(); }
  }, 90000);
});
