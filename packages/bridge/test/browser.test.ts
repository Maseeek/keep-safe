import { afterEach, expect, it, vi } from 'vitest';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { chromium } from 'playwright';
import { browserAvailable, openBrowser } from '../src/browser';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const server = httpServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/done') {
      if (request.headers.cookie?.includes('fixture=authenticated')) response.end('<h1>Authenticated on reload</h1>');
      else { response.setHeader('Set-Cookie', 'fixture=authenticated; HttpOnly; Path=/'); response.end('<h1>Authenticated</h1>'); }
    }
    else if (request.url === '/popup1') response.end('<h1>Popup 1</h1><input type="password" id="pop1-pass"><a href="/popup2" target="_blank">Open popup 2</a>');
    else if (request.url === '/popup2') response.end('<h1>Popup 2</h1><input type="password" id="pop2-pass">');
    else response.end('<h1>Login fixture</h1><input type="password" id="password"><a href="/done">Complete sign in</a><a href="/popup1" target="_blank">Open popup 1</a>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/login`;
}
async function unusedPort() {
  const server = netServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
const installed = await browserAvailable();

it('rejects CDP discovery that changes the debugging port or leaves the devtools path', async () => {
  let discovered = '';
  const discovery = httpServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ webSocketDebuggerUrl: discovered }));
  });
  await new Promise<void>(resolve => discovery.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => discovery.close(() => resolve())));
  const port = (discovery.address() as { port: number }).port;
  for (const endpoint of [`ws://127.0.0.1:${port === 65535 ? port - 1 : port + 1}/devtools/browser/fake`, `ws://127.0.0.1:${port}/unrelated-service`]) {
    discovered = endpoint;
    await expect(openBrowser({ url: 'https://example.com/login', cdpUrl: `http://127.0.0.1:${port}`, allowLocalUrls: false })).rejects.toThrow('Invalid Chromium debugging endpoint.');
  }
});

it.skipIf(!installed)('disconnects from an external Chromium without closing its page or cookies', async () => {
  const url = await fixture();
  const port = await unusedPort();
  const browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`], ...(process.env.KEEP_SAFE_CHROMIUM_PATH ? { executablePath: process.env.KEEP_SAFE_CHROMIUM_PATH } : {}) });
  cleanup.push(() => browser.close());
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto(url);
  const session = await openBrowser({ url, cdpUrl: `http://127.0.0.1:${port}`, allowLocalUrls: true });
  expect((await session.frame()).width).toBeGreaterThan(0);
  await page.getByRole('link', { name: 'Complete sign in' }).click();
  await expect.poll(() => session.pageUrl).toContain('/done');
  await session.close();
  expect(browser.isConnected()).toBe(true);
  expect(await page.title()).toBe('');
  expect((await context.cookies()).some(cookie => cookie.name === 'fixture')).toBe(true);
  await expect(openBrowser({ url: url + '?different-tab', cdpUrl: `http://127.0.0.1:${port}`, allowLocalUrls: true })).rejects.toThrow('No open browser page matches');
  expect(browser.isConnected()).toBe(true);
});

it.skipIf(!installed)('exposes a managed incognito page for agent resumption and closes it on cleanup', async () => {
  const url = await fixture();
  const session = await openBrowser({ url, allowLocalUrls: true });
  cleanup.push(() => session.close());
  expect(session.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
  const agent = await chromium.connectOverCDP(session.cdpUrl!);
  cleanup.push(() => agent.close());
  const page = agent.contexts().flatMap(context => context.pages()).find(page => page.url() === url);
  expect(page).toBeDefined();
  await page!.locator('#password').fill('synthetic-secret');
  await session.prepareHandoff!();
  expect(await page!.locator('#password').inputValue()).toBe('');
  await page!.getByRole('link', { name: 'Complete sign in' }).click();
  const frame = await session.frame();
  expect(frame.url).toContain('/done');
  expect(frame.width).toBe(390);
  await page!.reload();
  expect(await page!.locator('h1').textContent()).toBe('Authenticated on reload');
  await session.close();
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(agent.isConnected()).toBe(false);
});

it.skipIf(!installed)('recovers from multi-hop popups and clears passwords across touched external pages', async () => {
  const url = await fixture();
  const port = await unusedPort();
  const browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`], ...(process.env.KEEP_SAFE_CHROMIUM_PATH ? { executablePath: process.env.KEEP_SAFE_CHROMIUM_PATH } : {}) });
  cleanup.push(() => browser.close());
  const context = await browser.newContext(); const page0 = await context.newPage();
  await page0.goto(url);
  await page0.locator('#password').fill('initial-secret');
  const unrelated = await context.newPage();
  await unrelated.goto(url + '?unrelated');
  await unrelated.locator('#password').fill('unrelated-tab-secret');
  const session = await openBrowser({ url, cdpUrl: `http://127.0.0.1:${port}`, allowLocalUrls: true });
  cleanup.push(() => session.close());
  const [popup1] = await Promise.all([context.waitForEvent('page'), page0.getByRole('link', { name: 'Open popup 1' }).click()]);
  await popup1.waitForLoadState();
  await expect.poll(() => session.pageUrl).toContain('/popup1');
  await popup1.locator('#pop1-pass').fill('intermediate-popup-secret');
  const [popup2] = await Promise.all([context.waitForEvent('page'), popup1.getByRole('link', { name: 'Open popup 2' }).click()]);
  await popup2.waitForLoadState();
  await expect.poll(() => session.pageUrl).toContain('/popup2');
  await popup2.locator('#pop2-pass').fill('popup-secret');
  await session.prepareHandoff!();
  expect(await page0.locator('#password').inputValue()).toBe('');
  expect(await popup1.locator('#pop1-pass').inputValue()).toBe('');
  expect(await popup2.locator('#pop2-pass').inputValue()).toBe('');
  expect(await unrelated.locator('#password').inputValue()).toBe('unrelated-tab-secret');
  // Close intermediate popup1 first, then popup2; session must fall back to page0.
  await popup1.close();
  await popup2.close();
  await expect.poll(() => session.pageUrl).toBe(url);
  await session.prepareHandoff!();
  expect(await page0.locator('#password').inputValue()).toBe('');
});

it.skipIf(!installed)('retries a replaced navigation context before handback and fails closed on other clearing errors', async () => {
  const url = await fixture();
  const port = await unusedPort();
  const browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`], ...(process.env.KEEP_SAFE_CHROMIUM_PATH ? { executablePath: process.env.KEEP_SAFE_CHROMIUM_PATH } : {}) });
  cleanup.push(() => browser.close());
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto(url);
  const connect = chromium.connectOverCDP.bind(chromium);
  let bridgeFrame: import('playwright').Frame | undefined;
  const connectSpy = vi.spyOn(chromium, 'connectOverCDP').mockImplementation(async (...args) => {
    const attached = await connect(...args);
    bridgeFrame = attached.contexts().flatMap(item => item.pages()).find(item => item.url() === url)!.mainFrame();
    return attached;
  });
  cleanup.push(async () => { connectSpy.mockRestore(); });
  const session = await openBrowser({ url, cdpUrl: `http://127.0.0.1:${port}`, allowLocalUrls: true });
  cleanup.push(() => session.close());
  connectSpy.mockRestore();
  await page.goto(url + '?redirected');
  await page.locator('#password').fill('synthetic-new-document');
  // Control the exact CDP failure emitted when a redirect replaces the old
  // document, while using a real new Chromium document for the retry.
  const evaluate = vi.spyOn(bridgeFrame!, 'evaluate').mockRejectedValueOnce(new Error('Execution context was destroyed, most likely because of a navigation.'));
  cleanup.push(async () => { evaluate.mockRestore(); });
  await session.prepareHandoff!();
  expect(evaluate).toHaveBeenCalledTimes(2);
  expect(await page.locator('#password').inputValue()).toBe('');
  evaluate.mockRejectedValueOnce(new Error('A destination script rejected password clearing.'));
  await expect(session.prepareHandoff!()).rejects.toThrow('Password fields could not be cleared before handoff.');
  expect(evaluate).toHaveBeenCalledTimes(3);
});
