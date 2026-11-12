import { timingSafeEqual, randomUUID, randomInt } from 'node:crypto';
import { createServer, type ClientRequest, type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { readFile, stat, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import webpush, { type PushSubscription } from 'web-push';
import type { BridgeInfo, EditableKind, HistoryCleanupResult, LoginRequest, PairingState, ServerMessage, ViewportRequest } from '../../shared/src/protocol';
import { BrowserFrameChangedError, BrowserNavigationError, browserAvailable, openBrowser, validateCdpUrl, validateTargetUrl, type BrowserFactory, type BrowserSession } from './browser';
import { atomicJsonWriter, createDeviceStore, DEVICE_LIFETIME_DAYS } from './devices';

export interface BridgeOptions {
  ownerToken: string;
  agentToken: string;
  port?: number;
  appUrl?: string;
  publicUrl?: string;
  staticDir?: string;
  allowLocalUrls?: boolean;
  vapid?: { publicKey: string; privateKey: string };
  subscriptionsFile?: string;
  devicesFile?: string;
  browserFactory?: BrowserFactory;
  now?: () => number;
  expiryIntervalMs?: number;
  inputDrainTimeoutMs?: number;
  /** Extra private-network addresses to listen on, such as a Tailscale IP. Loopback is always included. */
  listenHosts?: string[];
  /** Further exact origins allowed to call the bridge, such as its own tailnet address. */
  extraOrigins?: string[];
  computerName?: string;
}

interface Entry {
  request: LoginRequest;
  cdpUrl?: string;
  browser?: BrowserSession;
  opening?: Promise<BrowserSession>;
  controller?: Client;
  size?: { width: number; height: number };
  finalizing?: boolean;
  inputBarrier?: Promise<void>;
  draining?: Promise<void>;
  closing?: Promise<void>;
  frameEpoch?: string;
  navigating?: boolean;
  navigationAvailable?: boolean;
}
interface Client { lastFrame?: { data: string; url: string; epoch: string; at: number }; idle: number; tick: number; ws: WebSocket; authenticated: boolean; master?: boolean; deviceId?: string; alive: boolean; watching?: string; timer?: ReturnType<typeof setTimeout>; frames?: ReturnType<typeof setInterval>; pendingFrame: boolean; operations: Promise<void>; count: number; window: number }
interface StoredSubscription extends PushSubscription { deviceId?: string }
const terminal = new Set(['completed', 'denied', 'expired']);
const historyRetentionHours = 24;
const historyRetentionMs = historyRetentionHours * 60 * 60 * 1000;
/** Below common tunnel and proxy idle timeouts. */
const longPollMaxSeconds = 30;
const longPollMaxWaiters = 32;
/** Capture cadence while the page is changing. Idle pages are sampled less often. */
const frameIntervalMs = 100;
const pairingCodeLifetimeMs = 10 * 60 * 1000;
const pairingAlphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const editableKinds = new Set<EditableKind>(['text', 'password', 'email', 'numeric', 'tel', 'url', 'search']);
const allowedKeys = new Set(['Enter', 'Tab', 'Shift+Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'ControlOrMeta+A']);

function equalToken(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function authorization(request: IncomingMessage) {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}
function safeText(value: unknown, name: string, max: number, fallback?: string) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new HttpError(400, `${name} must be 1–${max} characters.`);
  return value.trim();
}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function jsonBody(request: IncomingMessage) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Use application/json.');
  let length = 0;
  const parts: Buffer[] = [];
  for await (const part of request) { const data = Buffer.from(part); length += data.length; if (length > 16_384) throw new HttpError(413, 'Request body is too large.'); parts.push(data); }
  try { const value: unknown = JSON.parse(Buffer.concat(parts).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
  catch { throw new HttpError(400, 'Invalid JSON object.'); }
}
function pushSubscription(value: Record<string, unknown>): PushSubscription {
  const subscription = (value.subscription && typeof value.subscription === 'object' ? value.subscription : value) as Record<string, unknown>;
  if (typeof subscription.endpoint !== 'string' || subscription.endpoint.length > 4096) throw new HttpError(400, 'Invalid push subscription.');
  let endpoint: URL;
  try { endpoint = new URL(subscription.endpoint); } catch { throw new HttpError(400, 'Invalid push endpoint.'); }
  const trusted = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com'];
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || (endpoint.port && endpoint.port !== '443') || !trusted.some(host => endpoint.hostname === host || (host === 'notify.windows.com' && endpoint.hostname.endsWith('.notify.windows.com')))) throw new HttpError(400, 'Unsupported browser push service.');
  const keys = subscription.keys as Record<string, unknown> | undefined;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || !/^[A-Za-z0-9_=-]{40,200}$/.test(keys.p256dh) || !/^[A-Za-z0-9_=-]{16,100}$/.test(keys.auth)) throw new HttpError(400, 'Invalid push subscription keys.');
  return { endpoint: endpoint.href, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}
function clamp(value: number, low: number, high: number) { return Math.max(low, Math.min(high, value)); }
/** Phones describe their screen; the bridge decides the limits. */
function viewportOf(value: unknown): ViewportRequest | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid viewport.');
  const { width, height, scale, touch } = value as Record<string, unknown>;
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) throw new Error('Invalid viewport.');
  return {
    width: clamp(Math.round(width), 320, 1280), height: clamp(Math.round(height), 320, 1400),
    scale: typeof scale === 'number' && Number.isFinite(scale) ? Math.round(clamp(scale, 1, 2) * 4) / 4 : 1,
    touch: touch === true,
  };
}
function matchingSubscription(stored: StoredSubscription | undefined, subscription: PushSubscription, deviceId: string | undefined) {
  return !!stored && stored.deviceId === deviceId && stored.endpoint === subscription.endpoint &&
    stored.keys.p256dh === subscription.keys.p256dh && stored.keys.auth === subscription.keys.auth;
}
function createPushTransport() {
  // web-push accepts a private HTTPS agent. Node dispatches ClientRequests via
  // addRequest (not declared by @types/node), before DNS/socket establishment.
  const agent = new HttpsAgent({ keepAlive: false }) as HttpsAgent & { addRequest(request: ClientRequest, options: RequestOptions): void };
  const dispatch = agent.addRequest;
  const pending = new Map<ClientRequest, () => void>();
  let closed = false;
  agent.addRequest = (request, options) => {
    if (closed) { queueMicrotask(() => request.destroy(new Error('Notification delivery stopped.'))); return; }
    const timer = setTimeout(() => request.destroy(new Error('Notification delivery timed out.')), 5000);
    timer.unref();
    const finished = () => { clearTimeout(timer); pending.delete(request); };
    pending.set(request, finished);
    request.once('close', finished);
    try { dispatch.call(agent, request, options); }
    catch (error) { finished(); throw error; }
  };
  return {
    agent,
    close() {
      closed = true;
      for (const [request, finished] of pending) { finished(); request.destroy(new Error('Notification delivery stopped.')); }
      agent.destroy();
    },
  };
}

export async function createBridge(options: BridgeOptions) {
  if (!options.ownerToken || !options.agentToken || options.ownerToken === options.agentToken) throw new Error('Separate owner and agent tokens are required.');
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const clients = new Set<Client>();
  const subscriptions = new Map<string, StoredSubscription>();
  const notifications = new Set<Promise<void>>();
  const pushTransport = createPushTransport();
  let devicePairing = Promise.resolve();
  const devices = await createDeviceStore(options.devicesFile, now);
  if (devices.prune().length) await devices.persist();
  const subscriptionsWriter = atomicJsonWriter(options.subscriptionsFile);
  const persistSubscriptions = () => subscriptionsWriter.write([...subscriptions.values()]);
  const available = !!options.browserFactory || await browserAvailable();
  const computerName = options.computerName?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  const info: BridgeInfo = { name: 'Keep Safe', version: '0.2.0', browserAvailable: available, pushEnabled: !!options.vapid, pushManagementAvailable: true, historyRetentionHours, pageControlsAvailable: true, navigationAvailable: true, pairingCodesAvailable: true, liveViewAvailable: true, deviceLifetimeDays: DEVICE_LIFETIME_DAYS, ...(computerName ? { computerName } : {}), ...(options.vapid ? { vapidPublicKey: options.vapid.publicKey } : {}) };
  const origins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
  for (const value of [options.appUrl, options.publicUrl, ...(options.extraOrigins ?? [])]) if (value) origins.add(new URL(value).origin);
  // One-time codes let a phone pair without ever seeing the owner token. They
  // live in memory only: a restart cancels every unclaimed code.
  const pairingCodes = new Map<string, { expiresAt: number; claimed?: { name: string; at: number } }>();
  let pairingFailures = 0;
  const prunePairing = () => { for (const [code, item] of pairingCodes) if (now() >= item.expiresAt + (item.claimed ? 120_000 : 0)) pairingCodes.delete(code); };
  function findPairing(value: unknown) {
    prunePairing();
    const supplied = typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    let found: { code: string; item: { expiresAt: number; claimed?: { name: string; at: number } } } | undefined;
    for (const [code, item] of pairingCodes) if (equalToken(supplied, code)) found = { code, item };
    if (found) return found;
    // Guessing must not be free: ten misses cancel every unclaimed code.
    if (++pairingFailures >= 10) { pairingFailures = 0; for (const [code, item] of pairingCodes) if (!item.claimed) pairingCodes.delete(code); }
    return undefined;
  }
  if (options.subscriptionsFile) {
    let pruned = false;
    try {
      const items: unknown = JSON.parse(await readFile(options.subscriptionsFile, 'utf8'));
      if (Array.isArray(items)) for (const item of items.slice(0, 10)) {
        try {
          const sub = pushSubscription(item);
          const id: unknown = (item as Record<string, unknown>).deviceId;
          if (id !== undefined && (typeof id !== 'string' || !devices.active(id))) { pruned = true; continue; }
          subscriptions.set(sub.endpoint, { ...sub, ...(typeof id === 'string' ? { deviceId: id } : {}) });
        } catch { pruned = true; /* Ignore invalid, never send to untrusted endpoints. */ }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Push subscriptions could not be loaded.'); }
    if (pruned) await persistSubscriptions();
  }
  const list = () => [...entries.values()].map(item => ({ ...item.request })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  function validClient(client: Client) {
    if (!client.authenticated) return false;
    if (client.master || (client.deviceId && devices.active(client.deviceId, true))) return true;
    unwatch(client);
    client.ws.close(4001, 'Phone pairing expired or revoked');
    return false;
  }
  function send(client: Client, message: ServerMessage) { if ((!client.authenticated || validClient(client)) && client.ws.readyState === WebSocket.OPEN && client.ws.bufferedAmount < 2_000_000) client.ws.send(JSON.stringify(message)); }
  /** Held long-poll responses. Each callback re-checks its own request and releases itself when it changed. */
  const waiters = new Set<(stop?: boolean) => void>();
  function broadcast() {
    const message: ServerMessage = { type: 'requests', requests: list() };
    for (const client of clients) if (client.authenticated) send(client, message);
    for (const waiter of [...waiters]) waiter();
  }
  function waitForChange(id: string, entry: Entry, since: string, milliseconds: number, response: ServerResponse) {
    return new Promise<void>(resolve => {
      const release = () => { clearTimeout(timer); waiters.delete(check); response.off('close', release); resolve(); };
      const check = (stop?: boolean) => { if (stop || entries.get(id) !== entry || terminal.has(entry.request.status) || entry.request.updatedAt !== since) release(); };
      const timer = setTimeout(release, milliseconds);
      waiters.add(check);
      response.once('close', release);
    });
  }
  function unwatch(client: Client) {
    if (client.frames) clearInterval(client.frames);
    client.frames = undefined;
    client.lastFrame = undefined;
    if (client.watching) { const entry = entries.get(client.watching); if (entry?.controller === client) entry.controller = undefined; }
    client.watching = undefined;
  }
  function closeEntry(entry: Entry): Promise<void> {
    if (entry.controller) unwatch(entry.controller);
    if (entry.closing) return entry.closing;
    const browser = entry.browser;
    if (!browser) return Promise.resolve();
    // Retain the reference until close succeeds. Other expiry/cleanup calls must
    // not remove a record while its browser is still closing, or after a failure.
    const closing = Promise.resolve().then(() => browser.close()).then(() => {
      if (entry.browser === browser) entry.browser = undefined;
    }, () => { /* A later expiry pass can retry this browser without losing its reference. */ }).finally(() => {
      if (entry.closing === closing) entry.closing = undefined;
    });
    entry.closing = closing;
    return closing;
  }
  function removable(entry: Entry) {
    return terminal.has(entry.request.status) && now() >= Date.parse(entry.request.expiresAt) &&
      !entry.browser && !entry.opening && !entry.finalizing && !entry.draining && !entry.inputBarrier && !entry.closing;
  }
  function clearHistory(automatic = false): HistoryCleanupResult {
    let removed = 0; let protectedCount = 0;
    for (const [id, entry] of entries) {
      if (!terminal.has(entry.request.status)) continue;
      if (removable(entry) && (!automatic || now() >= Date.parse(entry.request.expiresAt) + historyRetentionMs)) { entries.delete(id); removed++; }
      else protectedCount++;
    }
    return { removed, protected: protectedCount, requests: list() };
  }
  async function expire() {
    const expiredDevices = devices.prune();
    if (expiredDevices.length) {
      for (const id of expiredDevices) disconnectDevice(id);
      await devices.persist();
      await persistSubscriptions();
    }
    let changed = false;
    for (const entry of entries.values()) {
      if (now() < Date.parse(entry.request.expiresAt)) continue;
      if (!terminal.has(entry.request.status)) { entry.request.status = 'expired'; entry.request.updatedAt = new Date(now()).toISOString(); changed = true; }
      // Metadata APIs stay responsive during slow closes. The tracked promise
      // and retained browser reference protect the outcome until cleanup finishes.
      void closeEntry(entry);
    }
    if (clearHistory(true).removed || changed) broadcast();
  }
  function checkEntry(id: string) { const entry = entries.get(id); if (!entry) throw new HttpError(404, 'Request not found.'); return entry; }
  function active(entry: Entry, client: Client) { return validClient(client) && !entry.finalizing && !entry.draining && !terminal.has(entry.request.status) && now() < Date.parse(entry.request.expiresAt) && entry.controller === client && client.watching === entry.request.id && client.ws.readyState === WebSocket.OPEN; }
  async function frame(entry: Entry, client: Client) {
    if (client.pendingFrame || entry.navigating || !entry.browser || !active(entry, client)) return;
    // A slow phone link skips captures instead of queuing stale images.
    if (client.ws.bufferedAmount > 512_000) return;
    client.pendingFrame = true;
    const epoch = entry.frameEpoch ??= randomUUID();
    try {
      const result = await entry.browser.frame();
      if (active(entry, client) && !entry.navigating && entry.frameEpoch === epoch) {
        entry.size = { width: result.width, height: result.height };
        entry.navigationAvailable = !!entry.browser?.navigate && result.navigationAvailable === true;
        // An unchanged page costs no bandwidth, apart from one image a second
        // that keeps the phone's freshness checks satisfied.
        const last = client.lastFrame;
        const time = Date.now();
        if (last && last.epoch === epoch && last.url === result.url && last.data === result.data && time - last.at < 1000) { client.idle++; return; }
        if (!last || last.data !== result.data) client.idle = 0; else client.idle++;
        client.lastFrame = { data: result.data, url: result.url, epoch, at: time };
        send(client, { type: 'frame', requestId: entry.request.id, ...result, frameEpoch: epoch, navigationAvailable: entry.navigationAvailable });
      }
    } catch (error) { if (!(error instanceof BrowserFrameChangedError) && active(entry, client) && !entry.navigating && entry.frameEpoch === epoch) { send(client, { type: 'error', message: 'The browser could not be displayed. Reopen the session to try again.' }); unwatch(client); } }
    finally { client.pendingFrame = false; }
  }
  function resumeController(entry: Entry) {
    const client = entry.controller;
    if (!client || !entry.browser || !active(entry, client)) return;
    if (entry.request.status !== 'active') { entry.request.status = 'active'; entry.request.updatedAt = new Date(now()).toISOString(); broadcast(); }
    if (!client.frames) { void frame(entry, client); client.frames = startFrames(entry, client); }
  }
  function startFrames(entry: Entry, client: Client) {
    client.idle = 0; client.tick = 0;
    // Still pages drop to a third of the cadence. Any input restores it.
    return setInterval(() => { if (client.idle > 10 && ++client.tick % 3) return; void frame(entry, client); }, frameIntervalMs);
  }
  async function watch(client: Client, id: unknown, requestedViewport?: unknown) {
    if (typeof id !== 'string') throw new Error('Choose a valid request.');
    const viewport = viewportOf(requestedViewport);
    const entry = checkEntry(id);
    if (entry.finalizing || entry.draining || entry.inputBarrier || !['approved', 'active'].includes(entry.request.status) || now() >= Date.parse(entry.request.expiresAt)) throw new Error('Approve an unexpired request and wait for any previous browser action to finish before opening its browser.');
    if (entry.controller && entry.controller !== client) throw new Error('This browser is being controlled on another device.');
    unwatch(client);
    client.watching = id;
    entry.controller = client;
    try {
      if (!entry.browser) {
        if (!entry.opening && [...entries.values()].filter(item => item.browser || item.opening).length >= 5) throw new Error('Five browser sessions are already open. Complete or expire an existing session first.');
        entry.opening ??= (options.browserFactory ?? openBrowser)({ url: entry.request.url, cdpUrl: entry.cdpUrl, allowLocalUrls: !!options.allowLocalUrls, ...(viewport ? { viewport } : {}) });
        entry.browser = await entry.opening;
        entry.opening = undefined;
      } else if (viewport) await entry.browser.resize?.(viewport).catch(() => { /* The previous size stays usable. */ });
      if (now() >= Date.parse(entry.request.expiresAt) || ['denied', 'expired'].includes(entry.request.status)) { await closeEntry(entry); return; }
      if (!active(entry, client)) return;
      entry.request.status = 'active';
      entry.request.updatedAt = new Date(now()).toISOString();
      broadcast();
      await frame(entry, client);
      if (active(entry, client)) client.frames = startFrames(entry, client);
    } catch { unwatch(client); entry.opening = undefined; throw new Error('Unable to open this browser. Install Chromium with npx playwright install chromium, or check the agent CDP connection.'); }
  }
  async function handleMessage(client: Client, raw: Buffer) {
    // Receipt can precede a close while an earlier browser operation holds the
    // queue. A retired socket must never reacquire controller ownership later.
    if (stopping || client.ws.readyState !== WebSocket.OPEN) return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw.toString()) as Record<string, unknown>; if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error(); }
    catch { throw new Error('Invalid message.'); }
    if (!client.authenticated) {
      if (message.type !== 'auth' || typeof message.token !== 'string') { client.ws.close(4001, 'Authentication required'); return; }
      const master = equalToken(message.token, options.ownerToken);
      const device = !master && !equalToken(message.token, options.agentToken) ? devices.authenticate(message.token) : undefined;
      if (!master && !device) { client.ws.close(4001, 'Authentication required'); return; }
      client.authenticated = true;
      client.master = master;
      client.deviceId = device?.id;
      clearTimeout(client.timer);
      send(client, { type: 'ready', info, requests: list() });
      return;
    }
    if (!validClient(client)) return;
    if (message.type === 'watch') { await watch(client, message.requestId, message.viewport); return; }
    if (message.type === 'unwatch') { unwatch(client); return; }
    const entry = client.watching ? entries.get(client.watching) : undefined;
    if (!entry?.browser || !active(entry, client)) throw new Error('Open an approved session before sending input.');
    let operation: Promise<void>;
    if (message.type === 'navigate') {
      if (typeof message.navigationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(message.navigationId) ||
          !['back', 'forward', 'reload'].includes(message.direction as string) ||
          Object.keys(message).some(key => !['type', 'direction', 'navigationId'].includes(key))) throw new Error('Choose a valid browser navigation.');
      const browser = entry.browser;
      const epoch = entry.frameEpoch = randomUUID();
      entry.size = undefined;
      const supported = !!browser.navigate && entry.navigationAvailable === true;
      entry.navigationAvailable = false;
      entry.navigating = true;
      operation = Promise.resolve().then(async () => {
        let ok = false; let notice = 'The website could not be navigated. Check the new image before trying again.';
        try {
          if (!supported) throw new Error('Navigation is unavailable.');
          await browser.navigate!(message.direction as 'back' | 'forward' | 'reload');
          ok = true;
        } catch (error) {
          if (!supported) notice = 'Navigation is available only in a managed Keep Safe browser.';
          else if (error instanceof BrowserNavigationError) notice = error.reason === 'form'
            ? 'Navigation was blocked to avoid repeating a form submission. Use the website controls instead.'
            : error.reason === 'history' ? 'There is no available page in that direction.'
            : error.reason === 'timeout' ? 'Navigation took too long and was stopped. Check the new image before trying again.'
            : error.reason === 'changed' ? 'The browser changed during navigation. Check the new image before trying again.' : notice;
        } finally { entry.navigating = false; }
        if (active(entry, client) && entry.frameEpoch === epoch) {
          send(client, { type: 'navigated', requestId: entry.request.id, navigationId: message.navigationId as string, frameEpoch: epoch, ok, ...(!ok ? { message: notice } : {}) });
          await frame(entry, client);
        }
      });
    } else if (message.type === 'inspect-controls') {
      if (typeof message.inspectionId !== 'string' || !/^[a-f0-9-]{36}$/.test(message.inspectionId)) throw new Error('Choose a valid page control inspection.');
      if (!entry.browser.inspectControls) throw new Error('This browser does not support page controls. Update the bridge or use the live browser keys.');
      // Older dashboards cannot label embedded origins. Keep their inspection
      // main-only unless the client explicitly requests frame-aware results.
      operation = entry.browser.inspectControls({ includeFrames: message.includeFrames === true }).then(snapshot => {
        if (active(entry, client)) send(client, { type: 'controls', requestId: entry.request.id, inspectionId: message.inspectionId as string, snapshot });
      });
    } else if (message.type === 'resize') {
      const viewport = viewportOf({ width: message.width, height: message.height });
      const browser = entry.browser;
      entry.size = undefined;
      operation = Promise.resolve(browser.resize?.(viewport!)).then(() => {});
    } else {
      if (message.type === 'click') {
        if (typeof message.x !== 'number' || typeof message.y !== 'number' || !Number.isFinite(message.x) || !Number.isFinite(message.y) || !entry.size || message.x < 0 || message.y < 0 || message.x > entry.size.width || message.y > entry.size.height) throw new Error('Invalid tap coordinates.');
      } else if (message.type === 'scroll') {
        if (![message.deltaX, message.deltaY].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 3000)) throw new Error('Invalid scroll distance.');
        if ((Object.hasOwn(message, 'x') || Object.hasOwn(message, 'y')) &&
            (typeof message.x !== 'number' || typeof message.y !== 'number' || !Number.isFinite(message.x) || !Number.isFinite(message.y) || !entry.size || message.x < 0 || message.y < 0 || message.x > entry.size.width || message.y > entry.size.height)) throw new Error('Invalid scroll coordinates.');
      } else if (message.type === 'text') {
        if (typeof message.text !== 'string' || !message.text.length || message.text.length > 4096) throw new Error('Text must contain 1–4096 characters.');
      } else if (message.type === 'key') {
        if (typeof message.key !== 'string' || !allowedKeys.has(message.key)) throw new Error('Unsupported key.');
      } else if (message.type === 'focus') {
        if (typeof message.snapshotId !== 'string' || typeof message.controlId !== 'string' || !/^[a-f0-9-]{36}$/.test(message.snapshotId) || !/^[a-f0-9-]{36}$/.test(message.controlId)) throw new Error('Refresh page controls before choosing a field.');
      } else throw new Error('Unknown message type.');
      operation = entry.browser.input(message as { type: string; [key: string]: unknown }).then(result => {
        if (!active(entry, client)) return;
        if (message.type === 'focus') send(client, { type: 'focused', requestId: entry.request.id, snapshotId: message.snapshotId as string, controlId: message.controlId as string });
        // Tells the phone whether to raise its keyboard. Carries no field value.
        if (result && typeof result.editable === 'boolean') send(client, { type: 'editable', requestId: entry.request.id, editable: result.editable, ...(result.editable && result.kind && editableKinds.has(result.kind) ? { kind: result.kind } : {}) });
      });
    }
    client.idle = 0;
    // Show the result of this action without waiting for the next capture tick.
    void operation.then(() => frame(entry, client), () => {});
    // Keep the barrier on the request as well as the socket: closing a phone must
    // not orphan a keyboard operation that is still executing in Chromium.
    const barrier = Promise.allSettled([entry.inputBarrier ?? Promise.resolve(), operation]).then(() => {});
    entry.inputBarrier = barrier;
    void barrier.then(() => { if (entry.inputBarrier === barrier) entry.inputBarrier = undefined; });
    await operation;
  }
  const httpRates = new Map<string, { at: number; count: number }>();
  function rate(request: IncomingMessage, principal?: string) {
    // A tunnel puts callers behind one loopback address. Invalid credentials must
    // not consume the separate buckets used by legitimate owners and agents.
    const key = principal ?? `unauthenticated:${request.socket.remoteAddress ?? 'local'}`;
    const limit = principal ? 300 : 60;
    const current = httpRates.get(key);
    if (!current || Date.now() - current.at > 60_000) httpRates.set(key, { at: Date.now(), count: 1 });
    else if (++current.count > limit) throw new HttpError(429, 'Too many requests. Try again shortly.');
    if (httpRates.size > 100) for (const [address, entry] of httpRates) if (Date.now() - entry.at > 60_000) httpRates.delete(address);
  }
  function json(response: ServerResponse, status: number, data: unknown) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); }
  async function notify(request: LoginRequest) {
    if (!options.vapid) return;
    let pruned = false;
    await Promise.all([...subscriptions.values()].map(async subscription => {
      if (subscription.deviceId && !devices.active(subscription.deviceId)) return;
      try {
        await webpush.sendNotification(subscription, JSON.stringify({ body: `${request.agent}: ${request.title}`, notificationIntent: { version: 1, requestId: request.id, sourceKey: options.vapid!.publicKey } }), { vapidDetails: { subject: 'mailto:keep-safe@localhost.invalid', ...options.vapid! }, TTL: 600, timeout: 5000, agent: pushTransport.agent });
      } catch (error) {
        // A delayed response must not remove a newer enrollment or a migration
        // to another owner principal using the same browser subscription.
        if ([404, 410].includes((error as { statusCode?: number } | null)?.statusCode ?? 0) && subscriptions.get(subscription.endpoint) === subscription) {
          subscriptions.delete(subscription.endpoint); pruned = true;
        }
      }
    }));
    if (pruned) await persistSubscriptions();
  }
  function disconnectDevice(id: string) {
    for (const client of clients) if (client.deviceId === id) { unwatch(client); client.ws.close(4001, 'Phone pairing expired or revoked'); }
    for (const [endpoint, subscription] of subscriptions) if (subscription.deviceId === id) subscriptions.delete(endpoint);
  }
  let stopping = false;
  const handler = (request: IncomingMessage, response: ServerResponse) => { void (async () => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const origin = request.headers.origin;
    if (origin && !origins.has(origin)) throw new HttpError(403, 'This app origin is not allowed.');
    if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/health' && request.method === 'GET') { json(response, 200, { ok: true }); return; }
    if (!url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET' || !options.staticDir) throw new HttpError(404, 'Not found.');
      const root = resolve(options.staticDir);
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'Malformed URL path.'); }
      const candidate = resolve(root, `.${pathname}`);
      if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new HttpError(404, 'Not found.');
      let file = candidate;
      try { if (!(await stat(file)).isFile()) file = resolve(root, 'index.html'); } catch { file = resolve(root, 'index.html'); }
      let content: Buffer;
      try {
        const canonicalRoot = await realpath(root); const canonicalFile = await realpath(file);
        if (!canonicalFile.startsWith(`${canonicalRoot}${sep}`)) throw new Error('File outside frontend directory.');
        content = await readFile(canonicalFile);
      } catch { throw new HttpError(404, 'Build the web app with npm run build:web first.'); }
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
      response.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
      // Older WebKit does not treat 'self' as covering ws:, so a tailnet-hosted
      // page names its own socket origin when the Host header is a plain host.
      const host = request.headers.host;
      const ownSocket = host && /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(host) ? ` ws://${host}` : '';
      response.setHeader('Content-Security-Policy', `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*${ownSocket}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);
      response.end(content); return;
    }
    // Pairing by one-time code. The code is the only credential here, so both
    // routes share the unauthenticated rate bucket and count wrong guesses.
    if (url.pathname === '/api/pair/status' && request.method === 'POST') {
      rate(request);
      const body = await jsonBody(request);
      const found = findPairing(body.code);
      const state: PairingState = !found || (!found.item.claimed && now() >= found.item.expiresAt) ? 'expired' : found.item.claimed ? 'claimed' : 'waiting';
      json(response, 200, { state, ...(found?.item.claimed ? { name: found.item.claimed.name } : {}), ...(found && state === 'waiting' ? { expiresAt: new Date(found.item.expiresAt).toISOString() } : {}) }); return;
    }
    if (url.pathname === '/api/pair' && request.method === 'POST') {
      rate(request);
      const body = await jsonBody(request);
      const name = safeText(body.name, 'Device name', 80, 'Phone');
      const found = findPairing(body.code);
      if (!found || found.item.claimed || now() >= found.item.expiresAt) throw new HttpError(401, 'This pairing code is not valid any more. Create a fresh one on your computer.');
      // Single use: mark before the first await so a second claim cannot race it.
      const claim = { name, at: now() };
      found.item.claimed = claim;
      const pairing = devicePairing.then(() => devices.pair(name));
      devicePairing = pairing.then(() => {}, () => {});
      try {
        const paired = await pairing;
        pairingFailures = 0;
        json(response, 201, { ...paired, info });
      } catch (error) {
        if (found.item.claimed === claim) found.item.claimed = undefined;
        throw new HttpError(/already paired/.test((error as Error).message) ? 429 : 500, /already paired/.test((error as Error).message) ? (error as Error).message : 'The phone could not be paired. Try again.');
      }
      return;
    }
    const token = authorization(request);
    const master = equalToken(token, options.ownerToken);
    const agent = equalToken(token, options.agentToken);
    const device = !master && !agent ? devices.authenticate(token) : undefined;
    const owner = master || !!device;
    rate(request, master ? 'owner:master' : agent ? 'agent' : device ? `owner:${device.id}` : undefined);
    if (!owner && !agent) throw new HttpError(401, 'A valid bridge token is required.');
    const requireOwner = () => { if (!owner) throw new HttpError(403, 'Owner access is required.'); if (!master && (!device || !devices.active(device.id, true))) throw new HttpError(401, 'Phone pairing expired or revoked.'); };
    await expire();
    if (owner) requireOwner();
    if (url.pathname === '/api/devices' && request.method === 'GET') { requireOwner(); json(response, 200, { devices: devices.list(device?.id) }); return; }
    if (url.pathname === '/api/devices' && request.method === 'POST') {
      if (!master) throw new HttpError(403, 'Use the original private pairing link to pair a new phone.');
      const body = await jsonBody(request);
      if (!equalToken(authorization(request), options.ownerToken)) throw new HttpError(403, 'Use the original private pairing link to pair a new phone.');
      const name = safeText(body.name, 'Device name', 80);
      let notification: PushSubscription | undefined;
      if (body.notificationSubscription !== undefined) {
        if (!body.notificationSubscription || typeof body.notificationSubscription !== 'object' || Array.isArray(body.notificationSubscription)) throw new HttpError(400, 'Invalid push subscription.');
        notification = pushSubscription(body.notificationSubscription as Record<string, unknown>);
      }
      const pairing = devicePairing.then(async () => {
        const previous = notification ? subscriptions.get(notification.endpoint) : undefined;
        if (notification && !matchingSubscription(previous, notification, undefined)) throw new HttpError(409, 'Refresh notification settings or turn notifications off before remembering this phone.');
        if (devices.list().length >= 10) throw new HttpError(429, 'Ten phones are already paired. Revoke a phone before pairing another.');
        const paired = await devices.pair(name);
        if (!notification || !previous) return paired;
        let migrated: StoredSubscription | undefined;
        try {
          if (subscriptions.get(notification.endpoint) !== previous) throw new Error('Notification enrollment changed.');
          migrated = { ...notification, deviceId: paired.device.id };
          subscriptions.set(notification.endpoint, migrated);
          await persistSubscriptions();
          if (!devices.active(paired.device.id) || subscriptions.get(notification.endpoint) !== migrated) throw new Error('Phone enrollment changed.');
          return paired;
        } catch {
          devices.remove(paired.device.id);
          // Never overwrite an unrelated concurrent re-enrollment on rollback.
          if (migrated && subscriptions.get(notification.endpoint) === migrated) subscriptions.set(notification.endpoint, previous);
          await Promise.allSettled([devices.persist(), persistSubscriptions()]);
          throw new HttpError(500, 'The phone could not be paired. Refresh notification settings and try again.');
        }
      });
      devicePairing = pairing.then(() => {}, () => {});
      json(response, 201, await pairing); return;
    }
    if (url.pathname === '/api/pairing' && request.method === 'POST') {
      // Only the owner key on the computer can invite a phone. A paired phone
      // and the agent cannot mint codes.
      if (!master) throw new HttpError(403, 'Create pairing codes on the computer running Keep Safe.');
      prunePairing();
      const open = [...pairingCodes].filter(([, item]) => !item.claimed);
      if (open.length >= 5) pairingCodes.delete(open[0][0]);
      let code = '';
      for (let index = 0; index < 8; index++) code += pairingAlphabet[randomInt(pairingAlphabet.length)];
      const expiresAt = now() + pairingCodeLifetimeMs;
      pairingCodes.set(code, { expiresAt });
      pairingFailures = 0;
      json(response, 201, { code, expiresAt: new Date(expiresAt).toISOString() }); return;
    }
    const revoke = /^\/api\/devices\/([a-f0-9-]{36})\/revoke$/.exec(url.pathname);
    if (revoke && request.method === 'POST') {
      requireOwner();
      if (!devices.remove(revoke[1])) throw new HttpError(404, 'Paired phone not found.');
      disconnectDevice(revoke[1]);
      await devices.persist(); await persistSubscriptions();
      json(response, 200, { ok: true }); return;
    }
    // Counts only: lets an agent tell its user that no phone is paired yet.
    if (url.pathname === '/api/status' && request.method === 'GET') { json(response, 200, { phones: devices.list().length, notifications: subscriptions.size, browserAvailable: info.browserAvailable }); return; }
    if (url.pathname === '/api/info' && request.method === 'GET') { if (!owner) throw new HttpError(403, 'Owner access is required.'); json(response, 200, info); return; }
    if (url.pathname === '/api/history/clear' && request.method === 'POST') {
      requireOwner();
      const body = await jsonBody(request);
      requireOwner();
      if (body.confirm !== true) throw new HttpError(400, 'Confirm history cleanup with {"confirm":true}.');
      const result = clearHistory();
      if (result.removed) broadcast();
      json(response, 200, result); return;
    }
    if (url.pathname === '/api/requests' && request.method === 'GET') { if (!owner) throw new HttpError(403, 'Owner access is required.'); json(response, 200, { requests: list() }); return; }
    if (url.pathname === '/api/requests' && request.method === 'POST') {
      if (!agent) throw new HttpError(403, 'Agent access is required.');
      if ([...entries.values()].filter(entry => !terminal.has(entry.request.status)).length >= 20) throw new HttpError(429, 'The request queue is full.');
      const body = await jsonBody(request);
      let target: string; let cdpUrl: string | undefined;
      try { target = validateTargetUrl(body.url, options.allowLocalUrls); cdpUrl = validateCdpUrl(body.cdpUrl); } catch (error) { throw new HttpError(400, (error as Error).message); }
      const ttl = body.ttlSeconds === undefined ? 600 : body.ttlSeconds;
      if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1 || ttl > 1800) throw new HttpError(400, 'ttlSeconds must be an integer between 1 and 1800.');
      const time = now();
      const item: LoginRequest = { id: randomUUID(), agent: safeText(body.agent, 'Agent', 80), title: safeText(body.title, 'Title', 120), url: target, origin: new URL(target).origin, reason: safeText(body.reason, 'Reason', 500, 'Complete the sign-in so your agent can continue.'), status: 'pending', createdAt: new Date(time).toISOString(), updatedAt: new Date(time).toISOString(), expiresAt: new Date(time + ttl * 1000).toISOString() };
      // Body reading is asynchronous, so recheck resource limits immediately
      // before mutation. Never evict an outcome the agent can still retrieve.
      if ([...entries.values()].filter(entry => !terminal.has(entry.request.status)).length >= 20) throw new HttpError(429, 'The request queue is full.');
      if (entries.size >= 100) {
        const oldestSafe = [...entries].find(([, entry]) => removable(entry));
        if (!oldestSafe) throw new HttpError(429, 'History is full of protected requests. Wait for their original deadlines before creating another.');
        entries.delete(oldestSafe[0]);
      }
      entries.set(item.id, { request: item, cdpUrl });
      broadcast();
      const notification = notify(item).catch(() => {});
      notifications.add(notification);
      void notification.then(() => notifications.delete(notification));
      json(response, 201, item); return;
    }
    const match = /^\/api\/requests\/([a-f0-9-]{36})(?:\/(approve|deny|complete))?$/.exec(url.pathname);
    if (match) {
      const entry = checkEntry(match[1]);
      if (request.method === 'GET' && !match[2]) {
        const waitParam = url.searchParams.get('wait');
        const sinceParam = url.searchParams.get('since');
        if (waitParam !== null && (!/^[1-9]\d?$/.test(waitParam) || Number(waitParam) > longPollMaxSeconds)) throw new HttpError(400, `wait must be an integer between 1 and ${longPollMaxSeconds} seconds.`);
        if (sinceParam !== null && (waitParam === null || !sinceParam || sinceParam.length > 64)) throw new HttpError(400, 'since requires wait and must be the updatedAt value from an earlier response.');
        const since = sinceParam ?? entry.request.updatedAt;
        // Hold the response until this request changes, reaches an outcome, or
        // the wait ends. A full waiter set degrades to an immediate answer.
        if (waitParam !== null && !stopping && waiters.size < longPollMaxWaiters && !terminal.has(entry.request.status) && entry.request.updatedAt === since) {
          await waitForChange(match[1], entry, since, Number(waitParam) * 1000, response);
          if (response.destroyed || request.socket.destroyed) return;
          if (owner) requireOwner();
          if (entries.get(match[1]) !== entry) throw new HttpError(404, 'Request not found.');
        }
        const browser = agent && entry.request.status === 'completed' && entry.browser?.cdpUrl && now() < Date.parse(entry.request.expiresAt) ? { cdpUrl: entry.browser.cdpUrl, pageUrl: entry.browser.pageUrl ?? entry.request.url } : undefined;
        json(response, 200, { ...entry.request, ...(browser ? { browser } : {}) }); return;
      }
      if (request.method !== 'POST' || !match[2]) throw new HttpError(405, 'Method not allowed.');
      if (!owner) throw new HttpError(403, 'Owner access is required.');
      const action = match[2];
      if (entry.finalizing) throw new HttpError(409, 'This request is already being handed back.');
      if (terminal.has(entry.request.status)) throw new HttpError(409, 'This request has already ended.');
      if (action === 'approve' && entry.request.status !== 'pending') throw new HttpError(409, 'This request is already approved.');
      if (action === 'complete' && !['approved', 'active'].includes(entry.request.status)) throw new HttpError(409, 'Approve this request before completing it.');
      if (action === 'complete') {
        entry.finalizing = true;
        let prepared = false;
        const controller = entry.controller;
        const pending = [entry.draining, entry.inputBarrier, controller?.operations].filter((operation): operation is Promise<void> => !!operation);
        if (pending.length) {
          const drain = Promise.allSettled(pending).then(() => {});
          entry.draining = drain;
          void drain.then(() => { if (entry.draining === drain) { entry.draining = undefined; resumeController(entry); } });
        }
        try {
          if (entry.draining) {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([entry.draining, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new HttpError(504, 'Browser input is still finishing. Retry completion in a moment.')), options.inputDrainTimeoutMs ?? 10_000); })]);
            } finally { clearTimeout(timeout); }
          }
          if (entry.opening) entry.browser = await entry.opening;
          if (now() >= Date.parse(entry.request.expiresAt) || entry.request.status === 'expired') { await expire(); throw new HttpError(409, 'This request has expired.'); }
          if (!entry.browser) throw new HttpError(409, 'Open the browser session before completing the handoff.');
          await entry.browser.prepareHandoff?.();
          requireOwner();
          if (now() >= Date.parse(entry.request.expiresAt)) { await expire(); throw new HttpError(409, 'This request has expired.'); }
          prepared = true;
        } catch (error) {
          if (now() >= Date.parse(entry.request.expiresAt) || entry.request.status === 'expired') { await expire(); throw new HttpError(409, 'This request has expired.'); }
          if (error instanceof HttpError) throw error;
          throw new HttpError(502, 'The browser could not finish preparing the handoff. Reopen the session and try again.');
        } finally { entry.finalizing = false; if (!prepared) resumeController(entry); }
      }
      entry.request.status = action === 'approve' ? 'approved' : action === 'deny' ? 'denied' : 'completed';
      entry.request.updatedAt = new Date(now()).toISOString();
      if (entry.controller && action !== 'approve') unwatch(entry.controller);
      if (action === 'deny') await closeEntry(entry);
      broadcast(); json(response, 200, entry.request); return;
    }
    const pushAction = /^\/api\/push\/(subscribe|status|unsubscribe)$/.exec(url.pathname);
    if (pushAction && request.method === 'POST') {
      requireOwner();
      if (pushAction[1] === 'subscribe' && !options.vapid) throw new HttpError(409, 'Push is unavailable on this bridge.');
      const body = await jsonBody(request);
      requireOwner();
      const subscription = pushSubscription(body);
      const matching = matchingSubscription(subscriptions.get(subscription.endpoint), subscription, device?.id);
      if (pushAction[1] === 'status') { json(response, 200, { enabled: matching }); return; }
      if (pushAction[1] === 'unsubscribe') {
        if (matching) { subscriptions.delete(subscription.endpoint); await persistSubscriptions(); }
        json(response, 200, { ok: true }); return;
      }
      if (subscriptions.size >= 10 && !subscriptions.has(subscription.endpoint)) throw new HttpError(429, 'Too many notification devices.');
      subscriptions.set(subscription.endpoint, { ...subscription, ...(device ? { deviceId: device.id } : {}) });
      await persistSubscriptions();
      json(response, 200, { ok: true }); return;
    }
    throw new HttpError(404, 'Not found.');
  })().catch(error => { if (!response.headersSent) json(response, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'The bridge could not complete this request.' }); else response.end(); }); };
  const server = createServer(handler);
  // Loopback first. Extra listeners are private-network addresses the owner
  // chose, such as this computer's Tailscale IP.
  const extraServers = [...new Set(options.listenHosts ?? [])].filter(host => !['127.0.0.1', 'localhost'].includes(host)).map(host => ({ host, server: createServer(handler) }));
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32_768, perMessageDeflate: false });
  const upgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    if (stopping) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n', () => socket.destroy()); return; }
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws' || url.search || (request.headers.origin && !origins.has(request.headers.origin))) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    if (clients.size >= 10) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
  };
  server.on('upgrade', upgrade);
  for (const extra of extraServers) extra.server.on('upgrade', upgrade);
  sockets.on('connection', ws => {
    const client: Client = { idle: 0, tick: 0, ws, authenticated: false, alive: true, pendingFrame: false, operations: Promise.resolve(), count: 0, window: Date.now() };
    clients.add(client);
    client.timer = setTimeout(() => ws.close(4001, 'Authentication timeout'), 5000);
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', raw => {
      // Limit at receipt, before queuing slow browser operations, to bound queued input memory.
      if (Date.now() - client.window > 1000) { client.window = Date.now(); client.count = 0; }
      if (++client.count > 60) { ws.close(4029, 'Input rate exceeded'); return; }
      client.operations = client.operations.then(() => handleMessage(client, Buffer.from(raw as Buffer))).catch(() => send(client, { type: 'error', message: 'The requested action was not accepted. Check that the session is still active.' }));
    });
    ws.on('close', () => { clearTimeout(client.timer); unwatch(client); clients.delete(client); });
    ws.on('error', () => { /* Socket closes without logging input or credentials. */ });
  });
  const expiryTimer = setInterval(() => { void expire().catch(() => {}); }, options.expiryIntervalMs ?? 1000);
  expiryTimer.unref();
  const heartbeat = setInterval(() => { for (const client of clients) { if (!client.alive) client.ws.terminate(); else { client.alive = false; client.ws.ping(); } } }, 30_000);
  heartbeat.unref();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 4318, '127.0.0.1', resolve); });
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  origins.add(url); origins.add(`http://localhost:${address.port}`);
  const listening: string[] = [];
  for (const extra of extraServers) {
    // A missing interface (Tailscale stopped) must not stop the local bridge.
    try {
      await new Promise<void>((resolve, reject) => { extra.server.once('error', reject); extra.server.listen(address.port, extra.host, resolve); });
      listening.push(extra.host);
    } catch { /* Reported through `listening` so the CLI can explain it. */ }
  }
  return {
    server, url, port: address.port, info, listening,
    async close() {
      // Browser cleanup can await a renderer. Reject reconnects before the first
      // await, so no new socket can outlive the set terminated below.
      stopping = true;
      for (const waiter of [...waiters]) waiter(true);
      clearInterval(expiryTimer);
      clearInterval(heartbeat);
      for (const client of clients) { clearTimeout(client.timer); unwatch(client); client.ws.terminate(); }
      await Promise.all([...entries.values()].map(async entry => { if (entry.opening) { try { entry.browser = await entry.opening; } catch { /* Failed startup. */ } } await closeEntry(entry); }));
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await Promise.all([server, ...extraServers.filter(extra => listening.includes(extra.host)).map(extra => extra.server)].map(item => new Promise<void>(resolve => { item.close(() => resolve()); item.closeAllConnections(); })));
      await devices.close();
      pushTransport.close();
      await Promise.allSettled(notifications);
      await subscriptionsWriter.flush();
    },
  };
}
