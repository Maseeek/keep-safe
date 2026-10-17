import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
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

/** Plain browser JavaScript avoids production tsx serialization helpers.
 * Only an empty/nonempty verdict leaves the renderer. Closed roots and secrets
 * retained by the website's own JavaScript remain outside this boundary.
 */
const passwordHandoffSource = String.raw`async (deadline, clear) => {
  try {
    const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (!nativeValue?.get || !nativeValue?.set) return false;
    const expired = () => Date.now() >= deadline;
    function scan(visit) {
      let examined = 0; let roots = 1; let passwords = 0;
      const pending = [{ root: document, depth: 0 }];
      while (pending.length) {
        const current = pending.pop();
        const walker = document.createTreeWalker(current.root, NodeFilter.SHOW_ELEMENT);
        for (let element = walker.nextNode(); element; element = walker.nextNode()) {
          if (++examined > 100000 || expired()) return false;
          const shadow = element.shadowRoot;
          if (shadow) {
            if (++roots > 1024 || current.depth >= 32) return false;
            pending.push({ root: shadow, depth: current.depth + 1 });
          }
          if (element instanceof HTMLInputElement && element.type === 'password') {
            if (++passwords > 4096 || !visit(element)) return false;
          }
        }
      }
      return !expired();
    }
    if (!clear) return scan(input => nativeValue.get.call(input) === '');
    const targets = [];
    if (!scan(input => { targets.push(input); return true; })) return false;
    for (const input of targets) {
      if (expired()) return false;
      nativeValue.set.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }
    await Promise.resolve();
    // A framework may immediately restore a controlled field, including after
    // changing its type. Compare in-browser and export no field value.
    return !expired() && targets.every(input => nativeValue.get.call(input) === '');
  } catch { return false; }
}`;

async function clearPagePasswords(current: Page, deadline: number, clear = true): Promise<void> {
  while (!current.isClosed()) {
    const frames = current.frames();
    let retry = false;
    for (const frame of frames) {
      try {
        if (Date.now() >= deadline || await frame.evaluate(`(${passwordHandoffSource})(${deadline}, ${clear})`) !== true) throw new Error('Password clearing was not verified.');
        // A separate renderer round trip observes event-handler microtasks and
        // newly inserted fields/roots before handback. Future site tasks can
        // still modify their own page; this is not cancellation of website JS.
        if (clear && (Date.now() >= deadline || await frame.evaluate(`(${passwordHandoffSource})(${deadline}, false)`) !== true || Date.now() >= deadline)) throw new Error('Password clearing was not verified.');
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
    } catch (error) { await browser.close(); await proxy.close(); throw error; }
  }
  const listeners: Array<() => void> = [];
  const pageStack: Page[] = [page];
  const sessionPages = new Set<Page>([page]);
  let closed = false;
  let popupGeneration = 0;
  let documentGeneration = 0;
  // Playwright reports a new page only after its first non-initial navigation.
  // Keep the earlier Chromium intent for the lifetime of each tracked page so
  // an initial about:blank document cannot disappear from the handback boundary.
  const popupMonitors = new Map<Page, { ready: Promise<void>; session?: CDPSession; pending: number; failed: boolean; opened: () => void }>();
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
    if (popupMonitors.has(current)) return;
    sessionPages.add(current);
    const monitor = {
      ready: Promise.resolve(), session: undefined as CDPSession | undefined, pending: 0, failed: false,
      opened: () => { monitor.pending++; popupGeneration++; },
    };
    popupMonitors.set(current, monitor);
    monitor.ready = (async () => {
      try {
        const session = await context.newCDPSession(current);
        monitor.session = session;
        if (closed) { await session.detach().catch(() => {}); return; }
        // No event parameters (including URLs) are collected.
        session.on('Page.windowOpen', monitor.opened);
        await session.send('Page.enable');
      } catch { monitor.failed = true; }
    })();
    const dismiss = (dialog: import('playwright').Dialog) => { void dialog.dismiss().catch(() => {}); };
    const popupOpened = (popup: Page) => {
      if (monitor.pending > 0) monitor.pending--;
      invalidateControls();
      pageStack.push(popup);
      page = popup;
      instrument(popup);
    };
    const navigated = (frame: import('playwright').Frame) => { documentGeneration++; if (frame === current.mainFrame()) invalidateControls(); };
    const frameChanged = () => { documentGeneration++; };
    const navigationRequested = (request: import('playwright').Request) => {
      if (!request.isNavigationRequest()) return;
      try { if (request.frame() === current.mainFrame()) invalidateControls(); }
      catch { invalidateControls(); } // A disappearing frame must not crash a session event listener.
    };
    const pageClosed = () => { invalidateControls(); selectActivePage(); };
    current.on('dialog', dismiss); current.on('popup', popupOpened);
    current.on('framenavigated', navigated); current.on('request', navigationRequested); current.on('close', pageClosed);
    current.on('frameattached', frameChanged); current.on('framedetached', frameChanged);
    listeners.push(() => { current.off('dialog', dismiss); current.off('popup', popupOpened); current.off('framenavigated', navigated); current.off('request', navigationRequested); current.off('close', pageClosed); current.off('frameattached', frameChanged); current.off('framedetached', frameChanged); });
  };
  const ensurePopupMonitor = async (current: Page) => {
    instrument(current);
    const monitor = popupMonitors.get(current)!;
    await monitor.ready;
    if (monitor.failed || !monitor.session || closed) throw new Error('The browser window could not be monitored safely.');
    return monitor;
  };
  const ensureActivePageMonitor = async () => {
    for (;;) {
      selectActivePage();
      const current = page;
      await ensurePopupMonitor(current);
      selectActivePage();
      if (current === page && !current.isClosed()) return;
      if (closed || page.isClosed()) throw new Error('This browser page is closed.');
    }
  };
  const popupBarrier = async (pages: Page[], deadline: number) => {
    for (const current of pages) {
      if (current.isClosed()) continue;
      const monitor = await ensurePopupMonitor(current);
      try {
        // The response and Page.windowOpen events share this CDP channel. Do not
        // race/abandon queued renderer work: completion must retain its barrier.
        await monitor.session!.send('Runtime.evaluate', { expression: 'void 0', returnByValue: true });
      } catch { if (!current.isClosed()) throw new Error('Password fields could not be cleared before handoff.'); }
      if (Date.now() >= deadline) throw new Error('Password fields could not be cleared before handoff.');
    }
    // A closed opener can still have an unresolved popup; never discard its
    // intent merely because its own page closed before the popup became public.
    if ([...popupMonitors.values()].some(monitor => monitor.pending > 0)) throw new Error('Password fields could not be cleared before handoff.');
  };
  const closeSession = async () => {
    if (closed) return;
    closed = true;
    for (const remove of listeners.splice(0)) remove();
    for (const monitor of popupMonitors.values()) monitor.session?.off('Page.windowOpen', monitor.opened);
    await pageControls?.clear();
    // Closing a connected Playwright browser disconnects; it does not terminate the agent's browser.
    if (owned) await context.close().catch(() => {});
    await browser.close().catch(() => {});
    // Disconnect first so a busy renderer cannot leave monitor setup queued
    // forever while cleanup is waiting for that same renderer to respond.
    for (const monitor of popupMonitors.values()) {
      await monitor.ready;
      await monitor.session?.detach().catch(() => {});
    }
    popupMonitors.clear();
    await proxy?.close();
  };
  instrument(page);
  pageControls = createPageControls(() => { selectActivePage(); return page; });
  if (owned) {
    const initialPage = page;
    try {
      // Arm the about:blank page before any destination script can open a
      // window whose first navigation Playwright has not surfaced yet.
      await ensurePopupMonitor(initialPage);
      await initialPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (error) { await closeSession(); throw error; }
  }
  return {
    cdpUrl,
    get pageUrl() { selectActivePage(); return page.url(); },
    async frame() {
      selectActivePage();
      if (closed || page.isClosed()) throw new Error('This browser page is closed.');
      await ensureActivePageMonitor();
      const image = await page.screenshot({ type: 'jpeg', quality: 65, timeout: 5000, animations: 'disabled' });
      const size = page.viewportSize() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      return { data: image.toString('base64'), ...size, url: page.url() };
    },
    async input(input) {
      selectActivePage();
      if (closed || page.isClosed()) throw new Error('This browser page is closed.');
      await ensureActivePageMonitor();
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
      await ensureActivePageMonitor();
      return pageControls!.inspect();
    },
    async prepareHandoff() {
      selectActivePage();
      await pageControls!.clear();
      if (closed || page.isClosed()) throw new Error('This browser page is closed.');
      // Clear residual password inputs on every still-open session page/frame before exposing a managed CDP endpoint.
      // This does not promise to erase secrets retained by the destination website's own JavaScript.
      const deadline = Date.now() + 3000;
      const livePages = () => (owned ? context.pages() : [...sessionPages]).filter(item => !item.isClosed());
      await popupBarrier(livePages(), deadline);
      const initialPopupGeneration = popupGeneration;
      for (;;) {
        if (Date.now() >= deadline) throw new Error('Password fields could not be cleared before handoff.');
        const pages = livePages();
        const frames = new Map(pages.map(current => [current, current.frames()]));
        const initialDocumentGeneration = documentGeneration;
        const stable = () => {
          const latest = livePages();
          return documentGeneration === initialDocumentGeneration && pages.length === latest.length && pages.every(current => {
            const before = frames.get(current)!; const after = current.frames();
            return latest.includes(current) && before.length === after.length && before.every(frame => after.includes(frame));
          });
        };
        for (const current of pages) await clearPagePasswords(current, deadline);
        await popupBarrier(livePages(), deadline);
        // Even if Playwright has already surfaced the window, an input handler
        // opening it during this clearing attempt requires an explicit retry.
        if (popupGeneration !== initialPopupGeneration) throw new Error('Password fields could not be cleared before handoff.');
        if (!stable()) continue;
        // A later frame/page's input handler can restore an earlier field.
        // Verify the complete stable set only after every clearing event has
        // settled; this pass dispatches no events and returns only booleans.
        for (const current of pages) await clearPagePasswords(current, deadline, false);
        await popupBarrier(livePages(), deadline);
        if (popupGeneration !== initialPopupGeneration) throw new Error('Password fields could not be cleared before handoff.');
        if (stable()) break;
      }
      selectActivePage();
      if (closed || page.isClosed()) throw new Error('This browser page is closed.');
    },
    close: closeSession,
  };
};
