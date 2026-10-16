import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BridgeInfo,
  ClientMessage,
  LoginRequest,
  ServerMessage,
} from "../../../packages/shared/src/protocol";

export interface Connection {
  url: string;
  token: string;
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

function initialConnection(): Connection | null {
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
      return connection;
    } catch {
      return null;
    }
  }
  try {
    const saved = sessionStorage.getItem(storageKey);
    if (!saved) return null;
    const value = JSON.parse(saved) as Connection;
    return validateConnection(value.url, value.token);
  } catch {
    return null;
  }
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

export function useWorkspace(onError: (message: string) => void) {
  const [connection, setConnection] = useState<Connection | null>(
    initialConnection,
  );
  const [requests, setRequests] = useState<LoginRequest[]>(() =>
    connection ? [] : demoRequests(),
  );
  const [info, setInfo] = useState<BridgeInfo | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>(
    connection ? "connecting" : "demo",
  );
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [error, setError] = useState("");
  const socket = useRef<WebSocket | null>(null);
  const watchId = useRef<string | null>(null);
  const errorCallback = useRef(onError);
  errorCallback.current = onError;

  const api = useCallback(
    async <T>(path: string, options?: RequestInit): Promise<T> => {
      if (!connection) throw new Error("Connect your computer first.");
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
        if (response.status === 401 || response.status === 403)
          throw new Error(
            "The owner token was not accepted. Check your pairing details and reconnect.",
          );
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          body.error ||
            `The bridge returned ${response.status}. Please try again.`,
        );
      }
      return response.json() as Promise<T>;
    },
    [connection],
  );

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
        if (event.code === 1008 || event.code === 4001 || event.code === 4401) {
          setStatus("error");
          setError(
            "Pairing was rejected. Check the owner token and connect again.",
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
  }, [connection, api]);

  const connect = (value: Connection) => {
    const checked = validateConnection(value.url, value.token);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(checked));
    } catch {
      /* Memory-only is supported. */
    }
    setConnection(checked);
  };
  const disconnect = () => {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* No stored connection. */
    }
    watchId.current = null;
    setConnection(null);
    setInfo(null);
    setFrame(null);
    setRequests(demoRequests());
    setStatus("demo");
    setError("");
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
    api,
    connect,
    disconnect,
    send,
    watch,
    action,
    resetDemo: () => setRequests(demoRequests()),
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
