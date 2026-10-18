import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import webpush from 'web-push';
import { canonicalNotificationSource, notificationMessage, parseNotificationIntent, readNotificationEntry, verifyNotificationIntent, withoutNotificationEntry } from '../apps/web/src/notification-intent';
import type { BridgeInfo, LoginRequest } from '../packages/shared/src/protocol';

const sourceKey = webpush.generateVAPIDKeys().publicKey;
const otherKey = webpush.generateVAPIDKeys().publicKey;
const requestId = randomUUID();
const intent = { requestId, sourceKey };
const info: BridgeInfo = { name: 'Synthetic notification bridge', version: 'test', browserAvailable: true, pushEnabled: true, vapidPublicKey: sourceKey };
const request: LoginRequest = { id: requestId, agent: 'Notification fixture', title: 'Synthetic request', url: 'https://example.invalid/login', origin: 'https://example.invalid', reason: 'Synthetic only', status: 'pending', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), expiresAt: new Date(10000).toISOString() };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

it('accepts only canonical public keys and bounded versioned request identities', () => {
  expect(canonicalNotificationSource(sourceKey)).toBe(true);
  for (const value of [null, '', sourceKey + '=', sourceKey.slice(1), 'A'.repeat(87), 'B'.repeat(200), 'https://example.invalid', { key: sourceKey }]) expect(canonicalNotificationSource(value)).toBe(false);
  expect(parseNotificationIntent({ version: 1, requestId: requestId.toUpperCase(), sourceKey })).toEqual(intent);
  for (const value of [{ requestId, sourceKey }, { version: 2, requestId, sourceKey }, { version: 1, requestId: 'request-not-a-uuid', sourceKey }, { version: 1, requestId, sourceKey: sourceKey + '=' }, [], null]) expect(parseNotificationIntent(value)).toBeNull();
});

it('classifies legacy, neutral and malformed worker messages without a targeted intent', () => {
  expect(notificationMessage({ type: 'notification-request', version: 1, ...intent })).toEqual({ present: true, intent });
  for (const value of [{ type: 'open-request', requestId }, { type: 'notification-inbox' }, { type: 'notification-request', version: 1, requestId }]) expect(notificationMessage(value)).toEqual({ present: true });
  expect(notificationMessage({ type: 'unrelated-message', requestId })).toBeNull();
});

it('recognizes notification entry markers and strips routing fields without consuming pairing credentials', () => {
  const href = `https://app.invalid/?request=legacy&keep=yes#bridge=https%3A%2F%2Fcomputer.invalid&token=synthetic-pairing-token&notificationRequest=${requestId}&notificationSource=${sourceKey}`;
  expect(readNotificationEntry(href)).toEqual({ present: true, intent });
  const cleaned = new URL(withoutNotificationEntry(href), 'https://app.invalid');
  const fragment = new URLSearchParams(cleaned.hash.slice(1));
  expect(cleaned.search).toBe('?keep=yes'); expect(fragment.get('bridge')).toBe('https://computer.invalid'); expect(fragment.get('token')).toBe('synthetic-pairing-token');
  expect(fragment.has('notificationRequest')).toBe(false); expect(fragment.has('notificationSource')).toBe(false);
  for (const suffix of [`#request=${requestId}`, `?request=${requestId}`, '#notificationInbox=1', '#notificationRequest=broken', `?notificationRequest=${requestId}&notificationSource=${sourceKey}`]) expect(readNotificationEntry('https://app.invalid/' + suffix)).toEqual({ present: true, intent: undefined });
  expect(readNotificationEntry('https://app.invalid/')).toEqual({ present: false });
});

it('waits for fresh metadata, then validates exact source and request instead of choosing the first queue item', async () => {
  const source = {}; const gate = deferred<{ info: BridgeInfo; requests: LoginRequest[] }>(); let settled = false;
  const check = verifyNotificationIntent(intent, source, () => gate.promise, current => current === source, () => 1000).then(result => { settled = true; return result; });
  await Promise.resolve(); expect(settled).toBe(false);
  gate.resolve({ info, requests: [{ ...request, id: randomUUID() }, request] }); expect(await check).toEqual({ kind: 'ready', intent });
  expect(await verifyNotificationIntent({ ...intent, requestId: randomUUID() }, source, async () => ({ info, requests: [request] }), () => true, () => 1000)).toEqual({ kind: 'unavailable' });
  expect(await verifyNotificationIntent(intent, source, async () => ({ info: { ...info, vapidPublicKey: otherKey }, requests: [request] }), () => true, () => 1000)).toEqual({ kind: 'mismatch' });
});

it('rejects an old connection’s delayed metadata, including a failed read after a switch', async () => {
  const source = {}; const next = {}; let current = source;
  const gate = deferred<{ info: BridgeInfo; requests: LoginRequest[] }>();
  const check = verifyNotificationIntent(intent, source, () => gate.promise, candidate => candidate === current, () => 1000);
  current = next; gate.resolve({ info, requests: [request] }); expect(await check).toEqual({ kind: 'stale' });
  expect(await verifyNotificationIntent(intent, source, async () => { throw new Error('Synthetic network failure'); }, candidate => candidate === current)).toEqual({ kind: 'stale' });
  expect(await verifyNotificationIntent(intent, next, async () => { throw new Error('Synthetic network failure'); }, candidate => candidate === current)).toEqual({ kind: 'failed' });
});

it('drops expired, terminal or malformed request metadata after the awaited read', async () => {
  for (const target of [{ ...request, expiresAt: new Date(1000).toISOString() }, { ...request, status: 'completed' as const }, { ...request, expiresAt: 'invalid' }]) expect(await verifyNotificationIntent(intent, {}, async () => ({ info, requests: [target] }), () => true, () => 1000)).toEqual({ kind: 'unavailable' });
});
