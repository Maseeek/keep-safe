import { afterEach, expect, it, vi } from 'vitest';
import { createServer as httpServer } from 'node:http';
import { connect as connectSocket, createServer as netServer } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
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
    else if (request.url === '/shadow-frame') response.end(`<h1>Frame</h1><script>${shadowSetup}</script>`);
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
const shadowSetup = String.raw`{
  const host = document.createElement('div'); host.id = 'shadow-host'; document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<label>Shadow password<input id="shadow-password" type="password"></label><div id="nested-host"></div>';
  const nested = root.querySelector('#nested-host').attachShadow({ mode: 'open' });
  nested.innerHTML = '<label>Nested password<input id="nested-password" type="password"></label>';
}`;
async function managedFixture() {
  const url = await fixture(); const session = await openBrowser({ url, allowLocalUrls: true });
  cleanup.push(() => session.close());
  const agent = await chromium.connectOverCDP(session.cdpUrl!); cleanup.push(() => agent.close());
  const page = agent.contexts().flatMap(context => context.pages()).find(page => page.url() === url)!;
  return { session, page, url };
}

it.skipIf(!installed)('clears passwords in nested open shadow roots before handback', async () => {
  const { session, page } = await managedFixture();
  await page.evaluate(shadowSetup);
  await page.locator('#shadow-password').fill('synthetic-shadow-secret');
  await page.locator('#nested-password').fill('synthetic-nested-secret');
  await session.prepareHandoff!();
  for (const selector of ['#shadow-password', '#nested-password']) {
    expect(await page.locator(selector).evaluate(element => (element as HTMLInputElement).value === '')).toBe(true);
  }
});

it.skipIf(!installed)('clears open-root passwords across touched frames and popups while preserving unrelated external tabs', async () => {
  const url = await fixture(); const port = await unusedPort();
  const browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`], ...(process.env.KEEP_SAFE_CHROMIUM_PATH ? { executablePath: process.env.KEEP_SAFE_CHROMIUM_PATH } : {}) });
  cleanup.push(() => browser.close());
  const context = await browser.newContext(); const page = await context.newPage(); await page.goto(url);
  await page.evaluate(shadowSetup); await page.locator('#nested-password').fill('synthetic-main');
  await page.evaluate(() => { const frame = document.createElement('iframe'); frame.src = '/shadow-frame'; document.body.append(frame); });
  await page.frameLocator('iframe').locator('#nested-password').fill('synthetic-frame');
  const unrelated = await context.newPage(); await unrelated.goto(url + '?unrelated');
  await unrelated.evaluate(shadowSetup); await unrelated.locator('#nested-password').fill('synthetic-unrelated');
  const session = await openBrowser({ url, cdpUrl: `http://127.0.0.1:${port}`, allowLocalUrls: true }); cleanup.push(() => session.close());
  const [popup] = await Promise.all([context.waitForEvent('page'), page.getByRole('link', { name: 'Open popup 1' }).click()]);
  await popup.waitForLoadState(); await popup.evaluate(shadowSetup); await popup.locator('#nested-password').fill('synthetic-popup');
  await session.prepareHandoff!();
  for (const target of [page.locator('#nested-password'), page.frameLocator('iframe').locator('#nested-password'), popup.locator('#nested-password')]) {
    expect(await target.evaluate(element => (element as HTMLInputElement).value === '')).toBe(true);
  }
  expect(await unrelated.locator('#nested-password').evaluate(element => (element as HTMLInputElement).value !== '')).toBe(true);
});

it.skipIf(!installed).each(['synchronous', 'microtask', 'new-root'])('withholds handback when %s input handlers restore a password', async change => {
  const { session, page } = await managedFixture(); await page.evaluate(shadowSetup);
  await page.locator('#shadow-password').fill('synthetic-before-clear');
  await page.locator('#shadow-password').evaluate((element, change) => {
    element.addEventListener('input', () => {
      if (change === 'new-root') {
        const host = document.createElement('div'); document.body.append(host);
        const root = host.attachShadow({ mode: 'open' }); const input = document.createElement('input'); input.type = 'password'; input.value = 'synthetic-reinserted'; root.append(input);
      } else if (change === 'microtask') queueMicrotask(() => { (element as HTMLInputElement).value = 'synthetic-restored'; });
      else (element as HTMLInputElement).value = 'synthetic-restored';
    });
  }, change);
  await expect(session.prepareHandoff!()).rejects.toThrow('Password fields could not be cleared before handoff.');
});

it.skipIf(!installed).each(['popup', 'frame'])('withholds handback when a later %s clearing handler restores an earlier page password', async target => {
  const { session, page } = await managedFixture();
  await session.frame();
  await page.locator('#password').fill('synthetic-opener-password');
  const child = target === 'popup'
    ? await (async () => { const opened = page.waitForEvent('popup'); await page.evaluate(() => { window.open('/popup1'); }); return opened; })()
    : await (async () => {
      await page.evaluate(() => { const frame = document.createElement('iframe'); frame.src = '/popup1'; document.body.append(frame); });
      await page.frameLocator('iframe').locator('#pop1-pass').waitFor();
      return page.frames().find(frame => frame !== page.mainFrame())!;
    })();
  await child.waitForLoadState();
  await child.locator('#pop1-pass').fill('synthetic-child-password');
  await session.frame();
  await child.locator('#pop1-pass').evaluate(element => element.addEventListener('input', () => {
    const previous = window.opener || window.parent;
    (previous.document.getElementById('password') as HTMLInputElement).value = 'synthetic-restored-earlier-password';
  }, { once: true }));
  await expect(session.prepareHandoff!()).rejects.toThrow('Password fields could not be cleared before handoff.');
  expect(await page.locator('#password').evaluate(element => (element as HTMLInputElement).value !== '')).toBe(true);
});

it.skipIf(!installed)('requires a retry before clearing a popup created synchronously by a clearing event', async () => {
  const { session, page } = await managedFixture();
  await page.locator('#password').evaluate(element => element.addEventListener('input', () => {
    const popup = window.open('about:blank')!;
    const host = popup.document.createElement('div'); popup.document.body.append(host);
    const input = popup.document.createElement('input'); input.type = 'password'; input.id = 'event-password'; input.value = 'synthetic-event-popup';
    host.attachShadow({ mode: 'open' }).append(input);
  }, { once: true }));
  const opened = page.waitForEvent('popup');
  await expect(session.prepareHandoff!()).rejects.toThrow('Password fields could not be cleared before handoff.');
  const popup = await opened;
  await session.prepareHandoff!();
  expect(await popup.locator('#event-password').evaluate(element => (element as HTMLInputElement).value === '')).toBe(true);
});

it.skipIf(!installed).each(['during clearing', 'before clearing', 'during startup'])('withholds handback for a password popup hidden from Playwright %s', async timing => {
  const openHeldPopup = String.raw`{
    const popup = window.open('/held-popup'); window.syntheticPopup = popup;
    const root = popup.document.documentElement || popup.document.appendChild(popup.document.createElement('html'));
    const body = popup.document.body || root.appendChild(popup.document.createElement('body'));
    const host = popup.document.createElement('div'); host.id = 'held-host'; body.append(host);
    const input = popup.document.createElement('input'); input.type = 'password'; input.value = 'synthetic-held-popup';
    host.attachShadow({ mode: 'open' }).append(input);
  }`;
  let release!: () => void; let requested!: () => void;
  const responseBarrier = new Promise<void>(resolve => { release = resolve; });
  const navigationRequested = new Promise<void>(resolve => { requested = resolve; });
  const server = httpServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/held-popup') {
      requested(); void responseBarrier.then(() => response.end('<h1>Popup available</h1>'));
    } else response.end(`<input id="password" type="password">${timing === 'during startup' ? `<script>${openHeldPopup}</script>` : ''}`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/login`;
  // Attaching a second Playwright client waits for the hidden window's first
  // navigation. Retain the launched browser solely as this fixture's assertion
  // transport so the withheld document is not accidentally allowed to finish.
  const launch = chromium.launch.bind(chromium); let launched: import('playwright').Browser | undefined;
  const launchSpy = vi.spyOn(chromium, 'launch').mockImplementation(async (...args) => { launched = await launch(...args); return launched; });
  let session: Awaited<ReturnType<typeof openBrowser>>;
  try { session = await openBrowser({ url, allowLocalUrls: true }); } finally { launchSpy.mockRestore(); }
  cleanup.push(() => session.close());
  const page = launched!.contexts().flatMap(context => context.pages()).find(page => page.url() === url)!;
  let popupVisible = false; page.on('popup', () => { popupVisible = true; });
  const opened = page.waitForEvent('popup'); void opened.catch(() => {});
  if (timing !== 'during startup') await page.evaluate(`document.getElementById('password').addEventListener('input', () => ${openHeldPopup}, { once: true })`);
  try {
    if (timing === 'before clearing') {
      await page.locator('#password').focus();
      // Owner input must not start before the lifetime popup monitor is armed.
      await session.input({ type: 'text', text: 'synthetic-owner-input' });
      await navigationRequested;
    }
    if (timing === 'during startup') {
      await navigationRequested;
      expect(await page.evaluate(() => !!(window as unknown as { syntheticPopup: Window }).syntheticPopup.document.getElementById('held-host'))).toBe(true);
    }
    const outcome = session.prepareHandoff!().then(() => 'acknowledged', () => 'blocked');
    await navigationRequested;
    expect(popupVisible).toBe(false);
    expect(await page.evaluate(() => {
      const popup = (window as unknown as { syntheticPopup: Window }).syntheticPopup;
      const input = popup.document.getElementById('held-host')!.shadowRoot!.querySelector('input')!;
      return input.value !== '';
    })).toBe(true);
    expect(await outcome).toBe('blocked');
    release();
    const popup = await opened;
    await popup.waitForLoadState();
    await session.prepareHandoff!();
    expect(await page.locator('#password').evaluate(element => (element as HTMLInputElement).value === '')).toBe(true);
  } finally { release(); }
});

it.skipIf(!installed).each(['monitor', 'navigation'])('closes the managed browser when startup %s fails', async failure => {
  const url = await fixture();
  const launch = chromium.launch.bind(chromium);
  let launched: import('playwright').Browser | undefined; let port = 0;
  const launchSpy = vi.spyOn(chromium, 'launch').mockImplementation(async (...args) => {
    port = Number(args[0]!.args!.find(argument => argument.startsWith('--remote-debugging-port='))!.split('=')[1]);
    launched = await launch(...args);
    const createContext = launched.newContext.bind(launched);
    const contextSpy = vi.spyOn(launched, 'newContext').mockImplementation(async (...options) => {
      const context = await createContext(...options);
      if (failure === 'monitor') {
        const monitorSpy = vi.spyOn(context, 'newCDPSession').mockRejectedValue(new Error('Synthetic monitor setup failure.'));
        cleanup.push(async () => { monitorSpy.mockRestore(); });
      } else {
        // An upstream connection failure is a valid HTTP 502 through the
        // managed proxy. Inject Chromium's actual navigation rejection at its
        // API boundary to exercise cleanup without waiting for a timeout.
        const createPage = context.newPage.bind(context);
        const pageSpy = vi.spyOn(context, 'newPage').mockImplementation(async () => {
          const page = await createPage();
          const navigationSpy = vi.spyOn(page, 'goto').mockRejectedValue(new Error('Synthetic navigation failure.'));
          cleanup.push(async () => { navigationSpy.mockRestore(); });
          return page;
        });
        cleanup.push(async () => { pageSpy.mockRestore(); });
      }
      return context;
    });
    cleanup.push(async () => { contextSpy.mockRestore(); });
    return launched;
  });
  cleanup.push(async () => { await launched?.close(); });
  try { await expect(openBrowser({ url, allowLocalUrls: true })).rejects.toThrow(); }
  finally { launchSpy.mockRestore(); }
  expect(launched!.isConnected()).toBe(false);
  const listening = await new Promise<boolean>(resolve => {
    const socket = connectSocket(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
  });
  expect(listening).toBe(false);
});

it.skipIf(!installed).each(['nodes', 'roots', 'depth', 'passwords', 'error'])('fails closed when the %s clearing budget or traversal is unsafe', async limit => {
  const { session, page } = await managedFixture();
  await page.evaluate(limit => {
    if (limit === 'nodes' || limit === 'passwords') {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < (limit === 'nodes' ? 100_001 : 4097); index++) {
        const element = document.createElement(limit === 'nodes' ? 'span' : 'input');
        if (element instanceof HTMLInputElement) element.type = 'password';
        fragment.append(element);
      }
      document.body.append(fragment);
    } else if (limit === 'roots' || limit === 'depth') {
      let parent: Node = document.body;
      for (let index = 0; index < (limit === 'roots' ? 1024 : 33); index++) {
        const host = document.createElement('div'); parent.appendChild(host);
        const root = host.attachShadow({ mode: 'open' });
        if (limit === 'depth') parent = root;
      }
    } else {
      const host = document.createElement('div'); document.body.append(host);
      Object.defineProperty(host, 'shadowRoot', { get() { throw new Error('Synthetic traversal failure.'); } });
    }
  }, limit);
  await expect(session.prepareHandoff!()).rejects.toThrow('Password fields could not be cleared before handoff.');
});

it.skipIf(!installed)('clears open-root fields on an ordinary large page without materializing its full DOM', async () => {
  const { session, page } = await managedFixture();
  await page.evaluate(() => { const fragment = document.createDocumentFragment(); for (let index = 0; index < 50_000; index++) fragment.append(document.createElement('span')); document.body.append(fragment); });
  await page.evaluate(shadowSetup); await page.locator('#nested-password').fill('synthetic-large-page');
  await session.prepareHandoff!();
  expect(await page.locator('#nested-password').evaluate(element => (element as HTMLInputElement).value === '')).toBe(true);
});

it.skipIf(!installed)('keeps clearing pending through a busy setter and rejects the expired handback deadline', async () => {
  const { session, page } = await managedFixture(); await page.evaluate(shadowSetup);
  await page.locator('#nested-password').fill('synthetic-busy-clear');
  await page.evaluate(() => {
    const original = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    Object.defineProperty(HTMLInputElement.prototype, 'value', { ...original, set(value) {
      console.debug('synthetic-password-clear-started');
      const deadline = Date.now() + 3500; while (Date.now() < deadline) { /* Deliberately block the renderer. */ }
      original.set!.call(this, value);
    } });
  });
  let started!: () => void; const clearingStarted = new Promise<void>(resolve => { started = resolve; });
  page.on('console', message => { if (message.text() === 'synthetic-password-clear-started') started(); });
  let settled = false;
  const outcome = session.prepareHandoff!().then(() => { settled = true; return 'accepted'; }, () => { settled = true; return 'rejected'; });
  await clearingStarted; await new Promise(resolve => setTimeout(resolve, 2200));
  expect(settled).toBe(false); expect(await outcome).toBe('rejected');
});

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
  // One failed context, clearing, its local check, then the global read-only check.
  expect(evaluate).toHaveBeenCalledTimes(4);
  expect(await page.locator('#password').inputValue()).toBe('');
  evaluate.mockRejectedValueOnce(new Error('A destination script rejected password clearing.'));
  await expect(session.prepareHandoff!()).rejects.toThrow('Password fields could not be cleared before handoff.');
  expect(evaluate).toHaveBeenCalledTimes(5);
});

it.skipIf(!installed)('clears nested open-root fields through the production tsx loader', async () => {
  const source = `
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openBrowser } from './packages/bridge/src/browser.ts';
import { startLoginFixture } from './tests/fixtures/login-site.ts';
const site = await startLoginFixture(); let session; let agent;
try {
  session = await openBrowser({ url: site.origin + '/login', allowLocalUrls: true });
  agent = await chromium.connectOverCDP(session.cdpUrl);
  const page = agent.contexts().flatMap(context => context.pages()).find(page => page.url() === session.pageUrl);
  assert(page); await page.evaluate(${JSON.stringify(shadowSetup)});
  await page.locator('#nested-password').fill('synthetic-loader-clear');
  await session.prepareHandoff();
  assert(await page.locator('#nested-password').evaluate(input => input.value === ''));
  console.log('shadow-handoff-runtime-ok');
} finally { await agent?.close(); await session?.close(); await site.close(); }
`;
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), '--input-type=module'], { cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000); child.stdin.end(source);
  try { expect(await exited, stderr.slice(-1000)).toBe(0); expect(stdout.trim()).toBe('shadow-handoff-runtime-ok'); }
  finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
