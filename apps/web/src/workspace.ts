import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BridgeInfo,
  ClientMessage,
  DevicePairResult,
  EditableKind,
  ViewportRequest,
  HistoryCleanupResult,
  LoginRequest,
  PairedDevice,
  PageControlsSnapshot,
  ServerMessage,
} from "../../../packages/shared/src/protocol";

export interface Connection {
  url: string;
  token: string;
  device?: PairedDevice;
  /** The computer's notification key. Tells this phone which computer an
   * address update in a notification came from. */
  source?: string;
}
export interface BrowserFrame {
  requestId: string;
  data: string;
  width: number;
  height: number;
  url: string;
  frameEpoch?: string;
  navigationAvailable?: boolean;
}
type NavigationDirection = "back" | "forward" | "reload";
interface NavigationAttempt {
  navigationId: string;
  requestId: string;
  source: Connection;
  socket: WebSocket;
  previousEpoch?: string;
  result?: { frameEpoch: string; ok: boolean; message?: string };
  timer?: ReturnType<typeof setTimeout>;
}
export type ConnectionStatus =
  | "demo"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

const storageKey = "keep-safe.connection.v1";
const deviceStorageKey = "keep-safe.device.v1";
const noticeKey = "keep-safe.notice.v1";

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** What a pairing link or scanned QR code carries. Never the owner token. */
export interface PairingInvite { url: string; code: string }

/** Accepts a pairing link, or a bare code when the page itself came from the bridge. */
export function parseInvite(text: string, fallbackUrl?: string): PairingInvite | null {
  const value = text.trim();
  const clean = (code: string | null) => {
    const normal = (code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return /^[A-Z0-9]{8}$/.test(normal) ? normal : null;
  };
  try {
    const link = new URL(value);
    const params = new URLSearchParams(link.hash.slice(1));
    const code = clean(params.get("pair"));
    if (code) return { url: validateBridgeUrl(params.get("bridge") || link.origin), code };
  } catch { /* Not a link: try it as a code. */ }
  const code = clean(value);
  if (!code || !fallbackUrl) return null;
  try { return { url: validateBridgeUrl(fallbackUrl), code }; } catch { return null; }
}

/** A pairing link for an app served somewhere else, such as a computer's own
 * Tailscale address. The scanner opens it, as the phone camera would. */
export function foreignPairingLink(text: string): string | null {
  try {
    const link = new URL(text.trim());
    const params = new URLSearchParams(link.hash.slice(1));
    if (!["https:", "http:"].includes(link.protocol) || link.origin === window.location.origin || params.get("bridge")) return null;
    if (link.username || link.password || link.pathname !== "/" || !/^[A-Za-z0-9]{8}$/.test((params.get("pair") ?? "").replace(/[^A-Za-z0-9]/g, ""))) return null;
    return link.href;
  } catch { return null; }
}

const linkCache = "keep-safe-link-v1";
const linkRecord = "/__keep-safe/link";
const validSource = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{87}$/.test(value);
/** The newest address a notification from the paired computer carried. The
 * service worker stores it; only that computer can send to this phone. */
async function notifiedAddress(): Promise<{ sourceKey?: unknown; url?: unknown } | null> {
  try {
    if (!("caches" in window)) return null;
    const hit = await (await caches.open(linkCache)).match(linkRecord);
    return hit ? (await hit.json()) as { sourceKey?: unknown; url?: unknown } : null;
  } catch { return null; }
}
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
/** Shows the computer this phone already holds a key, without sending the key. */
async function relinkProof(connection: Connection | null, code: string): Promise<{ id: string; proof: string } | undefined> {
  try {
    if (!connection?.device || !globalThis.crypto?.subtle) return undefined;
    const text = new TextEncoder();
    const digest = await crypto.subtle.digest("SHA-256", text.encode(connection.token));
    const key = await crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return { id: connection.device.id, proof: hex(await crypto.subtle.sign("HMAC", key, text.encode(`keep-safe-relink:${code}`))) };
  } catch { return undefined; }
}

export function defaultDeviceName(): string {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return "iPhone";
  if (/iPad/.test(agent)) return "iPad";
  if (/Android/.test(agent)) return /Mobile/.test(agent) ? "Android phone" : "Android tablet";
  if (/Mac/.test(agent)) return "Mac browser";
  if (/Windows/.test(agent)) return "Windows browser";
  return "Browser";
}

export function validateBridgeUrl(url: string): string {
  return validateConnection(url, "placeholder").url;
}

export function validateConnection(url: string, token: string): Connection {
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
  } catch {
    throw new Error(
      "Enter a complete bridge address, such as https://your-tunnel.example.",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error(
      "Use the bridge address without a username, password, query, or fragment.",
    );
  if (parsed.pathname !== "/")
    throw new Error(
      "Use the bridge address without a path, such as https://your-tunnel.example.",
    );
  // A page the bridge serves itself may talk to that bridge over the same
  // connection it was loaded on, such as a Tailscale address.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.origin === window.location.origin;
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local))
    throw new Error(
      "Use an HTTPS bridge address. HTTP is only allowed on localhost.",
    );
  if (!token.trim())
    throw new Error("Enter the owner token printed by your bridge.");
  return { url: parsed.origin, token: token.trim() };
}

function clearPairingStorage() {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    /* Storage may be unavailable. */
  }
  try {
    localStorage.removeItem(deviceStorageKey);
  } catch {
    /* Storage may be unavailable. */
  }
}

function storeNotice(message: string) {
  try {
    if (message) sessionStorage.setItem(noticeKey, message);
    else sessionStorage.removeItem(noticeKey);
  } catch {
    /* Storage may be unavailable. */
  }
}

function readStoredNotice(): string {
  try {
    return sessionStorage.getItem(noticeKey) || "";
  } catch {
    return "";
  }
}

function parseDevice(value: unknown): PairedDevice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.expiresAt))
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    name: candidate.name,
    createdAt:
      typeof candidate.createdAt === "string"
        ? candidate.createdAt
        : candidate.expiresAt,
    expiresAt: candidate.expiresAt,
    lastSeenAt:
      typeof candidate.lastSeenAt === "string"
        ? candidate.lastSeenAt
        : candidate.expiresAt,
    current: true,
  };
}

function initialState(): { connection: Connection | null; notice: string; invite?: PairingInvite | null; previous?: Connection | null } {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const url = params.get("bridge");
  const token = params.get("token");
  if (params.get("pair") !== null) {
    // A one-time code: take it out of the address bar, then let the app claim it.
    const invite = parseInvite(window.location.href);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    // A phone that is already paired keeps that pairing to prove itself with.
    if (invite) return { connection: null, notice: "", invite, previous: storedState().connection };
    return { connection: null, notice: "That pairing link is not valid. Create a fresh one on your computer.", invite: null };
  }
  if (url !== null || token !== null) {
    // Remove the secret before any network request or browser history entry can retain it.
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    try {
      const connection = validateConnection(url || "", token || "");
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(connection));
      } catch {
        /* Memory-only if storage is unavailable. */
      }
      storeNotice("");
      return { connection, notice: "" };
    } catch {
      return { connection: null, notice: "" };
    }
  }
  return storedState();
}

/** The pairing this browser already holds, from this tab or from the remembered phone. */
function storedState(): { connection: Connection | null; notice: string } {
  try {
    const saved = sessionStorage.getItem(storageKey);
    if (saved) {
      const value = JSON.parse(saved) as Connection & { device?: unknown };
      const device = parseDevice(value.device);
      if (!device || Date.parse(device.expiresAt) > Date.now()) {
        return {
          connection: {
            ...validateConnection(value.url, value.token),
            ...(device ? { device } : {}),
            ...(validSource(value.source) ? { source: value.source } : {}),
          },
          notice: readStoredNotice(),
        };
      }
      sessionStorage.removeItem(storageKey);
    }
  } catch {
    /* Fall through to remembered device storage. */
  }
  try {
    const raw = localStorage.getItem(deviceStorageKey);
    if (raw) {
      const value = JSON.parse(raw) as {
        url?: string;
        token?: string;
        device?: unknown;
        source?: unknown;
      };
      const device = parseDevice(value.device);
      if (!device) {
        clearPairingStorage();
        return { connection: null, notice: readStoredNotice() };
      }
      if (Date.parse(device.expiresAt) <= Date.now()) {
        clearPairingStorage();
        const expiredNotice =
          "This phone\u2019s pairing expired. Pair again from your computer.";
        storeNotice(expiredNotice);
        return { connection: null, notice: expiredNotice };
      }
      const connection: Connection = {
        ...validateConnection(value.url || "", value.token || ""),
        device,
        ...(validSource(value.source) ? { source: value.source } : {}),
      };
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(connection));
      } catch {
        /* Memory-only session mirror. */
      }
      return { connection, notice: readStoredNotice() };
    }
  } catch {
    clearPairingStorage();
  }
  return { connection: null, notice: readStoredNotice() };
}

export function demoRequests(): LoginRequest[] {
  const now = Date.now();
  return [
    {
      id: "demo-github",
      agent: "Claude Code",
      title: "Connect to GitHub",
      url: "https://github.com/login",
      origin: "https://github.com",
      reason:
        "I need to open a pull request for your dashboard updates. Sign in to GitHub so I can continue.",
      status: "pending",
      createdAt: new Date(now - 120000).toISOString(),
      expiresAt: new Date(now + 12 * 60000).toISOString(),
      updatedAt: new Date(now - 120000).toISOString(),
    },
    {
      id: "demo-vercel",
      agent: "Codex",
      title: "Deploy your latest work",
      url: "https://vercel.com/login",
      origin: "https://vercel.com",
      reason:
        "Your preview is ready to deploy. I need you to sign in to Vercel in this browser to publish it.",
      status: "pending",
      createdAt: new Date(now - 60000).toISOString(),
      expiresAt: new Date(now + 14 * 60000).toISOString(),
      updatedAt: new Date(now - 60000).toISOString(),
    },
    {
      id: "demo-linear",
      agent: "Antigravity",
      title: "Pick up the next issue",
      url: "https://linear.app/login",
      origin: "https://linear.app",
      reason:
        "Sign in to your Linear workspace so I can read the acceptance criteria for the next task.",
      status: "pending",
      createdAt: new Date(now - 20000).toISOString(),
      expiresAt: new Date(now + 15 * 60000).toISOString(),
      updatedAt: new Date(now - 20000).toISOString(),
    },
    {
      id: "demo-done",
      agent: "Codex",
      title: "Review project files",
      url: "https://github.com",
      origin: "https://github.com",
      reason: "Read the project documentation.",
      status: "completed",
      createdAt: new Date(now - 35 * 60000).toISOString(),
      expiresAt: new Date(now - 20 * 60000).toISOString(),
      updatedAt: new Date(now - 32 * 60000).toISOString(),
    },
  ];
}

export async function callBridge<T>(
  connection: Connection,
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(connection.url + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${connection.token}`,
      ...options?.headers,
    },
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    const fallback =
      response.status === 401 || response.status === 403
        ? "The owner token was not accepted. Check your pairing details and reconnect."
        : `The bridge returned ${response.status}. Please try again.`;
    throw new BridgeError(body.error || fallback, response.status);
  }
  return response.json() as Promise<T>;
}

export function useWorkspace(onError: (message: string) => void) {
  const [initial] = useState(initialState);
  const [connection, setConnection] = useState<Connection | null>(
    initial.connection,
  );
  const currentConnection = useRef(connection);
  currentConnection.current = connection;
  const connectionAttempt = useRef(0);
  const previousPairing = useRef(initial.previous ?? null);
  const followAddress = useRef<(source: Connection, record?: { sourceKey?: unknown; url?: unknown } | null) => Promise<void>>(async () => {});
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const moved = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; sourceKey?: unknown; url?: unknown } | null;
      if (data?.type === "bridge-address" && currentConnection.current) void followAddress.current(currentConnection.current, data);
    };
    navigator.serviceWorker.addEventListener("message", moved);
    return () => navigator.serviceWorker.removeEventListener("message", moved);
  }, []);
  const [pairingNotice, setPairingNotice] = useState(initial.notice);
  const [requests, setRequests] = useState<LoginRequest[]>(() =>
    initial.connection ? [] : demoRequests(),
  );
  const currentRequests = useRef(requests);
  currentRequests.current = requests;
  const [info, setInfo] = useState<BridgeInfo | null>(null);
  const currentInfo = useRef(info);
  currentInfo.current = info;
  const [status, setStatus] = useState<ConnectionStatus>(
    initial.connection ? "connecting" : "demo",
  );
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [pendingInvite, setPendingInvite] = useState<PairingInvite | null>(initial.invite ?? null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const inviteClaim = useRef<Promise<boolean> | null>(null);
  const [pairingError, setPairingError] = useState("");
  /** What the last tap left focused in the remote page, so the phone keyboard can follow. */
  const [typingTarget, setTypingTarget] = useState<{ requestId: string; editable: boolean; kind?: EditableKind; at: number } | null>(null);
  const viewport = useRef<ViewportRequest | null>(null);
  const [deviceEpoch, setDeviceEpoch] = useState(0);
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [navigationError, setNavigationError] = useState("");
  const [navigationAvailable, setNavigationAvailable] = useState(false);
  const [navigationUncertain, setNavigationUncertain] = useState(false);
  const uncertainNavigation = useRef<{ source: Connection; requestId: string; resumed: boolean } | null>(null);
  const navigationAttempt = useRef<NavigationAttempt | null>(null);
  const expectedFrameEpoch = useRef<string | null>(null);
  const [pageControls, setPageControls] = useState<{ requestId: string; snapshot: PageControlsSnapshot } | null>(null);
  const [focusedControl, setFocusedControl] = useState<{ requestId: string; snapshotId: string; controlId: string } | null>(null);
  const [controlsBusy, setControlsBusy] = useState(false);
  const [focusBusy, setFocusBusy] = useState(false);
  const [focusBlocked, setFocusBlockedState] = useState(false);
  const focusBlockedRef = useRef(false);
  const setFocusBlocked = useCallback((blocked: boolean) => {
    focusBlockedRef.current = blocked;
    setFocusBlockedState(blocked);
  }, []);
  const [controlsError, setControlsError] = useState("");
  const [error, setError] = useState("");
  const socket = useRef<WebSocket | null>(null);
  const socketSource = useRef<Connection | null>(null);
  const [transportEpoch, setTransportEpoch] = useState(0);
  const transportSource = useRef<Connection | null>(null);
  const watchId = useRef<string | null>(null);
  const transportWatchId = useRef<string | null>(null);
  const freshFrame = useRef<{ socket: WebSocket; requestId: string; navigationAvailable?: boolean; frameEpoch?: string } | null>(null);
  const [browserVisible, setBrowserVisible] = useState(() => document.visibilityState !== "hidden");
  const pageVisible = useRef(browserVisible);
  const [browserPaused, setBrowserPaused] = useState(() => !browserVisible);
  const paused = useRef(browserPaused);
  const inspectionAttempt = useRef<string | null>(null);
  const focusAttempt = useRef<{ snapshotId: string; controlId: string } | null>(null);
  const clearControls = useCallback((resetFocus = true) => {
    const blocked = !resetFocus && (focusBlockedRef.current || focusAttempt.current !== null);
    inspectionAttempt.current = null; focusAttempt.current = null;
    setPageControls(null); setFocusedControl(null); setControlsBusy(false); setFocusBusy(false); setFocusBlocked(blocked); setControlsError("");
  }, [setFocusBlocked]);
  const errorCallback = useRef(onError);
  errorCallback.current = onError;
  const activeRequest = useCallback((requestId: string, list = currentRequests.current) =>
    list.some(request => request.id === requestId && ["approved", "active"].includes(request.status) &&
      Date.parse(request.expiresAt) > Date.now()), []);
  const visible = useCallback(() => pageVisible.current && document.visibilityState !== "hidden", []);
  const abandonNavigation = useCallback((message = "", resetUncertain = false) => {
    const previous = navigationAttempt.current;
    if (previous && message) {
      uncertainNavigation.current = { source: previous.source, requestId: previous.requestId, resumed: false };
      setNavigationUncertain(true);
    }
    if (resetUncertain) { uncertainNavigation.current = null; setNavigationUncertain(false); }
    if (previous?.timer) clearTimeout(previous.timer);
    navigationAttempt.current = null;
    expectedFrameEpoch.current = null;
    setNavigationBusy(false);
    setNavigationError(message);
  }, []);
  useEffect(() => () => {
    if (navigationAttempt.current?.timer) clearTimeout(navigationAttempt.current.timer);
    navigationAttempt.current = null;
  }, []);
  const retireTransport = useCallback(() => {
    const previous = socket.current;
    // Invalidate callbacks synchronously, before React effect cleanup or close.
    socket.current = null;
    socketSource.current = null;
    transportWatchId.current = null;
    freshFrame.current = null;
    if (navigationAttempt.current)
      abandonNavigation("Navigation was not confirmed. Check the website before trying again.");
    if (previous?.readyState === WebSocket.OPEN) previous.send(JSON.stringify({ type: "unwatch" }));
    previous?.close();
    if (currentConnection.current) {
      setStatus("connecting");
      setTransportEpoch(epoch => epoch + 1);
    }
  }, [abandonNavigation]);
  const pauseBrowser = useCallback(() => {
    const alreadyPaused = paused.current;
    paused.current = true;
    setBrowserPaused(true);
    setFrame(null);
    clearControls(false);
    freshFrame.current = null;
    transportWatchId.current = null;
    if (!alreadyPaused) retireTransport();
  }, [clearControls, retireTransport]);
  useEffect(() => {
    const hide = () => {
      pageVisible.current = false;
      setBrowserVisible(false);
      pauseBrowser();
    };
    const show = () => {
      pageVisible.current = document.visibilityState !== "hidden";
      setBrowserVisible(pageVisible.current);
      if (!pageVisible.current) pauseBrowser();
      // Becoming visible never grants browser control. Resume is explicit.
    };
    const visibility = () => document.visibilityState === "hidden" ? hide() : show();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    visibility();
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  }, [pauseBrowser]);

  const invalidatePairing = useCallback(
    (activeConnection: Connection | null, message: string) => {
      if (currentConnection.current !== activeConnection) return;
      connectionAttempt.current++;
      clearPairingStorage();
      storeNotice(message);
      setPairingNotice(message);
      watchId.current = null;
      setConnection(null);
      setInfo(null);
      setFrame(null);
      abandonNavigation("", true);
      setNavigationAvailable(false);
      clearControls();
      setRequests(demoRequests());
      setStatus("demo");
      setError("");
    },
    [clearControls, abandonNavigation],
  );

  const api = useCallback(
    async <T>(path: string, options?: RequestInit): Promise<T> => {
      if (!connection) throw new Error("Connect your computer first.");
      try {
        return await callBridge<T>(connection, path, options);
      } catch (reason) {
        if (
          reason instanceof BridgeError &&
          reason.status === 404 &&
          path === "/api/devices"
        )
          throw new Error(
            "This bridge does not support remembered phones yet. Update Keep Safe on your computer. Tab-only pairing still works.",
          );
        if (
          reason instanceof BridgeError &&
          [401, 403].includes(reason.status) &&
          ["/api/info", "/api/requests", "/api/devices"].includes(path)
        ) {
          const message = connection.device
            ? "This phone\u2019s pairing expired or was revoked. Open a fresh pairing link from your computer."
            : "Your pairing was not accepted. Open a fresh pairing link from your computer.";
          invalidatePairing(connection, message);
          throw new Error(message);
        }
        throw reason;
      }
    },
    [connection, invalidatePairing],
  );

  useEffect(() => {
    if (!connection?.device) return;
    const remaining = Date.parse(connection.device.expiresAt) - Date.now();
    const timer = setTimeout(
      () =>
        invalidatePairing(
          connection,
          "This phone\u2019s pairing expired. Pair again from your computer.",
        ),
      // Timers cap near 24.8 days; a longer wait is re-armed by the refresh below.
      Math.min(Math.max(0, remaining), 2_000_000_000),
    );
    return () => clearTimeout(timer);
  }, [connection, invalidatePairing, deviceEpoch]);
  // The bridge extends an active phone's pairing. Mirror the new date locally so
  // this phone does not forget itself early. The connection object keeps its
  // identity: every in-flight guard compares against it.
  useEffect(() => {
    if (!connection?.device || status !== "connected") return;
    let cancelled = false;
    const refresh = () => {
      void callBridge<{ devices: PairedDevice[] }>(connection, "/api/devices").then(result => {
        const current = result.devices?.find(device => device.id === connection.device?.id);
        if (cancelled || currentConnection.current !== connection || !connection.device || !current || !Number.isFinite(Date.parse(current.expiresAt)) || current.expiresAt === connection.device.expiresAt) return;
        connection.device.expiresAt = current.expiresAt;
        try {
          if (localStorage.getItem(deviceStorageKey)) localStorage.setItem(deviceStorageKey, JSON.stringify({ version: 1, ...connection }));
          sessionStorage.setItem(storageKey, JSON.stringify(connection));
        } catch { /* The in-memory date still applies. */ }
        setDeviceEpoch(epoch => epoch + 1);
      }).catch(() => { /* The existing date stays in force. */ });
    };
    refresh();
    const timer = setInterval(refresh, 6 * 60 * 60 * 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [connection, status]);

  useEffect(() => {
    if (!connection) { transportSource.current = null; return; }
    const sourceChanged = transportSource.current !== connection;
    transportSource.current = connection;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let current: WebSocket | undefined;
    let attempts = 0;
    const open = () => {
      if (stopped || currentConnection.current !== connection) return;
      transportWatchId.current = null;
      freshFrame.current = null;
      expectedFrameEpoch.current = null;
      setStatus(attempts ? "reconnecting" : "connecting");
      current = new WebSocket(connection.url.replace(/^http/, "ws") + "/ws");
      socket.current = current;
      socketSource.current = connection;
      const ws = current;
      const currentSocket = () => !stopped && socket.current === ws && currentConnection.current === connection;
      const receivingBrowser = () => currentSocket() && !paused.current && visible() &&
        !!watchId.current && watchId.current === transportWatchId.current && activeRequest(watchId.current);
      ws.onopen = () => {
        if (currentSocket()) ws.send(JSON.stringify({ type: "auth", token: connection.token }));
      };
      ws.onmessage = (event) => {
        if (!currentSocket()) return;
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === "ready") {
          attempts = 0;
          setStatus("connected");
          setError("");
          setInfo(message.info);
          if (connection.device && !connection.source && validSource(message.info.vapidPublicKey)) {
            // Phones paired before address updates existed learn the key here.
            connection.source = message.info.vapidPublicKey;
            try {
              if (localStorage.getItem(deviceStorageKey)) localStorage.setItem(deviceStorageKey, JSON.stringify({ version: 1, ...connection }));
              sessionStorage.setItem(storageKey, JSON.stringify(connection));
            } catch { /* Kept in memory for this tab. */ }
          }
          currentRequests.current = message.requests;
          setRequests(message.requests);
          if (watchId.current && !paused.current && visible() && activeRequest(watchId.current, message.requests)) {
            transportWatchId.current = watchId.current;
            ws.send(
              JSON.stringify({ type: "watch", requestId: watchId.current, ...(viewport.current && message.info.liveViewAvailable ? { viewport: viewport.current } : {}) }),
            );
          }
        } else if (message.type === "requests") {
          currentRequests.current = message.requests;
          setRequests(message.requests);
          if (navigationAttempt.current && !activeRequest(navigationAttempt.current.requestId, message.requests)) {
            abandonNavigation();
            freshFrame.current = null;
          }
        }
        else if (message.type === "controls" && !navigationAttempt.current && receivingBrowser() && freshFrame.current?.socket === ws && message.requestId === watchId.current && message.inspectionId === inspectionAttempt.current) {
          inspectionAttempt.current = null;
          setPageControls({ requestId: message.requestId, snapshot: message.snapshot });
          setFocusedControl(null); setControlsBusy(false); setControlsError("");
        } else if (message.type === "focused" && !navigationAttempt.current && receivingBrowser() && freshFrame.current?.socket === ws && message.requestId === watchId.current && message.snapshotId === focusAttempt.current?.snapshotId && message.controlId === focusAttempt.current?.controlId) {
          focusAttempt.current = null;
          setFocusedControl(message); setFocusBusy(false); setFocusBlocked(false); setControlsError("");
        }
        else if (message.type === "editable" && receivingBrowser() && message.requestId === watchId.current) {
          setTypingTarget({ requestId: message.requestId, editable: message.editable === true, kind: message.kind, at: Date.now() });
        }
        else if (message.type === "navigated" && receivingBrowser()) {
          const pending = navigationAttempt.current;
          if (!pending || pending.socket !== ws || pending.source !== connection ||
            pending.requestId !== message.requestId || pending.navigationId !== message.navigationId ||
            pending.result || typeof message.frameEpoch !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.frameEpoch) ||
            message.frameEpoch === pending.previousEpoch || typeof message.ok !== "boolean") return;
          pending.result = { frameEpoch: message.frameEpoch, ok: message.ok, message: message.message };
          expectedFrameEpoch.current = message.frameEpoch;
        }
        else if (
          message.type === "frame" &&
          receivingBrowser() &&
          message.requestId === watchId.current
        ) {
          const pending = navigationAttempt.current;
          if (pending && (!pending.result || message.frameEpoch !== pending.result.frameEpoch)) return;
          if (expectedFrameEpoch.current && message.frameEpoch !== expectedFrameEpoch.current) return;
          if (pending) {
            if (pending.timer) clearTimeout(pending.timer);
            setNavigationError(pending.result?.ok ? "" : pending.result?.message || "The website could not be navigated. Check the page before trying again.");
            navigationAttempt.current = null;
            setNavigationBusy(false);
          }
          freshFrame.current = { socket: ws, requestId: message.requestId, navigationAvailable: message.navigationAvailable, frameEpoch: message.frameEpoch };
          if (uncertainNavigation.current?.resumed && uncertainNavigation.current.source === connection && uncertainNavigation.current.requestId === message.requestId) {
            uncertainNavigation.current = null;
            setNavigationUncertain(false);
          }
          setNavigationAvailable(message.navigationAvailable === true);
          setFrame(message);
        }
        else if (message.type === "error" && !paused.current && visible()) {
          if (navigationAttempt.current) {
            pauseBrowser();
            errorCallback.current("Navigation was not confirmed. Resume and check the website before trying again.");
            return;
          }
          // A fresh watch may be refused while an earlier accepted operation
          // drains, or another phone owns the browser. Keep explicit retry.
          if (transportWatchId.current && !freshFrame.current) pauseBrowser();
          inspectionAttempt.current = null; focusAttempt.current = null;
          setControlsBusy(false); setFocusBusy(false); setControlsError(message.message);
          errorCallback.current(message.message);
        }
      };
      ws.onerror = () => {
        if (!currentSocket()) return;
        setError(
          "Cannot reach your computer. Check that the bridge and your secure tunnel are running.",
        );
      };
      ws.onclose = (event) => {
        if (!currentSocket()) return;
        transportWatchId.current = null;
        freshFrame.current = null;
        setTypingTarget(null);
        if (navigationAttempt.current) {
          paused.current = true;
          setBrowserPaused(true);
          abandonNavigation("Navigation was not confirmed. Resume and check the website before trying again.");
        }
        setFrame(null);
        // Reconnecting to the same request does not confirm a failed/pending
        // browser focus. A full source/watch change resets the gate separately.
        clearControls(false);
        if (event.code === 4001 || event.code === 4401) {
          invalidatePairing(
            connection,
            connection.device
              ? "This phone\u2019s pairing expired or was revoked. Open a fresh pairing link from your computer."
              : "Pairing was rejected. Open a fresh pairing link from your computer.",
          );
          return;
        }
        attempts += 1;
        setStatus("reconnecting");
        // The computer's address may have changed: a notification carries the new one.
        void followAddress.current(connection);
        retry = setTimeout(
          open,
          Math.min(1000 * 2 ** Math.min(attempts, 4), 15000),
        );
      };
    };
    if (sourceChanged) {
      currentRequests.current = [];
      setRequests([]);
      setInfo(null);
      abandonNavigation("", true);
      setNavigationAvailable(false);
    }
    setFrame(null);
    clearControls(sourceChanged);
    setError("");
    // HTTP verifies pairing too, and provides a useful error when a socket is blocked.
    if (sourceChanged) void Promise.all([
      api<BridgeInfo>("/api/info"),
      api<LoginRequest[] | { requests: LoginRequest[] }>("/api/requests"),
    ])
      .then(([bridgeInfo, result]) => {
        if (!stopped && currentConnection.current === connection) {
          setInfo(bridgeInfo);
          setRequests(Array.isArray(result) ? result : result.requests);
        }
      })
      .catch((reason: unknown) => {
        if (!stopped && currentConnection.current === connection)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not connect to the bridge.",
          );
      });
    open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      current?.close();
      if (socket.current === current) socket.current = null;
    };
  }, [connection, api, invalidatePairing, clearControls, setFocusBlocked, transportEpoch, visible, activeRequest, pauseBrowser, abandonNavigation]);

  const connect = async (
    value: Connection,
    options?: { remember: boolean; name: string; notificationSubscription?: PushSubscriptionJSON; signal?: AbortSignal },
  ) => {
    const attempt = ++connectionAttempt.current;
    const superseded = () => attempt !== connectionAttempt.current || options?.signal?.aborted === true;
    if (superseded()) throw new Error("Pairing was cancelled. Your current connection is unchanged.");
    const checked = validateConnection(value.url, value.token);
    let next = checked;
    if (options?.remember) {
      if (value.device)
        throw new Error(
          "Use the owner token from your bridge to create a new remembered device.",
        );
      let result: DevicePairResult;
      try {
        result = await callBridge<DevicePairResult>(checked, "/api/devices", {
          method: "POST",
          body: JSON.stringify({ name: options.name.trim() || "My phone", ...(options.notificationSubscription ? { notificationSubscription: options.notificationSubscription } : {}) }),
        });
      } catch (reason) {
        if (reason instanceof BridgeError && reason.status === 404)
          throw new Error(
            "This bridge does not support remembered phones yet. Update Keep Safe on your computer, or connect without remembering.",
          );
        throw reason;
      }
      if (
        !result.device ||
        !result.token ||
        !Number.isFinite(Date.parse(result.device.expiresAt)) ||
        Date.parse(result.device.expiresAt) <= Date.now()
      )
        throw new Error(
          "The bridge returned invalid device details. Update the bridge and try again.",
        );
      next = {
        ...validateConnection(checked.url, result.token),
        device: result.device,
      };
      if (superseded()) {
        await callBridge(checked, `/api/devices/${encodeURIComponent(result.device.id)}/revoke`, { method: "POST", body: "{}" }).catch(() => {});
        throw new Error("Pairing changed before this phone could be remembered. Check the current connection and try again.");
      }
      try {
        // Only the newly issued device secret may enter persistent storage.
        clearPairingStorage();
        localStorage.setItem(
          deviceStorageKey,
          JSON.stringify({ version: 1, ...next }),
        );
      } catch {
        await callBridge(
          checked,
          `/api/devices/${encodeURIComponent(result.device.id)}/revoke`,
          { method: "POST", body: "{}" },
        ).catch(() => {});
        throw new Error(
          "This browser blocked persistent storage. Connect without remembering, or allow site storage and try again.",
        );
      }
    } else clearPairingStorage();
    adopt(next);
  };
  const adopt = (next: Connection) => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Memory-only pairing is supported. */
    }
    storeNotice("");
    setPairingNotice("");
    setPairingError("");
    watchId.current = null;
    abandonNavigation("", true);
    setNavigationAvailable(false);
    setConnection(next);
  };
  /** Moves a paired phone to the computer's new address. The key stays the same. */
  followAddress.current = async (source: Connection, record?: { sourceKey?: unknown; url?: unknown } | null) => {
    if (!source.device || !source.source) return;
    const found = record ?? await notifiedAddress();
    if (!found || found.sourceKey !== source.source || typeof found.url !== "string" || currentConnection.current !== source) return;
    let url: string;
    try { url = validateBridgeUrl(found.url); } catch { return; }
    if (url === source.url) return;
    const next: Connection = { ...source, url };
    try { if (localStorage.getItem(deviceStorageKey)) localStorage.setItem(deviceStorageKey, JSON.stringify({ version: 1, ...next })); }
    catch { /* The move still applies to this tab. */ }
    adopt(next);
  };
  /** Trades a one-time code for this phone's own revocable key. A phone that is
   * already paired with that computer keeps its key and only changes address. */
  const pairWithCode = async (invite: PairingInvite, name = defaultDeviceName()) => {
    const attempt = ++connectionAttempt.current;
    setPairingBusy(true);
    setPairingError("");
    try {
      const url = validateBridgeUrl(invite.url);
      const existing = currentConnection.current ?? previousPairing.current;
      const again = await relinkProof(existing, invite.code);
      let response: Response;
      try {
        response = await fetch(`${url}/api/pair`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: invite.code, name: name.trim().slice(0, 60) || defaultDeviceName(), ...(again ? { device: again } : {}) }),
          credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(15000),
        });
      } catch {
        throw new Error("Could not reach your computer. Check that it is awake and online, then run keep-safe pair there for a fresh code.");
      }
      const body = (await response.json().catch(() => ({}))) as Partial<DevicePairResult> & { error?: string; relinked?: boolean; info?: BridgeInfo };
      if (response.status === 404) throw new Error("Keep Safe on your computer is out of date. Update it, then pair again.");
      if (!response.ok) throw new Error(body.error || "That code did not work. Create a fresh one on your computer.");
      const token = body.relinked && existing?.device?.id === body.device?.id ? existing?.token : body.token;
      if (!body.device || !token || !Number.isFinite(Date.parse(body.device.expiresAt)))
        throw new Error("Your computer sent an unexpected answer. Update Keep Safe there and try again.");
      if (attempt !== connectionAttempt.current) throw new Error("Pairing was replaced by a newer attempt.");
      const next: Connection = { ...validateConnection(url, token), device: { ...body.device, current: true }, ...(validSource(body.info?.vapidPublicKey) ? { source: body.info.vapidPublicKey } : {}) };
      clearPairingStorage();
      try { localStorage.setItem(deviceStorageKey, JSON.stringify({ version: 1, ...next })); }
      catch { /* Private browsing: paired until this tab closes. */ }
      adopt(next);
      setPendingInvite(null);
      return true;
    } catch (reason) {
      if (attempt === connectionAttempt.current) setPairingError(reason instanceof Error ? reason.message : "Pairing failed. Try again.");
      return false;
    } finally {
      if (attempt === connectionAttempt.current) setPairingBusy(false);
    }
  };
  const disconnect = () => {
    connectionAttempt.current++;
    clearPairingStorage();
    storeNotice("");
    setPairingNotice("");
    watchId.current = null;
    setConnection(null);
    setInfo(null);
    setFrame(null);
    abandonNavigation("", true);
    setNavigationAvailable(false);
    clearControls();
    setRequests(demoRequests());
    setStatus("demo");
    setError("");
  };
  const forgetDevice = async () => {
    const previous = connection;
    // Forget the local secret immediately, even if the computer is offline.
    disconnect();
    if (!previous?.device) return true;
    try {
      await callBridge(
        previous,
        `/api/devices/${encodeURIComponent(previous.device.id)}/revoke`,
        { method: "POST", body: "{}" },
      );
      return true;
    } catch {
      return false;
    }
  };
  const send = useCallback((message: ClientMessage) => {
    // Navigation must use its correlated intent/epoch lifecycle below.
    if (message.type === "navigate") return false;
    const remoteAction = ["click", "scroll", "text", "key", "inspect-controls", "focus", "resize"].includes(message.type);
    if (remoteAction && (navigationAttempt.current || paused.current || !visible() || !watchId.current ||
      transportWatchId.current !== watchId.current || !activeRequest(watchId.current) ||
      freshFrame.current?.socket !== socket.current || freshFrame.current?.requestId !== watchId.current ||
      socketSource.current !== currentConnection.current)) {
      errorCallback.current(navigationAttempt.current ? "Wait for website navigation to finish." : paused.current || !visible()
        ? "Resume the browser before sending input."
        : "Wait for a fresh browser image before sending input.");
      return false;
    }
    if (socket.current?.readyState !== WebSocket.OPEN) {
      errorCallback.current(
        "Your computer is disconnected. Input was not sent.",
      );
      return false;
    }
    const recoversFocus = message.type === "click" ||
      (message.type === "key" && (message.key === "Tab" || message.key === "Shift+Tab"));
    if ((focusBlockedRef.current || focusAttempt.current !== null) && !recoversFocus &&
        (message.type === "text" || message.type === "key")) {
      const notice = "Confirm a field before sending input.";
      setControlsError(notice);
      errorCallback.current(notice);
      return false;
    }
    if (message.type === "click") setTypingTarget(null);
    if (message.type === "click" || message.type === "key") {
      focusAttempt.current = null; setFocusedControl(null); setFocusBusy(false);
      if (recoversFocus) { setFocusBlocked(false); setControlsError(""); }
    }
    socket.current.send(JSON.stringify(message));
    return true;
  }, [setFocusBlocked, visible, activeRequest]);
  const watch = useCallback((requestId: string | null) => {
    if (watchId.current === requestId) return;
    watchId.current = requestId;
    if (navigationAttempt.current) {
      pauseBrowser();
    } else abandonNavigation();
    if (requestId && uncertainNavigation.current && uncertainNavigation.current.requestId !== requestId) {
      uncertainNavigation.current = null;
      setNavigationUncertain(false);
    }
    setNavigationAvailable(false);
    transportWatchId.current = null;
    freshFrame.current = null;
    setFrame(null);
    setTypingTarget(null);
    clearControls();
    if (socket.current?.readyState === WebSocket.OPEN && socketSource.current === currentConnection.current) {
      const canWatch = requestId && !paused.current && visible() && activeRequest(requestId);
      if (canWatch) transportWatchId.current = requestId;
      socket.current.send(
        JSON.stringify(
          canWatch ? { type: "watch", requestId, ...(viewport.current && currentInfo.current?.liveViewAvailable ? { viewport: viewport.current } : {}) } : { type: "unwatch" },
        ),
      );
    }
  }, [clearControls, visible, activeRequest, abandonNavigation, pauseBrowser]);
  /** The live view reports the space it has. Used when the next browser opens,
   * and to resize one that is already on screen. */
  const setViewport = useCallback((next: ViewportRequest | null) => {
    const previous = viewport.current;
    viewport.current = next;
    if (!next || !previous || (previous.width === next.width && previous.height === next.height)) return;
    if (currentInfo.current?.liveViewAvailable && freshFrame.current && socket.current?.readyState === WebSocket.OPEN && freshFrame.current.socket === socket.current && !navigationAttempt.current && !paused.current)
      socket.current.send(JSON.stringify({ type: "resize", width: next.width, height: next.height }));
  }, []);
  const navigateBrowser = useCallback((direction: NavigationDirection) => {
    const ws = socket.current;
    const source = currentConnection.current;
    const requestId = watchId.current;
    if (!["back", "forward", "reload"].includes(direction) || navigationAttempt.current ||
      paused.current || !visible() || !source || !requestId || !activeRequest(requestId) ||
      !ws || ws.readyState !== WebSocket.OPEN || socketSource.current !== source ||
      transportWatchId.current !== requestId || freshFrame.current?.socket !== ws ||
      freshFrame.current?.requestId !== requestId || freshFrame.current?.navigationAvailable !== true ||
      currentInfo.current?.navigationAvailable !== true) return false;
    const pending: NavigationAttempt = { navigationId: crypto.randomUUID(), requestId, source, socket: ws, previousEpoch: freshFrame.current.frameEpoch };
    navigationAttempt.current = pending;
    freshFrame.current = null;
    expectedFrameEpoch.current = null;
    setNavigationBusy(true);
    setNavigationError("");
    setFrame(null);
    clearControls(false);
    setFocusBlocked(true);
    pending.timer = setTimeout(() => {
      if (navigationAttempt.current !== pending) return;
      pauseBrowser();
      errorCallback.current("Navigation was not confirmed. Resume and check the website before trying again.");
    }, 15000);
    try {
      ws.send(JSON.stringify({ type: "navigate", direction, navigationId: pending.navigationId }));
      return true;
    } catch {
      pauseBrowser();
      return false;
    }
  }, [visible, activeRequest, clearControls, setFocusBlocked, pauseBrowser]);
  const resumeBrowser = useCallback((requestId: string) => {
    if (!paused.current || !visible() || !currentConnection.current ||
      watchId.current !== requestId || !activeRequest(requestId)) return false;
    paused.current = false;
    if (uncertainNavigation.current?.source === currentConnection.current && uncertainNavigation.current.requestId === requestId)
      uncertainNavigation.current.resumed = true;
    setBrowserPaused(false);
    setFrame(null);
    clearControls(false);
    // Another controller or the website may have moved focus while paused.
    // A fresh image alone does not confirm a safe destination for text/keys.
    setFocusBlocked(true);
    retireTransport();
    return true;
  }, [visible, activeRequest, clearControls, setFocusBlocked, retireTransport]);
  const inspectControls = () => {
    if (navigationAttempt.current || paused.current || !visible() || freshFrame.current?.socket !== socket.current) return;
    inspectionAttempt.current = crypto.randomUUID(); focusAttempt.current = null;
    setPageControls(null); setFocusedControl(null); setFocusBusy(false); setControlsError("");
    const sent = send({ type: "inspect-controls", inspectionId: inspectionAttempt.current, includeFrames: true });
    setControlsBusy(sent);
  };
  const focusControl = (snapshotId: string, controlId: string) => {
    if (navigationAttempt.current || paused.current || !visible() || freshFrame.current?.socket !== socket.current) return;
    focusAttempt.current = { snapshotId, controlId }; setFocusBlocked(true);
    setFocusedControl(null); setControlsError("");
    setFocusBusy(send({ type: "focus", snapshotId, controlId }));
  };
  useEffect(() => {
    if (!controlsBusy && !focusBusy) return;
    const timer = setTimeout(() => {
      inspectionAttempt.current = null; focusAttempt.current = null;
      setControlsBusy(false); setFocusBusy(false);
      setControlsError("The browser did not confirm the action. Refresh page controls before trying again.");
    }, 8000);
    return () => clearTimeout(timer);
  }, [controlsBusy, focusBusy]);
  const action = async (
    requestId: string,
    actionName: "approve" | "deny" | "complete",
  ) => {
    if (actionName === "complete") {
      if (navigationAttempt.current?.requestId === requestId)
        throw new Error("Wait for website navigation to finish before handing back.");
      if (uncertainNavigation.current?.source === currentConnection.current && uncertainNavigation.current.requestId === requestId)
        throw new Error("Resume and check the website before handing back.");
    }
    if (!connection) {
      setRequests((previous) =>
        previous.map((request) =>
          request.id === requestId
            ? {
                ...request,
                status:
                  actionName === "approve"
                    ? "active"
                    : actionName === "deny"
                      ? "denied"
                      : "completed",
                updatedAt: new Date().toISOString(),
              }
            : request,
        ),
      );
      return;
    }
    await api(`/api/requests/${encodeURIComponent(requestId)}/${actionName}`, {
      method: "POST",
      body: "{}",
    });
    const result = await api<LoginRequest[] | { requests: LoginRequest[] }>(
      "/api/requests",
    );
    setRequests(Array.isArray(result) ? result : result.requests);
  };

  const clearHistory = async () => {
    const source = connection;
    const knownIds = new Set(requests.map(request => request.id));
    if (!source) {
      const time = Date.now();
      const remaining = requests.filter(request => !canClearHistory(request, time));
      setRequests(remaining);
      return {
        removed: requests.length - remaining.length,
        protected: remaining.filter(request => ["completed", "denied", "expired"].includes(request.status)).length,
      };
    }
    let result: HistoryCleanupResult;
    try {
      result = await api("/api/history/clear", { method: "POST", body: JSON.stringify({ confirm: true }) });
    } catch (reason) {
      if (reason instanceof BridgeError && reason.status === 404)
        throw new Error("Update the Keep Safe bridge on your computer to clear history.");
      throw reason;
    }
    if (currentConnection.current !== source)
      throw new Error("The connection changed. Check history on the current computer before trying again.");
    const retained = new Set(result.requests.map(request => request.id));
    // Keep requests that arrived over the live socket after this action began.
    setRequests(previous => currentConnection.current === source
      ? previous.filter(request => !knownIds.has(request.id) || retained.has(request.id))
      : previous);
    return { removed: result.removed, protected: result.protected };
  };

  return {
    connection,
    requests,
    info,
    status,
    frame,
    navigationBusy, navigationError, navigationAvailable, navigationUncertain, navigateBrowser,
    browserPaused, browserVisible, resumeBrowser,
    pageControls, focusedControl, controlsBusy, focusBusy, focusBlocked, controlsError, inspectControls, focusControl,
    error,
    pairingNotice,
    pendingInvite, pairingBusy, pairingError, pairWithCode,
    /** Claims the code this page was opened with. Safe to call twice. */
    claimPendingInvite: () => {
      if (!pendingInvite) return Promise.resolve(false);
      inviteClaim.current ??= pairWithCode(pendingInvite).finally(() => { inviteClaim.current = null; });
      return inviteClaim.current;
    },
    dropPendingInvite: () => setPendingInvite(null),
    clearPairingError: () => setPairingError(""),
    typingTarget, setViewport,
    dismissPairingNotice: () => {
      storeNotice("");
      setPairingNotice("");
    },
    api,
    connect,
    disconnect,
    forgetDevice,
    send,
    watch,
    action,
    clearHistory,
    resetDemo: () => setRequests(demoRequests()),
  };
}

export function canClearHistory(request: LoginRequest, time: number): boolean {
  return ["completed", "denied", "expired"].includes(request.status) && Date.parse(request.expiresAt) <= time;
}

export type Workspace = ReturnType<typeof useWorkspace>;
