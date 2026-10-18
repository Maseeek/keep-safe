import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';

const script = await readFile(new URL('../apps/web/public/sw.js', import.meta.url), 'utf8');
const origin = 'https://keep-safe.example';
const requestId = '12345678-1234-4234-8234-123456789abc';
const sourceKey = webpush.generateVAPIDKeys().publicKey;
const intent = { version: 1, requestId, sourceKey };
type Shown = { body: string; tag: string; data: { notificationIntent?: typeof intent } };
type TestClient = { url: string; frameType: string; focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> };
function client(url = origin + '/', frameType = 'top-level'): TestClient {
  return { url, frameType, focus: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn() };
}
function worker(clients: TestClient[] = []) {
  const listeners = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined); const openWindow = vi.fn().mockResolvedValue(null);
  const matchAll = vi.fn().mockResolvedValue(clients);
  runInNewContext(script, { self: { location: { origin }, registration: { showNotification }, clients: { matchAll, openWindow }, addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener) }, URL, URLSearchParams, atob, btoa });
  async function dispatch(type: string, fields: object) {
    const pending: Promise<unknown>[] = [];
    listeners.get(type)!({ ...fields, waitUntil: (promise: Promise<unknown>) => pending.push(promise) }); await Promise.all(pending);
  }
  const push = async (data: unknown, malformed = false) => { await dispatch('push', { data: { json: () => { if (malformed) throw new Error('Synthetic malformed payload.'); return data; } } }); return showNotification.mock.calls.at(-1)![1] as Shown; };
  const click = async (data: unknown) => { const close = vi.fn(); await dispatch('notificationclick', { notification: { data, close } }); expect(close).toHaveBeenCalledOnce(); };
  return { listeners, showNotification, matchAll, openWindow, push, click };
}

describe('source-bound notification worker routing', () => {
  it('keeps only a canonical public source and UUID, bounds text and separates notification tags', async () => {
    const test = worker(); const shown = await test.push({ body: 'a'.repeat(300) + '\n', notificationIntent: { ...intent, requestId: requestId.toUpperCase(), privateToken: 'synthetic-ignored-token' }, url: 'https://untrusted.example/path' });
    expect(shown.body.length).toBe(240); expect(shown.data).toEqual({ notificationIntent: intent }); expect(shown.tag).toBe(`request-${sourceKey}-${requestId}`);
    expect(JSON.stringify(shown)).not.toContain('synthetic-ignored-token'); expect(JSON.stringify(shown)).not.toContain('untrusted');
    const other = await test.push({ notificationIntent: { ...intent, sourceKey: webpush.generateVAPIDKeys().publicKey } }); expect(other.tag).not.toBe(shown.tag);
    expect([...test.listeners.keys()].sort()).toEqual(['notificationclick', 'push']);
  });

  it.each([null, [], 'payload', { requestId, url: 'https://untrusted.example/' }, { notificationIntent: { ...intent, version: 2 } }, { notificationIntent: { ...intent, requestId: '-'.repeat(36) } }, { notificationIntent: { ...intent, sourceKey: 'A'.repeat(87) } }, { notificationIntent: { ...intent, sourceKey: sourceKey + '=' } }, { notificationIntent: { ...intent, sourceKey: sourceKey.slice(0, -1) + 'B' } }])('degrades invalid or legacy input to an unaddressed inbox notice (%#)', async payload => {
    const warm = client(); const test = worker([warm]); const shown = await test.push(payload); expect(shown.data).toEqual({}); expect(shown.tag).toBe('keep-safe-request');
    await test.click(shown.data); expect(warm.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'notification-inbox' }); expect(test.openWindow).not.toHaveBeenCalled();
  });

  it('uses safe defaults for malformed JSON without carrying a legacy request identifier', async () => {
    const test = worker(); const shown = await test.push(undefined, true); expect(shown.data).toEqual({});
    await test.click(shown.data); expect(test.openWindow).toHaveBeenCalledExactlyOnceWith(origin + '/#notificationInbox=1');
  });

  it('marks a fresh legacy notification as a neutral inbox entry instead of ordinary startup', async () => {
    const test = worker(); const shown = await test.push({ requestId, url: origin + '/?request=' + requestId });
    await test.click(shown.data);
    expect(test.openWindow).toHaveBeenCalledExactlyOnceWith(origin + '/#notificationInbox=1');
    expect(new URL(test.openWindow.mock.calls[0][0]).search).toBe('');
  });

  it('reuses one eligible top-level app window and safely posts even when focus is denied', async () => {
    const first = client(); first.focus.mockRejectedValue(new Error('Synthetic focus denial.')); const second = client();
    const test = worker([client('https://other.example/'), client(origin + '/', 'nested'), client(origin + '/other'), client('invalid-url'), first, second]);
    await test.click({ notificationIntent: intent, url: 'https://untrusted.example/' });
    expect(first.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'notification-request', ...intent }); expect(second.focus).not.toHaveBeenCalled(); expect(second.postMessage).not.toHaveBeenCalled(); expect(test.openWindow).not.toHaveBeenCalled();
    expect(test.matchAll).toHaveBeenCalledExactlyOnceWith({ type: 'window', includeUncontrolled: true });
  });

  it('opens only the fixed same-origin route with new hash names when no app window is eligible', async () => {
    const test = worker([client(origin + '/', 'nested')]); await test.click({ notificationIntent: intent, requestId: 'legacy', url: 'https://untrusted.example/' });
    const expected = new URL('/', origin); expected.hash = new URLSearchParams({ notificationRequest: requestId, notificationSource: sourceKey }).toString();
    expect(test.openWindow).toHaveBeenCalledExactlyOnceWith(expected.href); expect(expected.search).toBe(''); expect(new URLSearchParams(expected.hash.slice(1)).has('request')).toBe(false);
  });

  it('falls back safely if an existing client disappears and swallows rejected window operations', async () => {
    const warm = client(); warm.postMessage.mockImplementation(() => { throw new Error('Synthetic closed window.'); }); const test = worker([warm]); test.openWindow.mockRejectedValue(new Error('Synthetic open denied.'));
    await expect(test.click({ requestId, url: 'https://untrusted.example/' })).resolves.toBeUndefined(); expect(test.openWindow).toHaveBeenCalledExactlyOnceWith(origin + '/#notificationInbox=1');
    const noClients = worker(); noClients.matchAll.mockRejectedValue(new Error('Synthetic unavailable clients.')); await expect(noClients.click({ notificationIntent: intent })).resolves.toBeUndefined();
  });
});
