import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page, type Route } from 'playwright';
import { createOutboundProxy, validateTargetUrl, resolveDestination } from './network';
import { createPageControls } from './page-controls';
import type { EditableKind, NavigationDirection, PageControlsSnapshot, ViewportRequest } from '../../shared/src/protocol';
export { validateTargetUrl } from './network';

export interface BrowserFrame { data: string; width: number; height: number; url: string; navigationAvailable?: boolean }
export interface BrowserSession {
  readonly cdpUrl?: string;
  readonly pageUrl?: string;
  frame(): Promise<BrowserFrame>;
  /** May report what the action left focused, so the phone can raise its keyboard. */
  input(input: { type: string; [key: string]: unknown }): Promise<FocusState | void>;
  /** Managed browsers only: match the controlling phone's screen. */
  resize?(viewport: ViewportRequest): Promise<void>;
  inspectControls?(options?: { includeFrames?: boolean }): Promise<PageControlsSnapshot>;
  navigate?(direction: NavigationDirection): Promise<void>;
  prepareHandoff?(): Promise<void>;
  close(): Promise<void>;
}
export interface FocusState { editable: boolean; kind?: EditableKind }
export type BrowserFactory = (input: { url: string; cdpUrl?: string; allowLocalUrls: boolean; viewport?: ViewportRequest }) => Promise<BrowserSession>;

/** Reads only the focused element's type. No value, label or address leaves the page. */
const focusStateSource = String.raw`() => {
  let element = document.activeElement;
  for (let depth = 0; element && element.shadowRoot && element.shadowRoot.activeElement && depth < 24; depth++) element = element.shadowRoot.activeElement;
  if (!element || element === document.body || element === document.documentElement) return { editable: false };
  const tag = element.tagName;
  if (tag === 'IFRAME' || tag === 'FRAME') return { frame: true };
  if (element.isContentEditable) return { editable: true, kind: 'text' };
  if (tag === 'TEXTAREA') return { editable: !element.readOnly && !element.disabled, kind: 'text' };
  if (tag !== 'INPUT' || element.readOnly || element.disabled) return { editable: false };
  const type = (element.getAttribute('type') || 'text').toLowerCase();
  if (['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden'].includes(type)) return { editable: false };
  const mode = (element.getAttribute('inputmode') || '').toLowerCase();
  const hint = (element.getAttribute('autocomplete') || '').toLowerCase();
  const kind = type === 'password' ? 'password' : type === 'email' || mode === 'email' ? 'email' : type === 'tel' || mode === 'tel' ? 'tel'
    : type === 'number' || mode === 'numeric' || mode === 'decimal' || hint === 'one-time-code' ? 'numeric'
    : type === 'url' || mode === 'url' ? 'url' : type === 'search' || mode === 'search' ? 'search' : 'text';
  return { editable: true, kind };
}`;
const focusedFrameSource = String.raw`() => {
  let element = document.activeElement;
  for (let depth = 0; element && element.shadowRoot && element.shadowRoot.activeElement && depth < 24; depth++) element = element.shadowRoot.activeElement;
  return element;
}`;
async function focusState(page: Page): Promise<FocusState | undefined> {
  try {
    let frame = page.mainFrame();
    for (let depth = 0; depth < 5; depth++) {
      const state = await frame.evaluate(`(${focusStateSource})()`) as { editable?: boolean; kind?: EditableKind; frame?: boolean };
      if (!state.frame) return { editable: state.editable === true, ...(state.editable && state.kind ? { kind: state.kind } : {}) };
      const handle = await frame.evaluateHandle(`(${focusedFrameSource})()`);
      const element = handle.asElement() as import('playwright').ElementHandle<Element> | null;
      const child = element ? await element.contentFrame() : null;
      await handle.dispose().catch(() => {});
      if (!child) return { editable: false };
      frame = child;
    }
    return { editable: false };
  } catch { return undefined; } // A navigating page simply reports nothing.
}

export class BrowserNavigationError extends Error {
  constructor(readonly reason: 'form' | 'timeout' | 'history' | 'changed' | 'failed') {
    super('The browser navigation did not complete.');
  }
}
export class BrowserFrameChangedError extends Error {}

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

export const openBrowser: BrowserFactory = async ({ url, cdpUrl, allowLocalUrls, viewport }) => {
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
        // The bridge closes its own browsers on shutdown. Playwright's signal
        // handlers would close Chromium underneath that cleanup and leave it
        // waiting on a browser that is already gone.
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        ...(process.env.KEEP_SAFE_CHROMIUM_PATH ? { executablePath: process.env.KEEP_SAFE_CHROMIUM_PATH } : {}),
        args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      });
    } catch (error) { await proxy.close(); throw error; }
    owned = true;
    cdpUrl = `http://127.0.0.1:${port}`;
    try {
      // Sized to the phone that will approve the request, so the website lays
      // out for that screen. The browser keeps its desktop identity: websites
      // still see ordinary Chromium, and the agent gets the same browser back.
      context = await browser.newContext({
        viewport: viewport ? { width: viewport.width, height: viewport.height } : { width: 390, height: 720 },
        deviceScaleFactor: viewport?.scale ?? 1, hasTouch: viewport?.touch === true,
        acceptDownloads: false, serviceWorkers: 'block',
      });
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
  let closingSession: Promise<void> | undefined;
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
  const closeSession = () => {
    if (closingSession) return closingSession;
    closed = true;
    closingSession = (async () => {
      for (const remove of listeners.splice(0)) remove();
      for (const monitor of popupMonitors.values()) monitor.session?.off('Page.windowOpen', monitor.opened);
      // The browser is closing either way, so a control channel that cannot be
      // detached must not hold up shutdown.
      await Promise.race([pageControls?.clear(), new Promise<void>(resolve => { setTimeout(resolve, 2000).unref(); })]);
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
    })();
    return closingSession;
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
  const navigate = async (direction: NavigationDirection) => {
    selectActivePage();
    const target = page;
    if (!owned || closed || target.isClosed()) throw new BrowserNavigationError('failed');
    const source = target.url();
    const initialPopupGeneration = popupGeneration;
    const monitor = await ensurePopupMonitor(target);
    const session = monitor.session!;
    let posted = false; let timedOut = false; let loading = false; let started = false; let issued = false;
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    let stopWork: Promise<unknown> | undefined;
    const stop = () => { stopWork ??= session.send('Page.stopLoading'); return stopWork; };
    const guard = async (route: Route) => {
      const request = route.request();
      if (request.isNavigationRequest() && !['GET', 'HEAD'].includes(request.method())) {
        posted = true; await route.abort('blockedbyclient');
      } else await route.fallback();
    };
    let mainFrameId = '';
    let preparationIntent = false;
    const requested = (event: { frameId: string }) => { if (!issued && event.frameId === mainFrameId) preparationIntent = true; };
    const began = (event: { frameId: string }) => { if (event.frameId === mainFrameId) { loading = true; if (issued) started = true; } };
    const ended = (event: { frameId: string }) => { if (event.frameId === mainFrameId) { loading = false; if (issued && started) finish(); } };
    const within = (event: { frameId: string }) => { if (issued && direction !== 'reload' && event.frameId === mainFrameId) finish(); };
    const timer = setTimeout(() => { timedOut = true; void stop().catch(() => {}); finish(); }, 10_000);
    const history = async () => {
      // Only numeric entry identities survive this private protocol response.
      // No URL, title, body or browser history is returned to the phone.
      const result = await session.send('Page.getNavigationHistory');
      if (result.entries.length > 256) throw new BrowserNavigationError('history');
      const offset = direction === 'back' ? -1 : direction === 'forward' ? 1 : 0;
      return { current: result.entries[result.currentIndex]?.id, target: result.entries[result.currentIndex + offset]?.id, length: result.entries.length };
    };
    try {
      await context.route('**/*', guard);
      await pageControls!.clear();
      // Stop any old loading request before arming completion for this action.
      await session.send('Page.stopLoading');
      await session.send('Runtime.evaluate', { expression: 'void 0', returnByValue: true });
      const tree = await session.send('Page.getFrameTree');
      mainFrameId = tree.frameTree.frame.id;
      const loader = tree.frameTree.frame.loaderId;
      session.on('Page.frameRequestedNavigation', requested);
      session.on('Page.frameStartedLoading', began);
      session.on('Page.frameStoppedLoading', ended);
      session.on('Page.navigatedWithinDocument', within);
      const before = await history();
      if (before.target === undefined) throw new BrowserNavigationError('history');
      const generation = documentGeneration;
      await clearPagePasswords(target, Date.now() + 3000);
      await session.send('Runtime.evaluate', { expression: 'void 0', returnByValue: true });
      const after = await history();
      const latest = await session.send('Page.getFrameTree');
      selectActivePage();
      if (timedOut) throw new BrowserNavigationError('timeout');
      if (posted) throw new BrowserNavigationError('form');
      if (closed || target.isClosed() || page !== target || target.url() !== source ||
          popupGeneration !== initialPopupGeneration || documentGeneration !== generation || preparationIntent ||
          latest.frameTree.frame.loaderId !== loader || before.current !== after.current || before.target !== after.target || before.length !== after.length)
        throw new BrowserNavigationError('changed');
      issued = true;
      // Native history helpers re-read history after password clearing. Use the
      // captured browser-owned numeric entry instead of recomputing a target.
      if (direction === 'reload') await session.send('Page.reload', { loaderId: loader });
      else await session.send('Page.navigateToHistoryEntry', { entryId: before.target });
      await finished;
      if (timedOut) await stop();
      await session.send('Runtime.evaluate', { expression: 'void 0', returnByValue: true });
      if (loading) { await closeSession(); throw new BrowserNavigationError('failed'); }
      selectActivePage();
      if (timedOut) throw new BrowserNavigationError('timeout');
      if (posted) throw new BrowserNavigationError('form');
      if (direction !== 'reload' && (await history()).current !== before.target) throw new BrowserNavigationError('changed');
      if (closed || target.isClosed() || target !== page || popupGeneration !== initialPopupGeneration) throw new BrowserNavigationError('changed');
    } catch (error) {
      // No wait is abandoned. Stop is browser-owned cancellation; the renderer
      // barrier and observed loading state must settle before method-guard removal.
      if (!closed && !target.isClosed()) {
        try {
          await stop();
          await session.send('Runtime.evaluate', { expression: 'void 0', returnByValue: true });
          if (loading) await closeSession();
        } catch { await closeSession(); }
      }
      throw error instanceof BrowserNavigationError ? error : new BrowserNavigationError(posted ? 'form' : timedOut ? 'timeout' : 'failed');
    } finally {
      clearTimeout(timer);
      if (stopWork) await stopWork.catch(() => {});
      session.off('Page.frameRequestedNavigation', requested);
      session.off('Page.frameStartedLoading', began);
      session.off('Page.frameStoppedLoading', ended);
      session.off('Page.navigatedWithinDocument', within);
      await pageControls!.clear();
      await context.unroute('**/*', guard).catch(() => {});
    }
  };
  return {
    cdpUrl,
    get pageUrl() { selectActivePage(); return page.url(); },
    async frame() {
      selectActivePage();
      if (closed || page.isClosed()) throw new Error('This browser page is closed.');
      const target = page; const source = target.url(); const generation = documentGeneration; const popups = popupGeneration;
      await ensurePopupMonitor(target);
      // The text caret stays visible and page animations keep running: this is a
      // live view, and freezing either makes typing feel unresponsive.
      const image = await target.screenshot({ type: 'jpeg', quality: 62, timeout: 5000, caret: 'initial' });
      const size = target.viewportSize() ?? await target.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      selectActivePage();
      if (target !== page || target.isClosed() || target.url() !== source || generation !== documentGeneration || popups !== popupGeneration) throw new BrowserFrameChangedError();
      return { data: image.toString('base64'), ...size, url: source, navigationAvailable: owned };
    },
    async input(input) {
      selectActivePage();
      if (closed || page.isClosed()) throw new Error('This browser page is closed.');
      await ensureActivePageMonitor();
      if (input.type === 'click') { await page.mouse.click(input.x as number, input.y as number); selectActivePage(); return focusState(page); }
      else if (input.type === 'scroll') {
        // Position wheel input without activating the target. Both operations
        // remain inside the owner's input/handback barrier. Older clients omit it.
        const target = page;
        if (typeof input.x === 'number' && typeof input.y === 'number') {
          const source = target.url();
          await target.mouse.move(input.x, input.y);
          selectActivePage();
          if (target !== page || target.isClosed() || target.url() !== source) throw new Error('The browser changed before scrolling. Try again.');
        }
        // Never re-read the mutable active page after an awaited mouse move.
        await target.mouse.wheel(input.deltaX as number, input.deltaY as number);
      }
      // One typed character goes through real key events, which single-digit
      // code boxes and similar widgets listen for. Longer text is inserted whole.
      else if (input.type === 'text') { if ([...(input.text as string)].length === 1 && input.text !== '\n' && input.text !== '\r') await page.keyboard.type(input.text as string); else await page.keyboard.insertText(input.text as string); }
      else if (input.type === 'key') {
        await page.keyboard.press(input.key as string);
        if (['Tab', 'Shift+Tab', 'Enter'].includes(input.key as string)) { selectActivePage(); return focusState(page); }
      }
      else if (input.type === 'focus') {
        if (typeof input.snapshotId !== 'string' || typeof input.controlId !== 'string') throw new Error('Choose a control from the current inspection.');
        await pageControls!.focus(input.snapshotId, input.controlId);
        return focusState(page);
      }
    },
    ...(owned ? {
      async resize(next: ViewportRequest) {
        if (closed) return;
        for (const current of context.pages()) if (!current.isClosed()) await current.setViewportSize({ width: next.width, height: next.height });
      },
    } : {}),
    async inspectControls(options) {
      selectActivePage();
      if (closed || page.isClosed()) throw new Error('This browser page is closed.');
      await ensureActivePageMonitor();
      return pageControls!.inspect(options);
    },
    ...(owned ? { navigate } : {}),
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
