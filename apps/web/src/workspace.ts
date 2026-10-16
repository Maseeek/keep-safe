import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BridgeInfo,
  ClientMessage,
  DevicePairResult,
  LoginRequest,
  PairedDevice,
  ServerMessage,
} from "../../../packages/shared/src/protocol";

export interface Connection {
  url: string;
  token: string;
  device?: PairedDevice;
}
export interface BrowserFrame {
  requestId: string;
  data: string;
  width: number;
  height: number;
  url: string;
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

export function validateConnection(url: string, token: string): Connection {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
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
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
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

function initialState(): { connection: Connection | null; notice: string } {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const url = params.get("bridge");
  const token = params.get("token");
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
      };
      const device = parseDevice(value.device);
      if (!device) {
        clearPairingStorage();
        return { connection: null, notice: readStoredNotice() };
      }
      if (Date.parse(device.expiresAt) <= Date.now()) {
        clearPairingStorage();
        const expiredNotice =
          "This phone\u2019s pairing expired. Open a fresh pairing link from your computer.";
        storeNotice(expiredNotice);
        return { connection: null, notice: expiredNotice };
      }
      const connection: Connection = {
        ...validateConnection(value.url || "", value.token || ""),
        device,
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

async function callBridge<T>(
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
  const [pairingNotice, setPairingNotice] = useState(initial.notice);
  const [requests, setRequests] = useState<LoginRequest[]>(() =>
    initial.connection ? [] : demoRequests(),
  );
  const [info, setInfo] = useState<BridgeInfo | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>(
    initial.connection ? "connecting" : "demo",
  );
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [error, setError] = useState("");
  const socket = useRef<WebSocket | null>(null);
  const watchId = useRef<string | null>(null);
  const errorCallback = useRef(onError);
  errorCallback.current = onError;

  const invalidatePairing = useCallback(
    (activeConnection: Connection | null, message: string) => {
      clearPairingStorage();
      storeNotice(message);
      setPairingNotice(message);
      watchId.current = null;
      setConnection(null);
      setInfo(null);
      setFrame(null);
      setRequests(demoRequests());
      setStatus("demo");
      setError("");
    },
    [],
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
          "This phone\u2019s seven-day pairing expired. Open a fresh pairing link from your computer.",
        ),
      Math.max(0, remaining),
    );
    return () => clearTimeout(timer);
  }, [connection, invalidatePairing]);

  useEffect(() => {
    if (!connection) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let current: WebSocket | undefined;
    let attempts = 0;
    const open = () => {
      if (stopped) return;
      setStatus(attempts ? "reconnecting" : "connecting");
      current = new WebSocket(connection.url.replace(/^http/, "ws") + "/ws");
      socket.current = current;
      const ws = current;
      ws.onopen = () =>
        ws.send(JSON.stringify({ type: "auth", token: connection.token }));
      ws.onmessage = (event) => {
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
          setRequests(message.requests);
          if (watchId.current)
            ws.send(
              JSON.stringify({ type: "watch", requestId: watchId.current }),
            );
        } else if (message.type === "requests") setRequests(message.requests);
        else if (
          message.type === "frame" &&
          message.requestId === watchId.current
        )
          setFrame(message);
        else if (message.type === "error")
          errorCallback.current(message.message);
      };
      ws.onerror = () => {
        setError(
          "Cannot reach your computer. Check that the bridge and your secure tunnel are running.",
        );
      };
      ws.onclose = (event) => {
        if (stopped) return;
        setFrame(null);
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
        retry = setTimeout(
          open,
          Math.min(1000 * 2 ** Math.min(attempts, 4), 15000),
        );
      };
    };
    setRequests([]);
    setInfo(null);
    setFrame(null);
    setError("");
    // HTTP verifies pairing too, and provides a useful error when a socket is blocked.
    Promise.all([
      api<BridgeInfo>("/api/info"),
      api<LoginRequest[] | { requests: LoginRequest[] }>("/api/requests"),
    ])
      .then(([bridgeInfo, result]) => {
        if (!stopped) {
          setInfo(bridgeInfo);
          setRequests(Array.isArray(result) ? result : result.requests);
        }
      })
      .catch((reason: unknown) => {
        if (!stopped)
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
      socket.current = null;
    };
  }, [connection, api, invalidatePairing]);

  const connect = async (
    value: Connection,
    options?: { remember: boolean; name: string },
  ) => {
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
          body: JSON.stringify({ name: options.name.trim() || "My phone" }),
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
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Memory-only pairing is supported. */
    }
    storeNotice("");
    setPairingNotice("");
    watchId.current = null;
    setConnection(next);
  };
  const disconnect = () => {
    clearPairingStorage();
    storeNotice("");
    setPairingNotice("");
    watchId.current = null;
    setConnection(null);
    setInfo(null);
    setFrame(null);
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
    if (socket.current?.readyState !== WebSocket.OPEN) {
      errorCallback.current(
        "Your computer is disconnected. Input was not sent.",
      );
      return false;
    }
    socket.current.send(JSON.stringify(message));
    return true;
  }, []);
  const watch = useCallback((requestId: string | null) => {
    if (watchId.current === requestId) return;
    watchId.current = requestId;
    setFrame(null);
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(
        JSON.stringify(
          requestId ? { type: "watch", requestId } : { type: "unwatch" },
        ),
      );
  }, []);
  const action = async (
    requestId: string,
    actionName: "approve" | "deny" | "complete",
  ) => {
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

  return {
    connection,
    requests,
    info,
    status,
    frame,
    error,
    pairingNotice,
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
    resetDemo: () => setRequests(demoRequests()),
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
