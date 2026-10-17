import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createOutboundProxy, validateTargetUrl, resolveDestination } from './network';
import { createPageControls } from './page-controls';
import type { PageControlsSnapshot } from '../../shared/src/protocol';
export { validateTargetUrl } from './network';

export interface BrowserFrame { data: string; width: number; height: number; url: string }
export interface BrowserSession {
  readonly cdpUrl?: string;
  readonly pageUrl?: string;
  frame(): Promise<BrowserFrame>;
  input(input: { type: string; [key: string]: unknown }): Promise<void>;
  inspectControls?(): Promise<PageControlsSnapshot>;
  prepareHandoff?(): Promise<void>;
  close(): Promise<void>;
}
export type BrowserFactory = (input: { url: string; cdpUrl?: string; allowLocalUrls: boolean }) => Promise<BrowserSession>;

export function validateCdpUrl(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('CDP must be a loopback Chromium debugging URL.');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('CDP must be a loopback Chromium debugging URL.'); }
  // IP literals only: avoid localhost DNS/redirect tricks when attaching a privileged browser.
  if (!['127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'ws:'].includes(url.protocol) || url.username || url.password || !url.port) {
    throw new Error('CDP must use http://127.0.0.1:PORT or ws://127.0.0.1:PORT.');
  }
  return url.href;
}

export async function browserAvailable(): Promise<boolean> {
  try { await access(process.env.KEEP_SAFE_CHROMIUM_PATH || chromium.executablePath()); return true; } catch { return false; }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function clearPagePasswords(current: Page, deadline: number): Promise<void> {
  while (!current.isClosed()) {
    const frames = current.frames();
    let retry = false;
    for (const frame of frames) {
      try {
        await frame.evaluate(() => {
          for (const input of document.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(input, ''); else input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      } catch (error) {
        if (current.isClosed()) return;
        // A successful sign-in can replace this execution context between the
        // owner's last keystroke and handback. Retry the new document, never an
        // arbitrary page-script error, before exposing the browser to the agent.
        const navigation = error instanceof Error && /Execution context was destroyed|Cannot find context with specified id/.test(error.message);
        if (!frame.isDetached() && !navigation) throw new Error('Password fields could not be cleared before handoff.');
        retry = true;
        break;
      }
    }
    const latest = current.frames();
    if (!retry && frames.length === latest.length && frames.every(frame => latest.includes(frame))) return;
    if (Date.now() >= deadline) throw new Error('Password fields could not be cleared before handoff.');
    // Do not race/abandon an evaluation: the server's input barrier must remain
    // held until Chromium actually settles it, even when a navigation is slow.
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
}

export const openBrowser: BrowserFactory = async ({ url, cdpUrl, allowLocalUrls }) => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let owned = false;
  let proxy: Awaited<ReturnType<typeof createOutboundProxy>> | undefined;
  if (cdpUrl) {
    // Resolve HTTP discovery ourselves, rejecting redirects and non-loopback returned endpoints.
    let endpoint = cdpUrl;
    if (cdpUrl.startsWith('http:')) {
      const origin = new URL(cdpUrl);
      const discovery = new URL('/json/version', cdpUrl);
      const response = await fetch(discovery, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Chromium debugging endpoint is unavailable.');
      const data = await response.json() as { webSocketDebuggerUrl?: string };
      endpoint = validateCdpUrl(data.webSocketDebuggerUrl) ?? '';
      if (!endpoint.startsWith('ws:')) throw new Error('Invalid Chromium debugging endpoint.');
      const resolved = new URL(endpoint);
      if (resolved.hostname !== origin.hostname || resolved.port !== origin.port || !resolved.pathname.startsWith('/devtools/')) {
        throw new Error('Invalid Chromium debugging endpoint.');
      }
    }
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
    const existing = browser.contexts().flatMap(item => item.pages());
    page = existing.find(item => item.url() === url)!;
    if (!page) { await browser.close(); throw new Error('No open browser page matches this website. Open the login page before requesting a handoff.'); }
    context = page.context();
  } else {
    const port = await freePort();
    await resolveDestination(new URL(url).hostname, allowLocalUrls);
    proxy = await createOutboundProxy(allowLocalUrls);
    try {
      browser = await chromium.launch({
        headless: true, proxy: { server: proxy.url },
        ...(process.env.KEEP_SAFE_CHROMIUM_PATH ? { executablePath: process.env.KEEP_SAFE_CHROMIUM_PATH } : {}),
        args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      });
    } catch (error) { await proxy.close(); throw error; }
    owned = true;
    cdpUrl = `http://127.0.0.1:${port}`;
    try {
      context = await browser.newContext({ viewport: { width: 390, height: 720 }, deviceScaleFactor: 1, acceptDownloads: false, serviceWorkers: 'block' });
      // Incognito contexts keep website cookies in memory. No tracing/video/storage-state files.
      await context.route('**/*', async route => {
        try { const target = new URL(validateTargetUrl(route.request().url(), allowLocalUrls)); await resolveDestination(target.hostname, allowLocalUrls); await route.continue(); } catch { await route.abort('blockedbyclient'); }
      });
      page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (error) { await browser.close(); await proxy.close(); throw error; }
  }
  const listeners: Array<() => void> = [];
  const pageStack: Page[] = [page];
  const sessionPages = new Set<Page>([page]);
  let pageControls: ReturnType<typeof createPageControls> | undefined;
  const invalidateControls = () => { void pageControls?.clear(); };
  const selectActivePage = () => {
    for (let index = pageStack.length - 1; index >= 0; index--) {
      if (!pageStack[index].isClosed()) {
        if (page !== pageStack[index]) invalidateControls();
        page = pageStack[index];
        return;
      }
    }
  };
  const instrument = (current: Page) => {
    sessionPages.add(current);
    const dismiss = (dialog: import('playwright').Dialog) => { void dialog.dismiss().catch(() => {}); };
    const popupOpened = (popup: Page) => {
      invalidateControls();
      pageStack.push(popup);
      page = popup;
      instrument(popup);
    };
    const navigated = (frame: import('playwright').Frame) => { if (frame === current.mainFrame()) invalidateControls(); };
    const navigationRequested = (request: import('playwright').Request) => {
      if (!request.isNavigationRequest()) return;
      try { if (request.frame() === current.mainFrame()) invalidateControls(); }
      catch { invalidateControls(); } // A disappearing frame must not crash a session event listener.
    };
    const pageClosed = () => { invalidateControls(); selectActivePage(); };
    current.on('dialog', dismiss); current.on('popup', popupOpened);
    current.on('framenavigated', navigated); current.on('request', navigationRequested); current.on('close', pageClosed);
    listeners.push(() => { current.off('dialog', dismiss); current.off('popup', popupOpened); current.off('framenavigated', navigated); current.off('request', navigationRequested); current.off('close', pageClosed); });
  };
  instrument(page);
  pageControls = createPageControls(() => { selectActivePage(); return page; });
  let closed = false;
  return {
    cdpUrl,
    get pageUrl() { selectActivePage(); return page.url(); },
    async frame() {
      selectActivePage();
      if (closed || page.isClosed()) throw new Error('This browser page is closed.');
      const image = await page.screenshot({ type: 'jpeg', quality: 65, timeout: 5000, animations: 'disabled' });
      const size = page.viewportSize() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      return { data: image.toString('base64'), ...size, url: page.url() };
    },
    async input(input) {
      selectActivePage();
      if (closed || page.isClosed()) throw new Error('This browser page is closed.');
      if (input.type === 'click') await page.mouse.click(input.x as number, input.y as number);
      else if (input.type === 'scroll') await page.mouse.wheel(input.deltaX as number, input.deltaY as number);
      else if (input.type === 'text') await page.keyboard.insertText(input.text as string);
      else if (input.type === 'key') await page.keyboard.press(input.key as string);
      else if (input.type === 'focus') {
        if (typeof input.snapshotId !== 'string' || typeof input.controlId !== 'string') throw new Error('Choose a control from the current inspection.');
        await pageControls!.focus(input.snapshotId, input.controlId);
      }
    },
    async inspectControls() {
      selectActivePage();
      if (closed || page.isClosed()) throw new Error('This browser page is closed.');
      return pageControls!.inspect();
    },
    async prepareHandoff() {
      selectActivePage();
      await pageControls!.clear();
      if (closed || page.isClosed()) throw new Error('This browser page is closed.');
      // Clear residual password inputs on every still-open session page/frame before exposing a managed CDP endpoint.
      // This does not promise to erase secrets retained by the destination website's own JavaScript.
      const pages = (owned ? context.pages() : [...sessionPages]).filter(item => !item.isClosed());
      const deadline = Date.now() + 3000;
      for (const current of pages) await clearPagePasswords(current, deadline);
      selectActivePage();
      if (closed || page.isClosed()) throw new Error('This browser page is closed.');
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const remove of listeners.splice(0)) remove();
      await pageControls!.clear();
      // Closing a connected Playwright browser disconnects; it does not terminate the agent's browser.
      if (owned) await context.close().catch(() => {});
      await browser.close().catch(() => {});
      await proxy?.close();
    },
  };
};
