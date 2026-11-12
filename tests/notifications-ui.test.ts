import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import webpush, { type PushSubscription } from 'web-push';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';

const ownerToken = 'synthetic-notification-owner';
const agentToken = 'synthetic-notification-agent';
const deviceKey = 'keep-safe.device.v1';
const sessionKey = 'keep-safe.connection.v1';
const mockKey = 'keep-safe.test.push';
const vapid = webpush.generateVAPIDKeys();
type Bridge = Awaited<ReturnType<typeof createBridge>>;
interface MockState {
  subscribed: boolean;
  publicKey: string;
  generation: number;
  permissionRequests: number;
  permissionFromGesture: boolean[];
  getSubscriptionCalls: number;
  subscribeCalls: number;
  unsubscribeCalls: number;
}

// The browser subscription already exists, as when another computer enrolled this app.
// Only browser APIs are mocked. No service worker or push provider is contacted.
async function mockBrowserPush(context: BrowserContext, publicKey = vapid.publicKey, options: { permission?: NotificationPermission; pendingRegistration?: boolean; unsupported?: boolean } = {}) {
  await context.addInitScript(({ key, publicKey, options }) => {
    const read = (): MockState => JSON.parse(sessionStorage.getItem(key)!);
    const update = (action: (state: MockState) => void) => {
      const state = read(); action(state); sessionStorage.setItem(key, JSON.stringify(state)); return state;
    };
    if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify({
      subscribed: true, publicKey, generation: 0, permissionRequests: 0,
      permissionFromGesture: [], getSubscriptionCalls: 0, subscribeCalls: 0, unsubscribeCalls: 0,
    }));
    const bytes = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
    const subscription = () => {
      const state = read();
      const data = {
        endpoint: `https://fcm.googleapis.com/fcm/send/keep-safe-ui-fixture-${state.generation}`,
        keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
      };
      return {
        ...data, expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: bytes(state.publicKey).buffer },
        toJSON: () => ({ ...data, expirationTime: null }),
        unsubscribe: async () => { update(state => { state.unsubscribeCalls++; state.subscribed = false; }); return true; },
      };
    };
    const registration = {
      pushManager: {
        getSubscription: async () => { const state = update(state => { state.getSubscriptionCalls++; }); return state.subscribed ? subscription() : null; },
        subscribe: async (options: PushSubscriptionOptionsInit) => {
          const source = options.applicationServerKey!;
          const array = source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array((source as ArrayBufferView).buffer);
          const encoded = btoa(String.fromCharCode(...array)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          update(state => { state.subscribeCalls++; state.subscribed = true; state.publicKey = encoded; state.generation++; });
          return subscription();
        },
      },
    };
    const serviceWorker = new EventTarget();
    Object.assign(serviceWorker, { register: async () => registration, getRegistration: async () => registration, ready: options.pendingRegistration ? new Promise(() => {}) : Promise.resolve(registration) });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
    class MockNotification {
      static permission = options.permission ?? 'granted';
      static async requestPermission() {
        update(state => { state.permissionRequests++; state.permissionFromGesture.push(navigator.userActivation.isActive); });
        return MockNotification.permission;
      }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: MockNotification });
    if (options.unsupported) Reflect.deleteProperty(window, 'PushManager');
    else if (!('PushManager' in window)) Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} });
  }, { key: mockKey, publicKey, options });
}

async function post(bridge: Bridge, token: string, action: 'status' | 'subscribe' | 'unsubscribe', subscription: PushSubscription) {
  const response = await fetch(`${bridge.url}/api/push/${action}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ enabled?: boolean }>;
}

async function subscriptionOn(page: Page) {
  return page.evaluate(async () => (await (await navigator.serviceWorker.ready).pushManager.getSubscription())!.toJSON()) as Promise<PushSubscription>;
}
async function mockState(page: Page) {
  return page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), mockKey) as Promise<MockState>;
}
async function pairing(page: Page) {
  return page.evaluate(({ deviceKey, sessionKey }) => ({ device: localStorage.getItem(deviceKey), session: sessionStorage.getItem(sessionKey) }), { deviceKey, sessionKey });
}
function settingsCard(page: Page) {
  return page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: /A nudge when/ }) });
}
async function settings(page: Page) {
  await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Settings', exact: true }).click();
  return settingsCard(page);
}
async function connected(page: Page, bridge: Bridge, token = ownerToken) {
  await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token })}`);
  await page.getByText('Bridge connected', { exact: true }).waitFor();
}
async function rememberForm(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: 'Remember this phone', exact: true }).click();
  await page.getByLabel('Name this phone', { exact: true }).fill(name);
}
async function initialRememberDialog(page: Page, bridge: Bridge, name: string) {
  await page.locator('.demo-banner').getByRole('button', { name: 'Connect your computer', exact: true }).click();
  await page.getByLabel('Bridge address', { exact: true }).fill(bridge.url);
  await page.getByLabel('Owner token from your bridge terminal', { exact: true }).fill(ownerToken);
  await page.getByRole('checkbox', { name: /Keep this phone paired/ }).check();
  await page.getByLabel('Device name', { exact: true }).fill(name);
}
async function devices(bridge: Bridge) {
  const response = await fetch(`${bridge.url}/api/devices`, { headers: { Authorization: `Bearer ${ownerToken}` } });
  expect(response.status).toBe(200);
  return (await response.json() as { devices: { id: string }[] }).devices;
}
async function buttonFits(button: Locator) {
  await button.scrollIntoViewIfNeeded();
  const box = (await button.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await button.evaluate(element => {
    const box = element.getBoundingClientRect();
    const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return target === element || element.contains(target);
  })).toBe(true);
}
async function off(card: Locator) {
  await card.getByText('Notifications are off for this computer.', { exact: true }).waitFor();
  expect(await card.getByRole('button', { name: 'Enable notifications', exact: true }).isEnabled()).toBe(true);
  expect(await card.getByRole('button', { name: 'Turn off notifications', exact: true }).count()).toBe(0);
}
async function on(card: Locator) {
  await card.getByText('Notifications are on for this computer.', { exact: true }).waitFor();
  expect(await card.getByRole('button', { name: 'Turn off notifications', exact: true }).isEnabled()).toBe(true);
}
async function phone(browser: Browser, width: number, origins: string[], publicKey = vapid.publicKey, options: Parameters<typeof mockBrowserPush>[2] = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
  await mockBrowserPush(context, publicKey, options);
  const external: string[] = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (origins.includes(url.origin)) return route.continue();
    external.push(url.origin); return route.abort();
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(6000);
  return { context, page, external, errors };
}

describe('notification enrollment on a phone', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each([320, 390])('checks this computer, enables an existing subscription and turns only its enrollment off at %ipx', async width => {
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, vapid, staticDir: resolve('apps/web/dist') });
    const other = await createBridge({ ownerToken: 'synthetic-other-owner', agentToken, port: 0, vapid });
    const { context, page, external, errors } = await phone(browser, width, [bridge.url]);
    try {
      await connected(page, bridge);
      await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByRole('button', { name: 'Remember this phone', exact: true }).click();
      await page.getByLabel('Name this phone', { exact: true }).fill('Notification test phone');
      await page.getByRole('button', { name: 'Keep this phone paired', exact: true }).click();
      await page.getByText('Notification test phone is remembered', { exact: true }).waitFor();
      const originalPairing = await pairing(page);
      const device = JSON.parse(originalPairing.device!) as { token: string };
      const subscription = await subscriptionOn(page);
      await post(other, 'synthetic-other-owner', 'subscribe', subscription);
      expect(await post(bridge, device.token, 'status', subscription)).toEqual({ enabled: false });
      const card = await settings(page);
      await off(card);
      const enable = card.getByRole('button', { name: 'Enable notifications', exact: true });
      await buttonFits(enable);
      await enable.click();
      await on(card);
      if (width === 320 && process.env.KEEP_SAFE_QA_SCREENSHOTS) {
        await mkdir('.keep-safe/qa', { recursive: true });
        await card.locator('.notification-actions').scrollIntoViewIfNeeded();
        await page.screenshot({ path: '.keep-safe/qa/notifications-settings-320.png' });
      }
      expect(await post(bridge, device.token, 'status', subscription)).toEqual({ enabled: true });
      expect(await post(bridge, ownerToken, 'status', subscription)).toEqual({ enabled: false });
      expect(await pairing(page)).toEqual(originalPairing);

      await page.reload();
      await page.getByText('Bridge connected', { exact: true }).waitFor();
      await on(await settings(page));
      const disable = settingsCard(page).getByRole('button', { name: 'Turn off notifications', exact: true });
      await buttonFits(disable);
      await disable.click();
      await off(settingsCard(page));
      await expect.poll(() => settingsCard(page).getByRole('button', { name: 'Enable notifications', exact: true }).evaluate(element => document.activeElement === element)).toBe(true);
      expect(await post(bridge, device.token, 'status', subscription)).toEqual({ enabled: false });
      expect(await post(other, 'synthetic-other-owner', 'status', subscription)).toEqual({ enabled: true });
      expect(await subscriptionOn(page)).toEqual(subscription);
      expect(await page.evaluate(() => Notification.permission)).toBe('granted');
      expect((await mockState(page)).unsubscribeCalls).toBe(0);
      expect((await mockState(page)).subscribeCalls).toBe(0);
      expect((await mockState(page)).permissionFromGesture.every(Boolean)).toBe(true);

      await page.reload();
      await page.getByText('Bridge connected', { exact: true }).waitFor();
      await off(await settings(page));
      expect(await pairing(page)).toEqual(originalPairing);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); await other.close(); await bridge.close(); }
  });

  it.each(['connected', 'fresh dialog'] as const)('moves an existing master enrollment only during explicit Remember from the %s flow and removes it on Forget', async entry => {
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, vapid, staticDir: resolve('apps/web/dist') });
    const { context, page, external, errors } = await phone(browser, entry === 'connected' ? 320 : 390, [bridge.url]);
    const name = 'Migrated notification phone';
    try {
      if (entry === 'connected') {
        await connected(page, bridge);
        const card = await settings(page);
        await off(card);
        await card.getByRole('button', { name: 'Enable notifications', exact: true }).click();
        await on(card);
      } else await page.goto(bridge.url);
      const subscription = await subscriptionOn(page);
      if (entry === 'fresh dialog') await post(bridge, ownerToken, 'subscribe', subscription);
      expect(await post(bridge, ownerToken, 'status', subscription)).toEqual({ enabled: true });
      const before = await mockState(page);
      if (entry === 'connected') {
        await rememberForm(page, name);
        await page.getByRole('button', { name: 'Keep this phone paired', exact: true }).click();
      } else {
        await initialRememberDialog(page, bridge, name);
        await page.getByRole('button', { name: 'Connect securely', exact: true }).click();
      }
      await expect.poll(() => page.evaluate(key => localStorage.getItem(key), deviceKey)).not.toBeNull();
      const stored = await pairing(page);
      expect(stored.device).not.toContain(ownerToken);
      expect(stored.device).not.toContain(agentToken);
      expect(stored.session).not.toContain(ownerToken);
      const saved = JSON.parse(stored.device!) as { token: string; device: { id: string } };
      expect(saved.token).not.toBe(ownerToken);
      expect(await post(bridge, saved.token, 'status', subscription)).toEqual({ enabled: true });
      expect(await post(bridge, ownerToken, 'status', subscription)).toEqual({ enabled: false });
      await on(await settings(page));
      const after = await mockState(page);
      expect(after.permissionRequests).toBe(before.permissionRequests);
      expect(after.subscribeCalls).toBe(before.subscribeCalls);
      expect(after.unsubscribeCalls).toBe(before.unsubscribeCalls);
      expect(await subscriptionOn(page)).toEqual(subscription);

      await page.reload();
      await page.getByText('Bridge connected', { exact: true }).waitFor();
      await on(await settings(page));
      expect(await pairing(page)).toEqual(stored);
      await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByText(`${name} is remembered`, { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Forget this phone', exact: true }).click();
      await page.getByRole('dialog', { name: 'Forget this phone?' }).getByRole('button', { name: 'Forget this phone', exact: true }).click();
      await expect.poll(() => page.evaluate(key => localStorage.getItem(key), deviceKey)).toBeNull();
      await expect.poll(() => devices(bridge)).toEqual([]);
      expect(await post(bridge, ownerToken, 'status', subscription)).toEqual({ enabled: false });
      expect((await fetch(`${bridge.url}/api/info`, { headers: { Authorization: `Bearer ${saved.token}` } })).status).toBe(401);
      expect(await subscriptionOn(page)).toEqual(subscription);
      expect((await mockState(page)).unsubscribeCalls).toBe(0);
      expect((await mockState(page)).subscribeCalls).toBe(0);
      expect(await page.evaluate(() => Notification.permission)).toBe('granted');
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); }
  });

  it.each(['connected', 'fresh dialog'] as const)('does not issue a remembered key when the %s migration enrollment check fails', async entry => {
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, vapid, staticDir: resolve('apps/web/dist') });
    const { context, page, external, errors } = await phone(browser, 390, [bridge.url]);
    const pairingPosts: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url() === `${bridge.url}/api/devices`) pairingPosts.push(request.url()); });
    try {
      if (entry === 'connected') {
        await connected(page, bridge);
        await off(await settings(page));
        await rememberForm(page, 'Unissued phone');
      } else {
        await page.goto(bridge.url);
        await initialRememberDialog(page, bridge, 'Unissued phone');
      }
      const subscription = await subscriptionOn(page);
      await post(bridge, ownerToken, 'subscribe', subscription);
      const before = await pairing(page);
      await page.route(`${bridge.url}/api/push/status`, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic enrollment check unavailable."}' }), { times: 1 });
      await page.getByRole('button', { name: entry === 'connected' ? 'Keep this phone paired' : 'Connect securely', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Synthetic enrollment check unavailable.' }).waitFor();
      expect(await pairing(page)).toEqual(before);
      expect((await pairing(page)).device).toBeNull();
      expect(pairingPosts).toEqual([]);
      expect(await devices(bridge)).toEqual([]);
      expect(await post(bridge, ownerToken, 'status', subscription)).toEqual({ enabled: true });
      expect((await mockState(page)).permissionRequests).toBe(0);
      expect((await mockState(page)).subscribeCalls).toBe(0);
      expect((await mockState(page)).unsubscribeCalls).toBe(0);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); }
  });

  it('keeps master authority and its changed enrollment when a stale migration proof receives a real409', async () => {
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, vapid, staticDir: resolve('apps/web/dist') });
    const { context, page, external, errors } = await phone(browser, 390, [bridge.url]);
    try {
      await connected(page, bridge);
      await off(await settings(page));
      const subscription = await subscriptionOn(page);
      await post(bridge, ownerToken, 'subscribe', subscription);
      await rememberForm(page, 'Conflicting phone');
      const before = await pairing(page);
      const changed = { ...subscription, keys: { ...subscription.keys, auth: 'C'.repeat(22) } };
      await page.route(`${bridge.url}/api/devices`, async route => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        expect(route.request().postDataJSON().notificationSubscription).toEqual(subscription);
        // A concurrent master re-enrollment invalidates the just-read proof.
        await post(bridge, ownerToken, 'subscribe', changed);
        await route.continue();
      });
      const rejected = page.waitForResponse(response => response.url() === `${bridge.url}/api/devices` && response.status() === 409);
      await page.getByRole('button', { name: 'Keep this phone paired', exact: true }).click();
      await (await rejected).finished();
      await page.getByRole('alert').filter({ hasText: 'Refresh notification settings or turn notifications off before remembering this phone.' }).waitFor();
      expect(await pairing(page)).toEqual(before);
      expect((await pairing(page)).device).toBeNull();
      expect(await devices(bridge)).toEqual([]);
      expect(await post(bridge, ownerToken, 'status', changed)).toEqual({ enabled: true });
      expect(await post(bridge, ownerToken, 'status', subscription)).toEqual({ enabled: false });
      expect((await mockState(page)).permissionRequests).toBe(0);
      expect((await mockState(page)).unsubscribeCalls).toBe(0);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); }
  });

  it.each(['enrollment read', 'created phone response'] as const)('keeps the new pairing when an old Remember %s finishes late', async stage => {
    const first = await createBridge({ ownerToken, agentToken, port: 0, vapid, staticDir: resolve('apps/web/dist') });
    const nextOwner = 'synthetic-next-notification-owner';
    const second = await createBridge({ ownerToken: nextOwner, agentToken, port: 0, vapid, appUrl: first.url });
    const { context, page, external, errors } = await phone(browser, 390, [first.url, second.url]);
    let release = () => {};
    let captured = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { captured = resolve; });
    const pairingPosts: string[] = [];
    let unpublishedToken = '';
    page.on('request', request => { if (request.method() === 'POST' && request.url() === `${first.url}/api/devices`) pairingPosts.push(request.url()); });
    try {
      await connected(page, first);
      await off(await settings(page));
      const subscription = await subscriptionOn(page);
      await post(first, ownerToken, 'subscribe', subscription);
      await rememberForm(page, 'Superseded phone');
      const path = stage === 'enrollment read' ? '/api/push/status' : '/api/devices';
      await page.route(first.url + path, async route => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        const response = await route.fetch();
        expect(response.status()).toBe(stage === 'enrollment read' ? 200 : 201);
        if (stage === 'created phone response') unpublishedToken = (await response.json() as { token: string }).token;
        captured(); await held;
        await route.fulfill({ response });
      });
      await page.getByRole('button', { name: 'Keep this phone paired', exact: true }).click();
      await started;
      expect(await page.getByRole('button', { name: 'Remember this phone', exact: true }).isDisabled()).toBe(true);
      if (stage === 'created phone response') expect((await devices(first)).length).toBe(1);
      await page.getByRole('button', { name: 'Update pairing', exact: true }).click();
      await page.getByLabel('Bridge address', { exact: true }).fill(second.url);
      await page.getByLabel('Owner token from your bridge terminal', { exact: true }).fill(nextOwner);
      await page.getByRole('button', { name: 'Connect securely', exact: true }).click();
      await expect.poll(() => page.evaluate(key => JSON.parse(sessionStorage.getItem(key) || '{}').url, sessionKey)).toBe(second.url);
      const nextPairing = await pairing(page);
      expect(nextPairing.device).toBeNull();
      const oldResponse = page.waitForResponse(response => response.url() === first.url + path && response.request().method() === 'POST');
      release();
      await (await oldResponse).finished();
      await expect.poll(() => devices(first)).toEqual([]);
      await page.waitForLoadState('networkidle');
      expect(await pairing(page)).toEqual(nextPairing);
      expect(await page.getByText('Bridge connected', { exact: true }).isVisible()).toBe(true);
      expect(pairingPosts.length).toBe(stage === 'enrollment read' ? 0 : 1);
      if (stage === 'created phone response') {
        expect((await fetch(`${first.url}/api/info`, { headers: { Authorization: `Bearer ${unpublishedToken}` } })).status).toBe(401);
        expect(await post(first, ownerToken, 'status', subscription)).toEqual({ enabled: false });
      } else expect(await post(first, ownerToken, 'status', subscription)).toEqual({ enabled: true });
      expect((await mockState(page)).permissionRequests).toBe(0);
      expect((await mockState(page)).subscribeCalls).toBe(0);
      expect((await mockState(page)).unsubscribeCalls).toBe(0);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    } finally { release(); await context.close(); await second.close(); await first.close(); }
  });

  it('keeps authentication invalidation in effect and revokes an unpublished remembered phone after its response arrives', async () => {
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, vapid, staticDir: resolve('apps/web/dist') });
    const { context, page, external, errors } = await phone(browser, 390, [bridge.url]);
    let release = () => {};
    let captured = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { captured = resolve; });
    let unpublishedToken = '';
    try {
      await connected(page, bridge);
      await off(await settings(page));
      const subscription = await subscriptionOn(page);
      await post(bridge, ownerToken, 'subscribe', subscription);
      await rememberForm(page, 'Invalidated pending phone');
      await page.route(`${bridge.url}/api/devices`, async route => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        unpublishedToken = (await response.json() as { token: string }).token;
        captured(); await held;
        await route.fulfill({ response });
      });
      await page.getByRole('button', { name: 'Keep this phone paired', exact: true }).click();
      await started;
      expect((await devices(bridge)).length).toBe(1);
      expect(await page.getByRole('button', { name: 'Remember this phone', exact: true }).isDisabled()).toBe(true);
      // The UI receives an authentication error while the original fixture
      // authority stays valid so the unpublished device can still be revoked.
      await page.route(`${bridge.url}/api/devices`, route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Synthetic pairing is no longer accepted."}' }), { times: 1 });
      await page.getByRole('button', { name: 'Refresh paired devices', exact: true }).click();
      await page.getByText('Demo mode', { exact: true }).waitFor();
      expect(await pairing(page)).toEqual({ device: null, session: null });
      const late = page.waitForResponse(response => response.url() === `${bridge.url}/api/devices` && response.request().method() === 'POST');
      release();
      await (await late).finished();
      await expect.poll(() => devices(bridge)).toEqual([]);
      await page.waitForLoadState('networkidle');
      expect(await pairing(page)).toEqual({ device: null, session: null });
      expect(await page.getByText('Demo mode', { exact: true }).isVisible()).toBe(true);
      expect((await fetch(`${bridge.url}/api/info`, { headers: { Authorization: `Bearer ${unpublishedToken}` } })).status).toBe(401);
      expect(await post(bridge, ownerToken, 'status', subscription)).toEqual({ enabled: false });
      expect((await mockState(page)).permissionRequests).toBe(0);
      expect((await mockState(page)).subscribeCalls).toBe(0);
      expect((await mockState(page)).unsubscribeCalls).toBe(0);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    } finally { release(); await context.close(); await bridge.close(); }
  });

  it('retries failed status, enrollment and removal without mistaking an error for enabled or disabled', async () => {
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, vapid, staticDir: resolve('apps/web/dist') });
    const { context, page, external, errors } = await phone(browser, 320, [bridge.url]);
    const failOnce = (path: string) => page.route(bridge.url + path, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic notification service unavailable."}' }), { times: 1 });
    try {
      await failOnce('/api/push/status');
      await connected(page, bridge);
      const card = await settings(page);
      await card.getByText('Could not check this computer’s notification enrollment.', { exact: true }).waitFor();
      expect(await card.getByText('Notifications are on for this computer.', { exact: true }).count()).toBe(0);
      await card.getByRole('button', { name: 'Check notification status', exact: true }).click();
      await off(card);
      const originalPairing = await pairing(page);
      const subscription = await subscriptionOn(page);

      await failOnce('/api/push/subscribe');
      await card.getByRole('button', { name: 'Enable notifications', exact: true }).click();
      await card.getByText('Synthetic notification service unavailable.', { exact: true }).waitFor();
      expect(await post(bridge, ownerToken, 'status', subscription)).toEqual({ enabled: false });
      await card.getByRole('button', { name: 'Enable notifications', exact: true }).click();
      await on(card);

      await failOnce('/api/push/unsubscribe');
      await card.getByRole('button', { name: 'Turn off notifications', exact: true }).click();
      await card.getByText('Synthetic notification service unavailable.', { exact: true }).waitFor();
      expect(await post(bridge, ownerToken, 'status', subscription)).toEqual({ enabled: true });
      await card.getByRole('button', { name: 'Turn off notifications', exact: true }).click();
      await off(card);
      expect(await post(bridge, ownerToken, 'status', subscription)).toEqual({ enabled: false });
      expect(await pairing(page)).toEqual(originalPairing);
      expect((await mockState(page)).unsubscribeCalls).toBe(0);
      expect(await page.evaluate(() => Notification.permission)).toBe('granted');
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); }
  });

  it('ignores a late status from a previous computer after switching the pairing in this tab', async () => {
    const first = await createBridge({ ownerToken, agentToken, port: 0, vapid, staticDir: resolve('apps/web/dist') });
    const nextOwner = 'synthetic-next-notification-owner';
    const second = await createBridge({ ownerToken: nextOwner, agentToken, port: 0, vapid, appUrl: first.url });
    const { context, page, external, errors } = await phone(browser, 390, [first.url, second.url]);
    let release = () => {};
    let captured = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { captured = resolve; });
    try {
      await page.route(first.url + '/api/push/status', async route => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        captured(); await held;
        await route.fulfill({ response });
      });
      await connected(page, first);
      await started;
      const subscription = await subscriptionOn(page);
      await post(second, nextOwner, 'subscribe', subscription);
      await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByRole('button', { name: 'Update pairing', exact: true }).click();
      await page.getByLabel('Bridge address', { exact: true }).fill(second.url);
      await page.getByLabel('Owner token from your bridge terminal', { exact: true }).fill(nextOwner);
      await page.getByRole('button', { name: 'Connect securely', exact: true }).click();
      await expect.poll(() => page.evaluate(key => JSON.parse(sessionStorage.getItem(key) || '{}').url, sessionKey)).toBe(second.url);
      const card = await settings(page);
      await on(card);
      const originalPairing = await pairing(page);
      const oldResponse = page.waitForResponse(response => response.url() === first.url + '/api/push/status');
      release();
      await (await oldResponse).finished();
      await page.waitForLoadState('networkidle');
      await on(card);
      expect(await pairing(page)).toEqual(originalPairing);
      expect(await post(second, nextOwner, 'status', subscription)).toEqual({ enabled: true });
      expect((await mockState(page)).unsubscribeCalls).toBe(0);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    } finally { release(); await context.close(); await second.close(); await first.close(); }
  });

  it.each(['subscribe', 'unsubscribe'] as const)('keeps the new computer’s enrollment and focus after a previous %s finishes late', async action => {
    const first = await createBridge({ ownerToken, agentToken, port: 0, vapid, staticDir: resolve('apps/web/dist') });
    const nextOwner = 'synthetic-next-notification-owner';
    const second = await createBridge({ ownerToken: nextOwner, agentToken, port: 0, vapid, appUrl: first.url });
    const { context, page, external, errors } = await phone(browser, 390, [first.url, second.url]);
    let release = () => {};
    let captured = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { captured = resolve; });
    try {
      await connected(page, first);
      const subscription = await subscriptionOn(page);
      if (action === 'unsubscribe') {
        await post(first, ownerToken, 'subscribe', subscription);
        await post(second, nextOwner, 'subscribe', subscription);
      }
      const card = await settings(page);
      if (action === 'unsubscribe') {
        await card.getByRole('button', { name: 'Check notification status', exact: true }).click();
        await on(card);
      } else await off(card);
      await page.route(`${first.url}/api/push/${action}`, async route => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        captured(); await held;
        await route.fulfill({ response });
      });
      await card.getByRole('button', { name: action === 'subscribe' ? 'Enable notifications' : 'Turn off notifications', exact: true }).click();
      await started;
      await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByRole('button', { name: 'Update pairing', exact: true }).click();
      await page.getByLabel('Bridge address', { exact: true }).fill(second.url);
      await page.getByLabel('Owner token from your bridge terminal', { exact: true }).fill(nextOwner);
      await page.getByRole('button', { name: 'Connect securely', exact: true }).click();
      await expect.poll(() => page.evaluate(key => JSON.parse(sessionStorage.getItem(key) || '{}').url, sessionKey)).toBe(second.url);
      const nextCard = await settings(page);
      if (action === 'unsubscribe') await on(nextCard); else await off(nextCard);
      const originalPairing = await pairing(page);
      const settingsButton = page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Settings', exact: true });
      await settingsButton.focus();
      const oldResponse = page.waitForResponse(response => response.url() === `${first.url}/api/push/${action}`);
      release();
      await (await oldResponse).finished();
      await page.waitForLoadState('networkidle');
      if (action === 'unsubscribe') await on(nextCard); else await off(nextCard);
      expect(await settingsButton.evaluate(element => document.activeElement === element)).toBe(true);
      expect(await pairing(page)).toEqual(originalPairing);
      expect(await post(second, nextOwner, 'status', subscription)).toEqual({ enabled: action === 'unsubscribe' });
      expect((await mockState(page)).unsubscribeCalls).toBe(0);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    } finally { release(); await context.close(); await second.close(); await first.close(); }
  });

  it('keeps a deliberate keyboard focus change while notification removal is pending', async () => {
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, vapid, staticDir: resolve('apps/web/dist') });
    const { context, page } = await phone(browser, 390, [bridge.url]);
    let release = () => {};
    let captured = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { captured = resolve; });
    try {
      await connected(page, bridge);
      const card = await settings(page);
      await off(card);
      await card.getByRole('button', { name: 'Enable notifications', exact: true }).click();
      await on(card);
      await page.route(`${bridge.url}/api/push/unsubscribe`, async route => {
        const response = await route.fetch();
        captured(); await held;
        await route.fulfill({ response });
      });
      await card.getByRole('button', { name: 'Turn off notifications', exact: true }).click();
      await started;
      const target = page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('button', { name: 'Settings', exact: true });
      await target.focus();
      release();
      await off(card);
      await page.waitForLoadState('networkidle');
      expect(await target.evaluate(element => document.activeElement === element)).toBe(true);
    } finally { release(); await context.close(); await bridge.close(); }
  });

  it.each(['denied', 'unsupported'] as const)('explains a %s browser without enrolling or changing pairing', async limitation => {
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, vapid, staticDir: resolve('apps/web/dist') });
    const { context, page, external, errors } = await phone(browser, 320, [bridge.url], vapid.publicKey, limitation === 'denied' ? { permission: 'denied' } : { unsupported: true });
    const enrollments: string[] = [];
    page.on('request', request => { if (/\/api\/push\/(subscribe|unsubscribe)$/.test(request.url())) enrollments.push(request.url()); });
    try {
      await connected(page, bridge);
      const card = await settings(page);
      if (limitation === 'denied') await off(card);
      else await card.getByText(/This browser does not support push/).waitFor();
      const originalPairing = await pairing(page);
      await card.getByRole('button', { name: 'Enable notifications', exact: true }).click();
      if (limitation === 'denied') {
        await card.getByRole('alert').filter({ hasText: 'Notifications were not enabled. You can change permission in your browser’s site settings.' }).waitFor();
        expect((await mockState(page)).permissionRequests).toBe(1);
        expect((await mockState(page)).permissionFromGesture).toEqual([true]);
      } else expect((await mockState(page)).permissionRequests).toBe(0);
      expect(await card.getByText('Notifications are on for this computer.', { exact: true }).count()).toBe(0);
      expect(await post(bridge, ownerToken, 'status', await subscriptionOn(page))).toEqual({ enabled: false });
      expect(await pairing(page)).toEqual(originalPairing);
      expect(enrollments).toEqual([]);
      expect((await mockState(page)).unsubscribeCalls).toBe(0);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); }
  });

  it('times out an unavailable service worker with a retryable message and no enrollment', async () => {
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, vapid, staticDir: resolve('apps/web/dist') });
    const { context, page, external, errors } = await phone(browser, 390, [bridge.url], vapid.publicKey, { pendingRegistration: true });
    const enrollments: string[] = [];
    page.on('request', request => { if (/\/api\/push\/(subscribe|unsubscribe)$/.test(request.url())) enrollments.push(request.url()); });
    try {
      await page.clock.install();
      await connected(page, bridge);
      const card = await settings(page);
      await card.getByText('Checking this computer’s notification enrollment…', { exact: true }).waitFor();
      const originalPairing = await pairing(page);
      await page.clock.fastForward(10_001);
      await card.getByRole('alert').filter({ hasText: 'Could not check this computer’s notification enrollment.' }).waitFor();
      await card.getByRole('button', { name: 'Enable notifications', exact: true }).click();
      await expect.poll(async () => (await mockState(page)).permissionRequests).toBe(1);
      await page.clock.fastForward(10_001);
      await card.getByRole('alert').filter({ hasText: 'The notification service did not become ready. Reload this app and try again.' }).waitFor();
      expect(await card.getByRole('button', { name: 'Enable notifications', exact: true }).isEnabled()).toBe(true);
      expect(await pairing(page)).toEqual(originalPairing);
      expect(enrollments).toEqual([]);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); }
  });

  it('rejects malformed enrollment metadata and checks again against the real bridge', async () => {
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, vapid, staticDir: resolve('apps/web/dist') });
    const { context, page, external, errors } = await phone(browser, 390, [bridge.url]);
    try {
      await page.route(`${bridge.url}/api/push/status`, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":"true"}' }), { times: 1 });
      await connected(page, bridge);
      const card = await settings(page);
      await card.getByRole('alert').filter({ hasText: 'Could not check this computer’s notification enrollment.' }).waitFor();
      expect(await card.getByText('Notifications are on for this computer.', { exact: true }).count()).toBe(0);
      await card.getByRole('button', { name: 'Check notification status', exact: true }).click();
      await off(card);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); }
  });

  it('offers explicit registration on an older bridge without claiming its existing browser subscription is enrolled', async () => {
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, vapid, staticDir: resolve('apps/web/dist') });
    delete bridge.info.pushManagementAvailable;
    const { context, page, external, errors } = await phone(browser, 390, [bridge.url]);
    const unsupportedCalls: string[] = [];
    page.on('request', request => { if (/\/api\/push\/(status|unsubscribe)$/.test(request.url())) unsupportedCalls.push(request.url()); });
    try {
      await connected(page, bridge);
      const card = await settings(page);
      const copy = 'This bridge cannot check notification enrollment. Enable again to register this browser.';
      await card.getByText(copy, { exact: true }).waitFor();
      expect(await card.getByText('Notifications are on for this computer.', { exact: true }).count()).toBe(0);
      const subscription = await subscriptionOn(page);
      const originalPairing = await pairing(page);
      expect(await post(bridge, ownerToken, 'status', subscription)).toEqual({ enabled: false });
      await card.getByRole('button', { name: 'Enable notifications', exact: true }).click();
      await expect.poll(async () => (await post(bridge, ownerToken, 'status', subscription)).enabled).toBe(true);
      await page.reload();
      await page.getByText('Bridge connected', { exact: true }).waitFor();
      await (await settings(page)).getByText(copy, { exact: true }).waitFor();
      expect(await pairing(page)).toEqual(originalPairing);
      expect(unsupportedCalls).toEqual([]);
      expect((await mockState(page)).unsubscribeCalls).toBe(0);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); }
  });

  it('asks before replacing a different computer’s notification key and keeps the subscription when cancelled', async () => {
    const previousKey = webpush.generateVAPIDKeys().publicKey;
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, vapid, staticDir: resolve('apps/web/dist') });
    const { context, page, external, errors } = await phone(browser, 390, [bridge.url], previousKey);
    try {
      await connected(page, bridge);
      const card = await settings(page);
      await off(card);
      const originalPairing = await pairing(page);
      const before = await subscriptionOn(page);
      const declined = page.waitForEvent('dialog');
      const cancelClick = card.getByRole('button', { name: 'Enable notifications', exact: true }).click();
      const cancel = await declined;
      expect(cancel.type()).toBe('confirm');
      expect(cancel.message()).toMatch(/^Switch notifications to this computer\?/);
      await cancel.dismiss();
      await cancelClick;
      await card.getByText('Notification key unchanged. Notifications are off for this computer.', { exact: true }).waitFor();
      expect(await card.getByRole('button', { name: 'Enable notifications', exact: true }).isEnabled()).toBe(true);
      expect((await mockState(page)).unsubscribeCalls).toBe(0);
      expect((await mockState(page)).subscribeCalls).toBe(0);
      expect(await subscriptionOn(page)).toEqual(before);
      expect(await post(bridge, ownerToken, 'status', before)).toEqual({ enabled: false });

      const accepted = page.waitForEvent('dialog');
      const confirmClick = card.getByRole('button', { name: 'Enable notifications', exact: true }).click();
      const confirm = await accepted;
      expect(confirm.message()).toMatch(/^Switch notifications to this computer\?/);
      await confirm.accept();
      await confirmClick;
      await on(card);
      const next = await subscriptionOn(page);
      expect(next.endpoint).not.toBe(before.endpoint);
      expect(await post(bridge, ownerToken, 'status', next)).toEqual({ enabled: true });
      expect((await mockState(page)).unsubscribeCalls).toBe(1);
      expect((await mockState(page)).subscribeCalls).toBe(1);
      expect(await page.evaluate(() => Notification.permission)).toBe('granted');
      expect(await pairing(page)).toEqual(originalPairing);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); await bridge.close(); }
  });
});
