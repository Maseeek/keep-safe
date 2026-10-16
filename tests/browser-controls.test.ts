import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';

describe('built live browser controls', () => {
  let browser: Browser;
  let image: string;
  beforeAll(async () => {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 720 } });
    await page.setContent('<h1>Synthetic browser fixture</h1>');
    image = (await page.screenshot({ type: 'jpeg' })).toString('base64');
    await page.close();
  });
  afterAll(async () => { await browser?.close(); });

  async function setup() {
    let url = 'https://example.com:8443/login?code=synthetic-private-code';
    const inputs: Array<{ type: string; [key: string]: unknown }> = [];
    const bridge = await createBridge({
      ownerToken: 'controls-owner', agentToken: 'controls-agent', port: 0,
      staticDir: resolve('apps/web/dist'),
      browserFactory: async () => ({
        frame: async () => ({ data: image, width: 390, height: 720, url }),
        input: async input => { inputs.push(input); },
        close: async () => {},
      }),
    });
    const client = new BridgeClient({ url: bridge.url, token: 'controls-agent' });
    const request = await client.create({ agent: 'Controls test', title: 'Test live controls', url });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const sockets: string[] = [];
    const errors: string[] = [];
    page.on('websocket', socket => sockets.push(socket.url()));
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: 'controls-owner' })}`);
    await page.getByRole('button', { name: /Controls test example.com/ }).click();
    await page.getByRole('button', { name: 'Approve & open' }).click();
    await page.locator('.remote-screen img').waitFor({ state: 'visible' });
    return { bridge, client, request, context, page, inputs, sockets, errors, setUrl(value: string) { url = value; } };
  }

  it('shows scheme and port changes and does not call an opaque page secure', async () => {
    const flow = await setup();
    const { page } = flow;
    try {
      expect(await page.locator('.address').innerText()).toBe('https://example.com:8443');
      expect(await page.locator('.address').getAttribute('title')).not.toContain('synthetic-private-code');
      expect(await page.locator('.redirect-note').count()).toBe(0);
      expect(await page.locator('body').innerText()).not.toMatch(/\\u[0-9a-fA-F]{4}/);
      flow.setUrl('http://example.com:8443/redirect?code=another-secret');
      await expect.poll(() => page.locator('.address').innerText()).toBe('http://example.com:8443');
      expect(await page.locator('.redirect-note').innerText()).toContain('http://example.com:8443');
      expect(await page.locator('.address [aria-label="Page is not using HTTPS"]').count()).toBe(1);
      flow.setUrl('about:blank');
      await expect.poll(() => page.locator('.address').innerText()).toBe('about:blank');
      expect(await page.locator('.address [aria-label="HTTPS connection"]').count()).toBe(0);
      expect(flow.errors).toEqual([]);
    } finally { await flow.context.close(); await flow.bridge.close(); }
  });

  it('coalesces a trackpad burst and drops pending scrolling when the owner leaves the session', async () => {
    const flow = await setup();
    const { page, inputs } = flow;
    try {
      await page.locator('.remote-screen img').evaluate(element => {
        for (let index = 0; index < 200; index++) element.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true }));
      });
      await expect.poll(() => inputs.filter(input => input.type === 'scroll').length).toBe(1);
      expect(inputs[0]).toMatchObject({ type: 'scroll', deltaX: 0, deltaY: 3000 });
      expect(flow.sockets).toHaveLength(1);
      await page.locator('.remote-screen img').evaluate(element => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: 50, bubbles: true }));
        document.querySelector<HTMLButtonElement>('[aria-label="Back to requests"]')!.click();
      });
      await page.getByRole('button', { name: /Controls test example.com/ }).waitFor({ state: 'visible' });
      await page.getByRole('button', { name: /Controls test example.com/ }).click();
      await page.locator('.remote-screen img').waitFor({ state: 'visible' });
      // A key acknowledgement follows any erroneously queued scroll on the same socket.
      await page.getByTitle('Press Tab in browser').click();
      await expect.poll(() => inputs.filter(input => input.type === 'key').length).toBe(1);
      expect(inputs.filter(input => input.type === 'scroll')).toHaveLength(1);
      expect(flow.errors).toEqual([]);
    } finally { await flow.context.close(); await flow.bridge.close(); }
  });

  it('reconnects after an input rate limit without losing the valid pairing or live request', async () => {
    const flow = await setup();
    const { page } = flow;
    try {
      const pairing = await page.evaluate(() => sessionStorage.getItem('keep-safe.connection.v1'));
      await page.getByTitle('Press Tab in browser').evaluate(button => {
        for (let index = 0; index < 80; index++) (button as HTMLButtonElement).click();
      });
      await expect.poll(() => flow.sockets.length, { timeout: 10000 }).toBe(2);
      await page.locator('.remote-screen img').waitFor({ state: 'visible' });
      await expect.poll(() => page.getByText('Bridge connected', { exact: true }).count()).toBe(1);
      expect(await page.evaluate(() => sessionStorage.getItem('keep-safe.connection.v1'))).toBe(pairing);
      expect((await flow.client.get(flow.request.id)).status).toBe('active');
      const before = flow.inputs.length;
      await page.getByTitle('Press Tab in browser').click();
      await expect.poll(() => flow.inputs.length).toBe(before + 1);
      expect(flow.errors).toEqual([]);
    } finally { await flow.context.close(); await flow.bridge.close(); }
  });
});
