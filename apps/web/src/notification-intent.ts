import type { BridgeInfo, LoginRequest } from "../../../packages/shared/src/protocol";

export interface NotificationIntent { requestId: string; sourceKey: string }
export type NotificationEntry = { present: false } | { present: true; intent?: NotificationIntent };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const routingKeys = ["notificationRequest", "notificationSource", "notificationInbox", "request"];

export function canonicalNotificationSource(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(value)) return false;
  try {
    const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
    return decoded.length === 65 && decoded.charCodeAt(0) === 4 &&
      btoa(decoded).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === value;
  } catch { return false; }
}
export function parseNotificationIntent(value: unknown): NotificationIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.requestId !== "string" || !uuid.test(candidate.requestId) || !canonicalNotificationSource(candidate.sourceKey)) return null;
  return { requestId: candidate.requestId.toLowerCase(), sourceKey: candidate.sourceKey };
}
export function notificationMessage(value: unknown): NotificationEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "notification-request") return { present: true, intent: parseNotificationIntent(candidate) || undefined };
  if (candidate.type === "notification-inbox" || candidate.type === "open-request") return { present: true };
  return null;
}
export function readNotificationEntry(href: string): NotificationEntry {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const query = url.searchParams;
  const present = routingKeys.some(key => hash.has(key) || query.has(key));
  if (!present) return { present: false };
  // New notifications use only their fixed fragment keys. Legacy IDs and
  // query parameters have no source binding and receive neutral guidance.
  const intent = parseNotificationIntent({ version: 1, requestId: hash.get("notificationRequest"), sourceKey: hash.get("notificationSource") });
  return { present: true, intent: intent || undefined };
}
export function withoutNotificationEntry(href: string): string {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.slice(1));
  for (const key of routingKeys) { hash.delete(key); url.searchParams.delete(key); }
  url.hash = hash.toString();
  return url.pathname + url.search + url.hash;
}
export type NotificationCheck = { kind: "ready"; intent: NotificationIntent } | { kind: "stale" | "mismatch" | "unavailable" | "failed" };
export async function verifyNotificationIntent<Source>(
  intent: NotificationIntent,
  source: Source,
  read: () => Promise<{ info: BridgeInfo; requests: LoginRequest[] }>,
  current: (source: Source) => boolean,
  now: () => number = Date.now,
): Promise<NotificationCheck> {
  try {
    const result = await read();
    if (!current(source)) return { kind: "stale" };
    if (!canonicalNotificationSource(result.info.vapidPublicKey) || result.info.vapidPublicKey !== intent.sourceKey) return { kind: "mismatch" };
    const target = result.requests.find(request => request.id === intent.requestId);
    if (!target || !["pending", "approved", "active"].includes(target.status) || !Number.isFinite(Date.parse(target.expiresAt)) || Date.parse(target.expiresAt) <= now()) return { kind: "unavailable" };
    return { kind: "ready", intent };
  } catch { return { kind: current(source) ? "failed" : "stale" }; }
}
