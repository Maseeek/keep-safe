import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page, type Route } from 'playwright';
import { createOutboundProxy, validateTargetUrl, resolveDestination } from './network';
import { createPageControls } from './page-controls';
import { createLoginFormController } from './login-form';
import { chooseBrowser, launchChrome, type ChromeProcess } from './chrome';
import { findDesktopTools, openDesktopSession } from './desktop';
import { randomUUID } from 'node:crypto';
import type { BrowserTab, EditableKind, FormState, FormSubmitValue, NavigationDirection, PageControlsSnapshot, ViewportRequest } from '../../shared/src/protocol';
export { validateTargetUrl } from './network';

export interface BrowserFrame {
  data: string; width: number; height: number; url: string; navigationAvailable?: boolean;
  /** This browser takes `touch` and `mouse` input, so the phone forwards raw gestures. */
  gestures?: boolean;
  /** The image includes the browser's own address bar, which shows the real
   * address. `url` is then only the address the session started on. */
  addressInView?: boolean;
}
export interface BrowserSession {
  readonly cdpUrl?: string;
  readonly pageUrl?: string;
  frame(): Promise<BrowserFrame>;
  /** A sharper image of the page as it is now. Sent once a live stream goes
   * quiet, so text is crisp when nothing moves while moving frames stay small.
   * Resolves to nothing when this browser has no sharper image to give. */
  still?(): Promise<BrowserFrame | undefined>;
  /** May report what the action left focused, so the phone can raise its keyboard. */
  input(input: { type: string; [key: string]: unknown }): Promise<FocusState | void>;
  /** Pushes a frame whenever the page repaints. The browser sends the next one
   * only after the listener settles, so a slow phone link drops frames instead
   * of queuing them. Resolves to a function that stops the stream. */
  stream?(listener: (frame: BrowserFrame) => Promise<void> | void): Promise<() => Promise<void>>;
  /** The windows of this session, oldest first. */
  tabs?(): Promise<BrowserTab[]>;
  selectTab?(id: string): Promise<void>;
  /** Closes one window. The last one cannot be closed. */
  closeTab?(id: string): Promise<void>;
  /** Calls back when a window opened, closed, moved to another page or became the active one. */
  onTabs?(listener: () => void): () => void;
  /** Text the owner has selected on the active page, at most 4096 characters.
   * Text inside a form field is never part of it. */
  selection?(): Promise<string>;
  /** Lifts a finger or mouse button the owner left down on the page. Returns
   * nothing when none is held. */
  releasePointers?(): Promise<void> | void;
  /** Managed browsers only: match the controlling phone's screen. */
  resize?(viewport: ViewportRequest): Promise<void>;
  inspectControls?(options?: { includeFrames?: boolean }): Promise<PageControlsSnapshot>;
  /** Value-free description of the current login/2FA step on the active page. */
  inspectForm?(): Promise<FormState>;
  /** Fills and submits the current login/2FA step with trusted input. Never logs or returns values. */
  submitForm?(values: FormSubmitValue[], expectedOrigin?: string): Promise<{ ok: boolean; message?: string; state: FormState }>;
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
/** Reads only what is selected in the document. A range cannot reach into a
 * form field, so typed text, including a password, is never returned. */
const selectionSource = String.raw`() => {
  try {
    const selection = window.getSelection();
    if (!selection) return '';
    let text = '';
    for (let index = 0; index < selection.rangeCount && index < 16 && text.length < 4096; index++) text += (text ? '\n' : '') + selection.getRangeAt(index).toString();
    return text.slice(0, 4096);
  } catch { return ''; }
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
interface ScreencastFrame { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number; pageScaleFactor: number } }

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
  if ((await chooseBrowser()).kind === 'chrome') return true;
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

/** Chrome's own interface, such as the address bar's suggestion popup, which
 * the debugging protocol lists beside the website's pages. */
const browserInterface = (url: string) => /^(chrome|chrome-untrusted|devtools):/.test(url);

export const openBrowser: BrowserFactory = async request => {
  if (!request.cdpUrl) {
    const choice = await chooseBrowser();
    const tools = choice.kind === 'chrome' ? await findDesktopTools() : undefined;
    if (choice.kind === 'chrome' && tools) {
      await resolveDestination(new URL(request.url).hostname, request.allowLocalUrls);
      const proxy = await createOutboundProxy(request.allowLocalUrls);
      try {
        const session = await openDesktopSession({
          url: request.url, viewport: request.viewport, executable: choice.executable, proxyUrl: proxy.url, tools,
          handoff: async ({ env, profile, size }) => {
            const chrome = await launchChrome({ executable: choice.executable, proxyUrl: proxy.url, ...size, profile, env, restore: true });
            return openManaged(request, { proxy, chrome });
          },
        });
        const close = session.close;
        // The proxy outlives the sign-in Chrome: the agent's Chrome uses it too.
        return Object.assign(session, { close: async () => { await close(); await proxy.close(); } });
      } catch { await proxy.close(); /* The tools are there but did not start: use Chrome with debugging. */ }
    }
  }
  return openManaged(request);
};

/** A browser this bridge controls through Chromium's debugging protocol. With
 * `handed`, it takes over a Chrome the owner signed in with and the pages that
 * Chrome reopened, instead of starting one. */
async function openManaged({ url, cdpUrl, allowLocalUrls, viewport }: Parameters<BrowserFactory>[0], handed?: { proxy: Awaited<ReturnType<typeof createOutboundProxy>>; chrome: ChromeProcess }): Promise<BrowserSession> {
  let browser!: Browser;
  let context!: BrowserContext;
  let page!: Page;
  let owned = false;
  let proxy: Awaited<ReturnType<typeof createOutboundProxy>> | undefined;
  /** Set when the session runs the owner's installed Chrome as a window. */
  let chrome: ChromeProcess | undefined;
  /** The page is already where the owner left it, so it is not loaded again. */
  let restored = false;
  const size = { width: viewport?.width ?? 390, height: viewport?.height ?? 720 };
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
    if (!handed) await resolveDestination(new URL(url).hostname, allowLocalUrls);
    proxy = handed?.proxy ?? await createOutboundProxy(allowLocalUrls);
    const outbound = proxy;
    const guard = async (route: Route) => {
      try { const target = new URL(validateTargetUrl(route.request().url(), allowLocalUrls)); await resolveDestination(target.hostname, allowLocalUrls); await route.continue(); } catch { await route.abort('blockedbyclient'); }
    };
    const choice = handed ? undefined : await chooseBrowser();
    if (handed || choice?.kind === 'chrome') {
      // Any failure here falls back to the bundled browser below, except for a
      // handed-over Chrome: its cookies are the owner's sign-in.
      try {
        const started = handed?.chrome ?? await launchChrome({ executable: (choice as { executable: string }).executable, proxyUrl: outbound.url, scale: viewport?.scale ?? 1, ...size });
        try {
          const connected = await chromium.connectOverCDP(started.endpoint, { timeout: 10_000 });
          const opened = connected.contexts()[0];
          if (!opened) throw new Error('Google Chrome has no window.');
          await opened.route('**/*', guard);
          const control = await connected.newBrowserCDPSession();
          await control.send('Browser.setDownloadBehavior', { behavior: 'deny' });
          await control.detach();
          // The page the owner was last on is the newest one Chrome reopened.
          browser = connected; context = opened; page = (handed ? opened.pages().filter(item => item.url() !== 'about:blank' && !browserInterface(item.url())).at(-1) : undefined) ?? opened.pages().find(item => !browserInterface(item.url())) ?? await opened.newPage();
          cdpUrl = `http://127.0.0.1:${started.port}`;
          chrome = started; owned = true; restored = !!handed && page.url() !== 'about:blank';
        } catch (error) { await started.close(); throw error; }
      } catch (error) { if (handed) throw error; /* Chrome is missing a display or did not start. */ }
    }
    // A free port can be taken by another program between choosing it and
    // Chromium binding it. The agent must never be handed an address that
    // belongs to something else, so each launch proves the port is its own.
    const launch = async () => {
      const port = await freePort();
      const started = await chromium.launch({
        headless: true, proxy: { server: outbound.url },
        // The bridge closes its own browsers on shutdown. Playwright's signal
        // handlers would close Chromium underneath that cleanup and leave it
        // waiting on a browser that is already gone.
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        ...(process.env.KEEP_SAFE_CHROMIUM_PATH ? { executablePath: process.env.KEEP_SAFE_CHROMIUM_PATH } : {}),
        // The live stream is captured at the window's real pixel density, so
        // the browser starts at the phone's density rather than emulating it.
        args: [`--force-device-scale-factor=${viewport?.scale ?? 1}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      });
      try {
        // Sized to the phone that will approve the request, so the website lays
        // out for that screen. The browser keeps its desktop identity: websites
        // still see ordinary Chromium, and the agent gets the same browser back.
        const opened = await started.newContext({
          viewport: viewport ? { width: viewport.width, height: viewport.height } : { width: 390, height: 720 },
          deviceScaleFactor: viewport?.scale ?? 1, hasTouch: viewport?.touch === true,
          acceptDownloads: false, serviceWorkers: 'block',
        });
        // Incognito contexts keep website cookies in memory. No tracing/video/storage-state files.
        await opened.route('**/*', guard);
        const first = await opened.newPage();
        const probe = await opened.newCDPSession(first);
        const { targetInfo } = await probe.send('Target.getTargetInfo');
        await probe.detach();
        let listed: unknown;
        // A refused connection only means Chromium is still starting its listener.
        for (let attempt = 0; attempt < 20 && listed === undefined; attempt++) {
          try { listed = await (await fetch(`http://127.0.0.1:${port}/json/list`, { redirect: 'error', signal: AbortSignal.timeout(3000) })).json().catch(() => null); }
          catch { await new Promise<void>(resolve => { setTimeout(resolve, 100); }); }
        }
        if (!Array.isArray(listed) || !listed.some(item => (item as { id?: unknown } | null)?.id === targetInfo.targetId)) { await started.close(); return undefined; }
        return { started, opened, first, port };
      } catch (error) { await started.close().catch(() => {}); throw error; }
    };
    if (!owned) try {
      let launched: Awaited<ReturnType<typeof launch>>;
      for (let attempt = 0; attempt < 4 && !launched; attempt++) launched = await launch();
      if (!launched) throw new Error('The browser could not open its private debugging port.');
      browser = launched.started; context = launched.opened; page = launched.first;
      cdpUrl = `http://127.0.0.1:${launched.port}`;
      owned = true;
    } catch (error) { await proxy.close(); throw error; }
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
  /** The live stream follows whichever page the owner is looking at. */
  let streaming: { retarget(): void } | undefined;
  const tabIds = new Map<Page, string>([[page, randomUUID()]]);
  const tabListeners = new Set<() => void>();
  const tabsChanged = () => { for (const listener of tabListeners) { try { listener(); } catch { /* A listener never breaks the session. */ } } };
  const selectActivePage = () => {
    for (let index = pageStack.length - 1; index >= 0; index--) {
      if (!pageStack[index].isClosed()) {
        if (page !== pageStack[index]) { invalidateControls(); page = pageStack[index]; streaming?.retarget(); tabsChanged(); }
        return;
      }
    }
  };
  // Chromium reads input coordinates in unzoomed page pixels. Each streamed
  // frame reports the zoom, so a point on the image lands where it shows.
  const pageScale = new WeakMap<Page, number>();
  // A finger or mouse button held on the page. Released before any handback,
  // so the agent never receives a browser that is mid-drag.
  const held: { touch?: { page: Page; session: CDPSession; clock?: { phone: number; bridge: number; last: number } }; mouse?: { page: Page; clicks: number }; lastPress?: { at: number; x: number; y: number; clicks: number } } = {};
  const releasePointers = async () => {
    const touch = held.touch; held.touch = undefined;
    if (touch && !touch.page.isClosed()) await touch.session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(() => {});
    const mouse = held.mouse; held.mouse = undefined;
    if (mouse && !mouse.page.isClosed()) await mouse.page.mouse.up({ clickCount: mouse.clicks }).catch(() => {});
  };
  /** Chrome as a window is sized page by page: its window cannot be as narrow
   * as a phone. The screen it reports stays the computer's own. */
  const fit = async (session: CDPSession) => {
    if (!chrome) return;
    await session.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
    if (viewport?.touch) await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    // Website service workers stay out of page loads, so the Reload guard sees every document request.
    await session.send('Network.setBypassServiceWorker', { bypass: true });
  };
  const instrument = (current: Page) => {
    if (popupMonitors.has(current)) return;
    sessionPages.add(current);
    if (!tabIds.has(current)) tabIds.set(current, randomUUID());
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
        await fit(session);
      } catch { monitor.failed = true; }
    })();
    const dismiss = (dialog: import('playwright').Dialog) => { void dialog.dismiss().catch(() => {}); };
    const popupOpened = (popup: Page) => {
      if (monitor.pending > 0) monitor.pending--;
      invalidateControls();
      pageStack.push(popup);
      page = popup;
      instrument(popup);
      streaming?.retarget();
      tabsChanged();
    };
    const navigated = (frame: import('playwright').Frame) => { documentGeneration++; if (frame === current.mainFrame()) { invalidateControls(); tabsChanged(); } };
    const frameChanged = () => { documentGeneration++; };
    const navigationRequested = (request: import('playwright').Request) => {
      if (!request.isNavigationRequest()) return;
      try { if (request.frame() === current.mainFrame()) invalidateControls(); }
      catch { invalidateControls(); } // A disappearing frame must not crash a session event listener.
    };
    const pageClosed = () => { invalidateControls(); selectActivePage(); tabsChanged(); };
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
      if (owned && !chrome) await context.close().catch(() => {});
      await browser.close().catch(() => {});
      // Ends the Chrome window and deletes its temporary profile and cookies.
      await chrome?.close();
      // Disconnect first so a busy renderer cannot leave monitor setup queued
      // forever while cleanup is waiting for that same renderer to respond.
      for (const monitor of popupMonitors.values()) {
        await monitor.ready;
        await monitor.session?.detach().catch(() => {});
      }
      popupMonitors.clear();
      // A handed-over Chrome's proxy belongs to the desktop session.
      if (!handed) await proxy?.close();
    })();
    return closingSession;
  };
  instrument(page);
  pageControls = createPageControls(() => { selectActivePage(); return page; });
  const loginForm = createLoginFormController(() => { selectActivePage(); return page; }, url);
  if (owned) {
    const initialPage = page;
    try {
      // Arm the about:blank page before any destination script can open a
      // window whose first navigation Playwright has not surfaced yet.
      await ensurePopupMonitor(initialPage);
      if (!restored) await initialPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
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
  const capture = async (quality: number, optimizeForSpeed: boolean): Promise<BrowserFrame> => {
    selectActivePage();
    if (closed || page.isClosed()) throw new Error('This browser page is closed.');
    const target = page; const source = target.url(); const generation = documentGeneration; const popups = popupGeneration;
    const monitor = await ensurePopupMonitor(target);
    // Captured as the page is: the text caret stays visible and animations
    // keep running. Chromium's own capture is used directly because a
    // Playwright screenshot of a Chrome window can stall while the page navigates.
    // A capture asked for at the instant a page is replaced may never be
    // answered. Ask once more after a moment and take whichever answers,
    // so a busy computer is not mistaken for a broken view.
    const session = monitor.session!;
    const image = await new Promise<{ data: string }>((resolve, reject) => {
      let settled = false;
      const finish = (work: () => void) => { if (settled) return; settled = true; clearTimeout(again); clearTimeout(limit); work(); };
      const ask = () => {
        session.send('Page.captureScreenshot', { format: 'jpeg', quality, optimizeForSpeed }).then(result => finish(() => resolve(result)), error => {
          // Chromium says this when the page has nothing painted yet, such as just after opening.
          if (!settled && /Unable to capture screenshot/.test(String((error as Error | null)?.message))) setTimeout(() => { if (!settled) ask(); }, 100);
          else finish(() => reject(error));
        });
      };
      const again = setTimeout(ask, 1200);
      const limit = setTimeout(() => finish(() => reject(new Error('The browser did not produce an image.'))), 5000);
      ask();
    });
    const shown = chrome ? { ...size } : target.viewportSize() ?? await target.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    selectActivePage();
    if (target !== page || target.isClosed() || target.url() !== source || generation !== documentGeneration || popups !== popupGeneration) throw new BrowserFrameChangedError();
    return { data: image.data, ...shown, url: source, navigationAvailable: owned, gestures: true };
  };
  return {
    cdpUrl,
    get pageUrl() { selectActivePage(); return page.url(); },
    frame: () => capture(62, true),
    still: () => capture(80, false),
    async stream(listener) {
      if (streaming || closed) throw new Error('This browser cannot be streamed right now.');
      let stopped = false;
      let current: { page: Page; session: CDPSession; received: (event: ScreencastFrame) => void } | undefined;
      const detach = async () => {
        const previous = current; current = undefined;
        if (!previous) return;
        previous.session.off('Page.screencastFrame', previous.received);
        if (!previous.page.isClosed() && !closed) await previous.session.send('Page.stopScreencast').catch(() => {});
      };
      const attach = async () => {
        await detach();
        if (stopped || closed) return;
        selectActivePage();
        const target = page;
        if (target.isClosed()) return;
        const session = (await ensurePopupMonitor(target)).session!;
        const received = (event: ScreencastFrame) => { void (async () => {
          try {
            if (stopped || closed || current?.session !== session || target !== page || target.isClosed()) return;
            pageScale.set(target, event.metadata.pageScaleFactor > 0 ? event.metadata.pageScaleFactor : 1);
            await listener({ data: event.data, width: Math.round(event.metadata.deviceWidth), height: Math.round(event.metadata.deviceHeight), url: target.url(), navigationAvailable: owned, gestures: true });
          } catch { /* A frame the phone could not take is simply skipped. */ }
          // Chromium holds the next frame until this one is acknowledged.
          finally { await session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {}); }
        })(); };
        current = { page: target, session, received };
        session.on('Page.screencastFrame', received);
        // Caps keep a large desktop view from sending more pixels than a phone link carries well.
        await session.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1600, maxHeight: 2400, everyNthFrame: 1 });
      };
      // Registered first: a window that opens while the stream starts is followed too.
      let work: Promise<void> = Promise.resolve();
      streaming = { retarget() { work = work.then(attach).catch(() => {}); } };
      const first = attach();
      work = first.catch(() => {});
      try { await first; } catch (error) { stopped = true; streaming = undefined; await detach().catch(() => {}); throw error; }
      return async () => {
        if (stopped) return;
        stopped = true; streaming = undefined;
        work = work.then(detach).catch(() => {});
        await work;
      };
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
      else if (input.type === 'touch') {
        const target = page; const session = popupMonitors.get(target)!.session!;
        const scale = pageScale.get(target) ?? 1;
        const touchPoints = [{ x: (input.x as number) / scale, y: (input.y as number) / scale, id: 0, radiusX: 8, radiusY: 8, force: 1 }];
        // The phone's timing, moved onto this computer's clock from the start of
        // the gesture. Always in order and never later than now.
        const phoneTime = typeof input.t === 'number' && Number.isFinite(input.t) ? input.t : undefined;
        const when = (clock: { phone: number; bridge: number; last: number } | undefined) => {
          if (!clock || phoneTime === undefined) return {};
          clock.last = Math.min(Date.now() / 1000, Math.max(clock.last, clock.bridge + (phoneTime - clock.phone) / 1000));
          return { timestamp: clock.last };
        };
        if (input.phase === 'start') {
          await releasePointers();
          const now = Date.now() / 1000;
          held.touch = { page: target, session, ...(phoneTime !== undefined ? { clock: { phone: phoneTime, bridge: now, last: now } } : {}) };
          await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints, ...when(held.touch.clock) });
        } else if (held.touch?.page !== target) await releasePointers(); // A gesture never continues on another window.
        else if (input.phase === 'move') await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints, ...when(held.touch.clock) });
        else {
          const clock = held.touch.clock;
          held.touch = undefined;
          await session.send('Input.dispatchTouchEvent', { type: input.phase === 'end' ? 'touchEnd' : 'touchCancel', touchPoints: [], ...when(clock) });
          if (input.phase === 'end' && input.tap === true) { selectActivePage(); return focusState(page); }
        }
      }
      else if (input.type === 'mouse') {
        const target = page; const scale = pageScale.get(target) ?? 1;
        const x = (input.x as number) / scale; const y = (input.y as number) / scale;
        if (held.mouse && held.mouse.page !== target) await releasePointers();
        if (input.phase === 'move') await target.mouse.move(x, y);
        else if (input.phase === 'down') {
          await releasePointers();
          // Quick presses in one spot count up, so a double click selects a word.
          const last = held.lastPress; const time = Date.now();
          const clicks = last && time - last.at < 400 && Math.hypot(x - last.x, y - last.y) < 6 && last.clicks < 3 ? last.clicks + 1 : 1;
          held.lastPress = { at: time, x, y, clicks };
          await target.mouse.move(x, y);
          held.mouse = { page: target, clicks };
          await target.mouse.down({ clickCount: clicks });
        } else if (held.mouse) {
          const clicks = held.mouse.clicks; held.mouse = undefined;
          // A cancel lets go where the pointer already is. Moving first would
          // stretch a selection or drag to wherever the cancel pointed.
          if (input.phase === 'up') await target.mouse.move(x, y);
          await target.mouse.up({ clickCount: clicks });
          if (input.phase === 'up' && input.tap === true) { selectActivePage(); return focusState(page); }
        }
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
        size.width = next.width; size.height = next.height;
        for (const current of context.pages()) {
          if (current.isClosed()) continue;
          if (!chrome) await current.setViewportSize({ width: next.width, height: next.height });
          else { const session = popupMonitors.get(current)?.session; if (session) await fit(session); }
        }
      },
    } : {}),
    async inspectControls(options) {
      selectActivePage();
      if (closed || page.isClosed()) throw new Error('This browser page is closed.');
      await ensureActivePageMonitor();
      return pageControls!.inspect(options);
    },
    async inspectForm() {
      selectActivePage();
      if (closed || page.isClosed()) throw new Error('This browser page is closed.');
      return loginForm.inspect();
    },
    async submitForm(values, expectedOrigin) {
      selectActivePage();
      if (closed || page.isClosed()) throw new Error('This browser page is closed.');
      await ensureActivePageMonitor();
      await releasePointers();
      return loginForm.submit(values, expectedOrigin);
    },
    ...(owned ? { navigate } : {}),
    releasePointers() { if (!closed && (held.touch || held.mouse)) return releasePointers(); },
    async tabs() {
      selectActivePage();
      const open = [...sessionPages].filter(item => !item.isClosed());
      return Promise.all(open.map(async item => {
        // A page that does not answer still gets listed, without a title.
        const title = await Promise.race([item.title().catch(() => ''), new Promise<string>(resolve => { setTimeout(() => resolve(''), 500); })]);
        let origin = '';
        try { const address = new URL(item.url()); if (['http:', 'https:'].includes(address.protocol)) origin = address.origin; } catch { /* No web address yet. */ }
        return { id: tabIds.get(item)!, title: title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80), origin, active: item === page };
      }));
    },
    async selectTab(id) {
      const target = [...sessionPages].find(item => tabIds.get(item) === id && !item.isClosed());
      if (closed || !target) throw new Error('That window is no longer open.');
      if (target === page) return;
      await releasePointers();
      const index = pageStack.indexOf(target);
      if (index >= 0) pageStack.splice(index, 1);
      pageStack.push(target);
      selectActivePage();
      // A Chrome window paints only its front tab.
      await target.bringToFront().catch(() => {});
    },
    async closeTab(id) {
      const target = [...sessionPages].find(item => tabIds.get(item) === id && !item.isClosed());
      if (closed || !target) throw new Error('That window is no longer open.');
      if ([...sessionPages].filter(item => !item.isClosed()).length < 2) throw new Error('The last window stays open.');
      if (target === page) await releasePointers();
      await target.close();
      selectActivePage();
      if (!page.isClosed()) await page.bringToFront().catch(() => {});
    },
    onTabs(listener) { tabListeners.add(listener); return () => { tabListeners.delete(listener); }; },
    async selection() {
      selectActivePage();
      if (closed || page.isClosed()) throw new Error('This browser page is closed.');
      for (const frame of page.frames().slice(0, 24)) {
        const text = await frame.evaluate(`(${selectionSource})()`).catch(() => '') as string;
        if (typeof text === 'string' && text) return text.slice(0, 4096);
      }
      return '';
    },
    async prepareHandoff() {
      selectActivePage();
      await releasePointers();
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
