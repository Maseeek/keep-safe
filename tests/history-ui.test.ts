import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser, type Locator } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';

const ownerToken = 'synthetic-history-owner';
const agentToken = 'synthetic-history-agent';
async function targetFits(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await target.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await target.evaluate(element => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === element || element.contains(hit);
  })).toBe(true);
}

describe('history cleanup on a phone', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each([320, 390])('confirms cleanup, preserves an unexpired demo handoff and restores focus at %ipx', async width => {
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, staticDir: resolve('apps/web/dist') });
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`${bridge.url}/?demo`);
      await page.getByRole('button', { name: /Claude Code github.com/ }).click();
      await page.getByRole('button', { name: 'Approve & open' }).click();
      await page.getByRole('button', { name: /Simulate signing in/ }).click();
      await page.getByRole('button', { name: /Done, hand back/ }).click();
      await page.getByRole('heading', { name: 'Back in good hands.' }).waitFor();
      await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Activity', exact: true }).click();
      await expect.poll(() => page.locator('.activity-row').count()).toBe(2);
      expect(await page.locator('.history-counts').innerText()).toContain('1 past expiry · 1 kept until expiry');
      const clear = page.getByRole('button', { name: 'Clear finished history', exact: true });
      await targetFits(clear);
      for (const cancel of ['Keep history', 'Escape']) {
        await clear.click();
        const dialog = page.getByRole('dialog', { name: 'Clear finished history?' });
        await dialog.waitFor();
        expect(await page.getByRole('button', { name: 'Keep history', exact: true }).evaluate(element => document.activeElement === element)).toBe(true);
        for (const button of await dialog.getByRole('button').all()) await targetFits(button);
        await page.keyboard.press('Tab');
        expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
        if (cancel === 'Escape') await page.keyboard.press('Escape');
        else await page.getByRole('button', { name: cancel, exact: true }).click();
        await expect.poll(() => clear.evaluate(element => document.activeElement === element)).toBe(true);
        expect(await page.locator('.activity-row').count()).toBe(2);
      }
      await clear.click();
      await page.getByRole('button', { name: 'Clear history', exact: true }).click();
      await expect.poll(() => page.locator('.activity-row').count()).toBe(1);
      expect(await page.locator('.activity-row').innerText()).toContain('Connect to GitHub');
      expect(await clear.isDisabled()).toBe(true);
      await expect.poll(() => page.locator('.history-controls').evaluate(element => document.activeElement === element)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (process.env.KEEP_SAFE_QA_SCREENSHOTS) {
        await mkdir('.keep-safe/qa', { recursive: true });
        await page.screenshot({ path: `.keep-safe/qa/history-demo-${width}.png`, fullPage: true });
      }
      expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); }
  });

  it('retries a failed cleanup without losing history and keeps live and unexpired agent outcomes', async () => {
    let time = Date.now() - 5000;
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, now: () => time, staticDir: resolve('apps/web/dist') });
    const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const post = (path: string) => fetch(bridge.url + path, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, body: '{}' });
    const context = await browser.newContext({ viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
      const old = await client.create({ agent: 'History test', title: 'Old finished request', url: 'https://example.com', ttlSeconds: 1 });
      expect((await post(`/api/requests/${old.id}/deny`)).ok).toBe(true);
      time = Date.now();
      const live = await client.create({ agent: 'History test', title: 'Pending request survives cleanup', url: 'https://example.com', ttlSeconds: 120 });
      const recent = await client.create({ agent: 'History test', title: 'Recent outcome survives cleanup', url: 'https://example.com', ttlSeconds: 120 });
      expect((await post(`/api/requests/${recent.id}/deny`)).ok).toBe(true);
      await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: ownerToken })}`);
      await page.getByText('Bridge connected', { exact: true }).waitFor();
      await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Activity', exact: true }).click();
      await expect.poll(() => page.locator('.activity-row').count()).toBe(2);
      await page.getByRole('button', { name: 'Clear finished history', exact: true }).click();
      await page.route('**/api/history/clear', async route => {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The bridge is temporarily unavailable.' }) });
      }, { times: 1 });
      await page.getByRole('button', { name: 'Clear history', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'temporarily unavailable' }).waitFor();
      expect(await page.locator('.activity-row').count()).toBe(2);
      expect((await client.get(old.id)).status).toBe('denied');
      await page.getByRole('button', { name: 'Clear history', exact: true }).click();
      await expect.poll(() => page.locator('.activity-row').count()).toBe(1);
      await expect(client.get(old.id)).rejects.toThrow('not found');
      expect((await client.get(live.id)).status).toBe('pending');
      expect((await client.get(recent.id)).status).toBe('denied');
      expect(await page.locator('.activity-row').innerText()).toContain('Recent outcome survives cleanup');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (process.env.KEEP_SAFE_QA_SCREENSHOTS) {
        await mkdir('.keep-safe/qa', { recursive: true });
        await page.screenshot({ path: '.keep-safe/qa/history-live.png', fullPage: true });
      }
    } finally { await context.close(); await bridge.close(); }
  });

  it('shows a safe update message for a bridge without cleanup support', async () => {
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, staticDir: resolve('apps/web/dist') });
    delete bridge.info.historyRetentionHours; // Older protocol fixture, including its WebSocket ready message.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
      await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: ownerToken })}`);
      await page.getByText('Bridge connected', { exact: true }).waitFor();
      await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Activity', exact: true }).click();
      expect(await page.locator('.history-controls').innerText()).toContain('Update the bridge');
      expect(await page.getByRole('button', { name: 'Clear finished history', exact: true }).isDisabled()).toBe(true);
    } finally { await context.close(); await bridge.close(); }
  });

  it('keeps a new pairing when an older bridge request later rejects its credentials', async () => {
    const first = await createBridge({ ownerToken, agentToken, port: 0, staticDir: resolve('apps/web/dist') });
    const nextOwner = 'synthetic-new-bridge-owner';
    const second = await createBridge({ ownerToken: nextOwner, agentToken, port: 0, appUrl: first.url });
    const client = new BridgeClient({ url: second.url, token: agentToken });
    await client.create({ agent: 'New computer', title: 'Keep the new pairing', url: 'https://example.com' });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    let release = () => {};
    page.setDefaultTimeout(5000);
    let captured = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { captured = resolve; });
    try {
      await page.route(first.url + '/api/requests', async route => {
        captured();
        await held;
        await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Old pairing is no longer valid."}' });
      });
      await page.goto(`${first.url}/#${new URLSearchParams({ bridge: first.url, token: ownerToken })}`);
      await started;
      await page.getByText('Bridge connected', { exact: true }).waitFor();
      await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Connect', exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.getByRole('button', { name: 'Update pairing', exact: true }).click();
      await page.getByLabel('Bridge address').fill(second.url);
      await page.getByLabel('Owner token from your bridge terminal', { exact: true }).fill(nextOwner);
      await page.getByRole('button', { name: 'Connect securely', exact: true }).click();
      await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('keep-safe.connection.v1') || '{}').url)).toBe(second.url);
      const rejected = page.waitForResponse(response => response.url() === first.url + '/api/requests' && response.status() === 401);
      release();
      await (await rejected).finished();
      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('keep-safe.connection.v1') || '{}').url)).toBe(second.url);
      expect(await page.getByText('Bridge connected', { exact: true }).isVisible()).toBe(true);
      expect(await page.locator('.pairing-expired-notice').count()).toBe(0);
    } finally { release(); await context.close(); await second.close(); await first.close(); }
  });
});
