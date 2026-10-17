import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Bell,
  BellRing,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  Copy,
  ExternalLink,
  Inbox,
  Laptop,
  Link2,
  LoaderCircle,
  LockKeyhole,
  MonitorSmartphone,
  Radio,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Smartphone,
  Terminal,
  Unplug,
  X,
} from "lucide-react";
import type { LoginRequest } from "../../../packages/shared/src/protocol";
import { AgentMark, BrowserPanel, domain, timeLeft } from "./BrowserPanel";
import { useWorkspace, validateConnection, type Workspace } from "./workspace";
import { DeviceManager } from "./DeviceManager";
import { HistoryControls } from "./HistoryControls";
import { useNotifications } from "./useNotifications";

type Section = "inbox" | "activity" | "devices" | "settings";
type Filter = "all" | "pending" | "active";
const repository = "https://github.com/Maseeek/keep-safe";

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <a
      className={`brand ${compact ? "compact" : ""}`}
      href="/"
      aria-label="Keep Safe home"
    >
      <span className="brand-symbol">
        <ShieldCheck size={22} strokeWidth={1.8} />
      </span>
      {!compact ? (
        <span>
          keep<span className="brand-light">safe</span>
          <i />
        </span>
      ) : null}
    </a>
  );
}

function StatusPill({ request, now }: { request: LoginRequest; now: number }) {
  if (request.status === "completed")
    return (
      <span className="status-pill completed">
        <Check size={11} />
        Handed back
      </span>
    );
  if (request.status === "denied")
    return <span className="status-pill denied">Declined</span>;
  if (
    request.status === "expired" ||
    new Date(request.expiresAt).getTime() <= now
  )
    return <span className="status-pill expired">Expired</span>;
  if (request.status === "active" || request.status === "approved")
    return (
      <span className="status-pill active">
        <span className="live-dot" />
        In your hands
      </span>
    );
  return (
    <span className="status-pill pending">
      <span />
      Needs you
    </span>
  );
}

function RequestCard({
  request,
  selected,
  now,
  onClick,
}: {
  request: LoginRequest;
  selected: boolean;
  now: number;
  onClick: () => void;
}) {
  return (
    <button
      className={`request-card ${selected ? "is-selected" : ""}`}
      onClick={onClick}
    >
      <div className="request-card-top">
        <AgentMark name={request.agent} />
        <div className="request-agent">
          <strong>{request.agent}</strong>
          <span>{domain(request.origin)}</span>
        </div>
        <ChevronRight size={17} className="card-chevron" />
      </div>
      <h3>{request.title}</h3>
      <p>{request.reason}</p>
      <div className="request-card-bottom">
        <StatusPill request={request} now={now} />
        <span className="request-time">
          <Clock3 size={12} />
          {timeLeft(request.expiresAt, now)}
        </span>
      </div>
    </button>
  );
}

function EmptyState({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <CheckCheck size={28} strokeWidth={1.5} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

function Toast({ message, onDismiss, inline = false }: { message: string; onDismiss: () => void; inline?: boolean }) {
  return (
    <div className={`toast${inline ? " toast-inline" : ""}`} role="status">
      <span><Check size={15} /></span>
      <p>{message}</p>
      <button onClick={onDismiss} aria-label="Dismiss notification"><X size={16} /></button>
    </div>
  );
}

function ConnectDialog({
  workspace,
  onClose,
  notificationForRemember,
}: {
  workspace: Workspace;
  onClose: () => void;
  notificationForRemember: (connection: NonNullable<Workspace["connection"]>) => Promise<PushSubscriptionJSON | undefined>;
}) {
  const [url, setUrl] = useState(workspace.connection?.url || "");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [remember, setRemember] = useState(false);
  const [deviceName, setDeviceName] = useState("My phone");
  const [submitting, setSubmitting] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const pendingConnect = useRef<AbortController | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => pendingConnect.current?.abort();
  }, []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    const pending = new AbortController();
    pendingConnect.current?.abort();
    pendingConnect.current = pending;
    try {
      const connection = validateConnection(url, token);
      const notificationSubscription = remember ? await notificationForRemember(connection) : undefined;
      if (!dialog.current?.open || pending.signal.aborted) return;
      await workspace.connect(connection, {
        remember,
        name: deviceName,
        notificationSubscription,
        signal: pending.signal,
      });
      setToken("");
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Check your connection details.",
      );
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="connect-dialog"
      onCancel={(event) => {
        if (submitting) event.preventDefault();
        else onClose();
      }}
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          !submitting &&
          event.target === event.currentTarget &&
          (event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom)
        )
          onClose();
      }}
      aria-labelledby="connect-title"
    >
      <button
        className="icon-button dialog-close"
        onClick={onClose}
        disabled={submitting}
        aria-label="Close connection dialog"
      >
        <X size={20} />
      </button>
      <div className="dialog-icon">
        <MonitorSmartphone size={29} strokeWidth={1.5} />
      </div>
      <span className="eyebrow">ONE SECURE CONNECTION</span>
      <h2 id="connect-title">
        Bring your computer
        <br />
        along for the ride.
      </h2>
      <p>
        Start the Keep Safe bridge on your computer, then use its pairing link
        or enter the details below.
      </p>
      <form onSubmit={submit} className="connect-form">
        <label htmlFor="bridge-url">Bridge address</label>
        <input
          autoFocus
          id="bridge-url"
          type="url"
          placeholder="https://your-secure-tunnel.example"
          autoComplete="off"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          required
        />
        <label htmlFor="owner-token">
          Owner token <span>from your bridge terminal</span>
        </label>
        <input
          id="owner-token"
          type="password"
          placeholder="Paste your owner token"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          required
        />
        <label className="remember-choice">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            disabled={submitting}
          />
          <span>
            <strong>Remember this phone for 7 days</strong>
            <small>
              A separate, revocable device key is saved on this phone. Your
              owner token is never saved across sessions.
            </small>
          </span>
        </label>
        {remember ? (
          <>
            <label htmlFor="pair-device-name">Device name</label>
            <input
              id="pair-device-name"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              maxLength={60}
              placeholder="My phone"
              disabled={submitting}
              required
            />
          </>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="pairing-note">
          <LockKeyhole size={15} />
          <span>
            {remember
              ? "Remember only on a phone you trust. You can revoke its access from Connections."
              : "This pairing lasts for this browser tab only. Close the tab to end it."}{" "}
            Use HTTPS when connecting from your phone.
          </span>
        </div>
        <button
          className="button button-dark"
          type="submit"
          disabled={submitting}
        >
          {submitting ? <LoaderCircle size={16} className="spin" /> : null}
          {submitting ? "Pairing your phone…" : "Connect securely"}{" "}
          <ArrowRight size={17} />
        </button>
      </form>
      <a
        className="text-link dialog-docs"
        href={`${repository}/blob/main/README.md`}
        target="_blank"
        rel="noreferrer"
      >
        Need a hand? Read the setup guide <ExternalLink size={13} />
      </a>
    </dialog>
  );
}

function OnboardingArt() {
  return (
    <div className="onboarding-art" aria-hidden="true">
      <div className="orbit orbit-1" />
      <div className="orbit orbit-2" />
      <div className="art-central">
        <ShieldCheck size={34} strokeWidth={1.4} />
      </div>
      <div className="art-agent art-claude">✳</div>
      <div className="art-agent art-codex">⌘</div>
      <div className="art-agent art-gravity">A</div>
      <span className="art-star star-1">✧</span>
      <span className="art-star star-2">✧</span>
      <span className="art-dot" />
    </div>
  );
}

export function App() {
  const [section, setSection] = useState<Section>("inbox");
  const [selectedId, setSelectedId] = useState<string | null>(
    () =>
      new URLSearchParams(window.location.hash.slice(1)).get("request") ||
      new URLSearchParams(window.location.search).get("request"),
  );
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [connectOpen, setConnectOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [mobileLayout, setMobileLayout] = useState(
    () => window.matchMedia("(max-width: 760px)").matches,
  );
  const detailSection = useRef<HTMLDivElement>(null);
  const notify = useCallback((message: string) => setToast(message), []);
  const workspace = useWorkspace(notify);
  const notifications = useNotifications(workspace, notify);
  const notificationEnableButton = useRef<HTMLButtonElement>(null);
  const notificationContext = useRef({ section, connection: workspace.connection, key: workspace.info?.vapidPublicKey });
  notificationContext.current = { section, connection: workspace.connection, key: workspace.info?.vapidPublicKey };
  const turnOffNotifications = async (event: MouseEvent<HTMLButtonElement>) => {
    const source = notificationContext.current;
    const initiator = event.currentTarget;
    const restoreFocus = document.activeElement === initiator;
    if (!await notifications.disable() || !restoreFocus) return;
    requestAnimationFrame(() => {
      const current = notificationContext.current;
      const focusUnchanged = document.activeElement === initiator || document.activeElement === document.body;
      if (focusUnchanged && current.section === "settings" && current.connection === source.connection && current.key === source.key)
        notificationEnableButton.current?.focus();
    });
  };
  const isDemo = !workspace.connection;
  const current = workspace.requests.filter(
    (request) =>
      ["pending", "approved", "active"].includes(request.status) &&
      new Date(request.expiresAt).getTime() > now,
  );
  const history = workspace.requests.filter(
    (request) => !current.includes(request),
  );
  const pending = current.filter((request) => request.status === "pending");
  const inProgress = current.filter((request) => request.status !== "pending");
  const filtered = current.filter(
    (request) =>
      (filter === "all" ||
        (filter === "pending"
          ? request.status === "pending"
          : request.status !== "pending")) &&
      `${request.agent} ${request.title} ${request.origin}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const selected =
    workspace.requests.find((request) => request.id === selectedId) ||
    filtered[0];

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setMobileLayout(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!mobileLayout || !selectedId || section !== "inbox") return;
    const returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    detailSection.current?.scrollTo({ top: 0 });
    detailSection.current?.focus({ preventScroll: true });
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector("dialog[open]"))
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        setSelectedId(null);
      }
      if (event.key === "Tab") {
        const targets = Array.from(
          detailSection.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]',
          ) || [],
        ).filter((element) => element.getClientRects().length);
        const first = targets[0];
        const last = targets.at(-1);
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === detailSection.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            document.activeElement === detailSection.current)
        ) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keys);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keys);
      returnFocus?.focus({ preventScroll: true });
    };
  }, [mobileLayout, selectedId, section]);
  useEffect(() => {
    if (
      mobileLayout &&
      selectedId &&
      selected &&
      ["completed", "denied", "expired"].includes(selected.status)
    ) {
      detailSection.current?.scrollTo({ top: 0 });
      detailSection.current?.focus({ preventScroll: true });
    }
  }, [mobileLayout, selectedId, selected?.status]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if ("serviceWorker" in navigator && window.isSecureContext)
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* The dashboard works without push. */
      });
    if (!("serviceWorker" in navigator)) return;
    const openRequest = (event: MessageEvent) => {
      if (
        event.data?.type === "open-request" &&
        typeof event.data.requestId === "string"
      ) {
        setSelectedId(event.data.requestId);
        setSection("inbox");
      }
    };
    navigator.serviceWorker.addEventListener("message", openRequest);
    return () =>
      navigator.serviceWorker.removeEventListener("message", openRequest);
  }, []);

  const takeAction = async (
    id: string,
    action: "approve" | "deny" | "complete",
  ) => {
    setBusy(true);
    try {
      await workspace.action(id, action);
      notify(
        action === "approve"
          ? isDemo
            ? "Demo session opened. Try the handoff below."
            : "You’re in control. Sign in, then hand back to your agent."
          : action === "complete"
            ? "Handed back. Your agent can keep going."
            : "Request declined. Your agent has been notified.",
      );
    } catch (reason) {
      notify(
        reason instanceof Error
          ? reason.message
          : "This action could not be completed. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const navigate = (next: Section) => {
    setSection(next);
    setSelectedId(null);
  };
  const exportHistory = () => {
    const file = new Blob(
      [
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            demo: isDemo,
            requests: history,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const link = document.createElement("a");
    link.href = URL.createObjectURL(file);
    link.download = "keep-safe-activity.json";
    link.click();
    URL.revokeObjectURL(link.href);
    notify(
      "Activity exported. Browser sessions and credentials are never included.",
    );
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <div className="workspace-switch">
          <span className="workspace-avatar">
            M<span />
          </span>
          <div>
            <strong>{isDemo ? "Demo workspace" : "My workspace"}</strong>
            <small>
              {isDemo ? "Take a look around" : "Your personal bridge"}
            </small>
          </div>
          <ChevronDown size={14} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="main-nav" aria-label="Main navigation">
          <button
            className={section === "inbox" ? "active" : ""}
            aria-current={section === "inbox" ? "page" : undefined}
            onClick={() => navigate("inbox")}
          >
            <Inbox size={18} />
            Inbox
            {current.length ? (
              <span className="nav-count">{current.length}</span>
            ) : null}
          </button>
          <button
            className={section === "activity" ? "active" : ""}
            aria-current={section === "activity" ? "page" : undefined}
            onClick={() => navigate("activity")}
          >
            <Activity size={18} />
            Activity
          </button>
          <button
            className={section === "devices" ? "active" : ""}
            aria-current={section === "devices" ? "page" : undefined}
            onClick={() => navigate("devices")}
          >
            <MonitorSmartphone size={18} />
            Connections{!isDemo ? <span className="nav-connected" /> : null}
          </button>
          <button
            className={section === "settings" ? "active" : ""}
            aria-current={section === "settings" ? "page" : undefined}
            onClick={() => navigate("settings")}
          >
            <Settings2 size={18} />
            Settings
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <div>
              <span className="little-spark">✧</span>
              <span>
                Made for your
                <br />
                <strong>away-from-desk era.</strong>
              </span>
            </div>
            <p>
              Your agents keep working.
              <br />
              You keep living.
            </p>
          </div>
          <a
            className="sidebar-link"
            href={repository}
            target="_blank"
            rel="noreferrer"
          >
            <Code2 size={16} />
            View on GitHub
            <ExternalLink size={12} />
          </a>
          <span className="version">
            KEEP SAFE <span>EARLY ACCESS · v0.1</span>
          </span>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="mobile-brand">
            <Logo />
          </div>
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <strong>
              {section === "inbox"
                ? "Inbox"
                : section === "activity"
                  ? "Activity"
                  : section === "devices"
                    ? "Connections"
                    : "Settings"}
            </strong>
          </div>
          <div className="topbar-actions">
            <span
              className={`bridge-status ${workspace.status === "connected" ? "online" : ""}`}
            >
              <span />
              {isDemo
                ? "Demo mode"
                : workspace.status === "connected"
                  ? "Bridge connected"
                  : workspace.status === "connecting"
                    ? "Connecting…"
                    : "Bridge offline"}
            </span>
            <button
              className="icon-button notification-button"
              aria-label="Set up phone notifications"
              onClick={() => navigate("settings")}
            >
              {notifications.enabled ? (
                <BellRing size={19} />
              ) : (
                <Bell size={19} />
              )}
              <i />
            </button>
            <div
              className="user-avatar"
              aria-label={isDemo ? "Demo workspace" : "My workspace"}
            >
              M
            </div>
          </div>
        </header>
        <div className="page-content">
          {workspace.pairingNotice ? (
            <div className="pairing-expired-notice" role="status">
              <ShieldCheck size={18} />
              <p>{workspace.pairingNotice}</p>
              <button
                className="text-link"
                onClick={() => setConnectOpen(true)}
              >
                Pair again <ArrowRight size={13} />
              </button>
              <button
                className="icon-button"
                aria-label="Dismiss pairing notice"
                onClick={workspace.dismissPairingNotice}
              >
                <X size={15} />
              </button>
            </div>
          ) : null}
          {isDemo ? (
            <div className="demo-banner">
              <span className="demo-badge">DEMO</span>
              <p>
                You’re exploring a demo workspace.{" "}
                <span>No real browser is connected.</span>
              </p>
              <button onClick={() => setConnectOpen(true)}>
                Connect your computer <ArrowUpRightIcon />
              </button>
            </div>
          ) : workspace.status !== "connected" ? (
            <div className="connection-banner" role="status">
              <LoaderCircle size={16} className="spin" />
              <div>
                <strong>
                  {workspace.status === "error"
                    ? "Connection needs attention"
                    : "Looking for your computer…"}
                </strong>
                <p>
                  {workspace.error ||
                    "Keep your computer, bridge, and tunnel running. We’ll reconnect automatically."}
                </p>
              </div>
              <button
                className="text-link"
                onClick={() => setConnectOpen(true)}
              >
                Check pairing <ArrowRight size={14} />
              </button>
            </div>
          ) : null}
          {section === "inbox" ? (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">A HUMAN TOUCH GOES A LONG WAY</span>
                  <h1>
                    Your agents. <span>Still moving.</span>
                  </h1>
                  <p>
                    A quick sign-in from you. A whole lot of progress from them.
                  </p>
                </div>
                <span className="heading-flower" aria-hidden="true">
                  ✳
                </span>
              </div>
              <div className="overview-strip">
                <div className="overview-item">
                  <span className="overview-icon waiting">
                    <Inbox size={18} />
                  </span>
                  <div>
                    <span>Waiting for you</span>
                    <strong>{String(pending.length).padStart(2, "0")}</strong>
                  </div>
                  <span className="overview-caption">A little help needed</span>
                </div>
                <div className="overview-item">
                  <span className="overview-icon running">
                    <Radio size={18} />
                  </span>
                  <div>
                    <span>In your hands</span>
                    <strong>
                      {String(inProgress.length).padStart(2, "0")}
                    </strong>
                  </div>
                  <span className="overview-caption">You’re in control</span>
                </div>
                <div className="overview-item">
                  <span className="overview-icon done">
                    <CheckCheck size={18} />
                  </span>
                  <div>
                    <span>Handed back</span>
                    <strong>
                      {String(
                        history.filter(
                          (request) => request.status === "completed",
                        ).length,
                      ).padStart(2, "0")}
                    </strong>
                  </div>
                  <span className="overview-caption">Back to building</span>
                </div>
              </div>
              <div
                className={`inbox-layout ${selectedId ? "has-selection" : ""}`}
              >
                <section className="queue-section" aria-label="Request inbox">
                  <div className="section-title">
                    <h2>
                      Your inbox <span>{current.length}</span>
                    </h2>
                    <button
                      className="icon-button"
                      onClick={() => {
                        if (isDemo) {
                          workspace.resetDemo();
                          setSelectedId(null);
                          notify(
                            "Demo workspace reset. Three agents are ready for your help.",
                          );
                        } else navigate("devices");
                      }}
                      aria-label={
                        isDemo
                          ? "Reset demo requests"
                          : "View bridge connection"
                      }
                    >
                      {isDemo ? <RotateCcw size={16} /> : <Link2 size={16} />}
                    </button>
                  </div>
                  <div
                    className="queue-filters"
                    role="group"
                    aria-label="Filter requests"
                  >
                    <button
                      className={filter === "all" ? "selected" : ""}
                      aria-pressed={filter === "all"}
                      onClick={() => setFilter("all")}
                    >
                      All requests
                    </button>
                    <button
                      className={filter === "pending" ? "selected" : ""}
                      aria-pressed={filter === "pending"}
                      onClick={() => setFilter("pending")}
                    >
                      Needs you <span>{pending.length}</span>
                    </button>
                    <button
                      className={filter === "active" ? "selected" : ""}
                      aria-pressed={filter === "active"}
                      onClick={() => setFilter("active")}
                    >
                      Active
                    </button>
                  </div>
                  <label className="search-field">
                    <Search size={15} />
                    <input
                      type="search"
                      placeholder="Find an agent or website…"
                      aria-label="Search requests"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    <span>⌕</span>
                  </label>
                  <div className="request-list">
                    {filtered.length ? (
                      filtered.map((request) => (
                        <RequestCard
                          key={request.id}
                          request={request}
                          selected={selected?.id === request.id}
                          now={now}
                          onClick={() => setSelectedId(request.id)}
                        />
                      ))
                    ) : (
                      <EmptyState
                        title={
                          query
                            ? "No matching requests."
                            : filter === "active"
                              ? "No sessions open."
                              : "You’re all caught up."
                        }
                        text={
                          query
                            ? "Try another agent name or website."
                            : filter === "active"
                              ? "Approve a request to take the browser into your hands."
                              : "Your agents will send a request when they need you. Get back to your day."
                        }
                        action={
                          isDemo ? (
                            <button
                              className="button button-light button-small"
                              onClick={() => {
                                workspace.resetDemo();
                                setFilter("all");
                                setQuery("");
                              }}
                            >
                              Reset demo <RotateCcw size={13} />
                            </button>
                          ) : undefined
                        }
                      />
                    )}
                  </div>
                  <p className="queue-footnote">
                    <ShieldCheck size={13} />
                    Only you can approve these requests.
                  </p>
                </section>
                <div
                  className="detail-section"
                  ref={detailSection}
                  tabIndex={-1}
                  role={mobileLayout && selectedId ? "dialog" : undefined}
                  aria-modal={mobileLayout && selectedId ? true : undefined}
                  aria-label={
                    mobileLayout && selectedId ? "Browser request" : undefined
                  }
                >
                  {mobileLayout && selectedId && toast ? (
                    <Toast message={toast} onDismiss={() => setToast("")} inline />
                  ) : null}
                  {selected && (!mobileLayout || selectedId) ? (
                    <BrowserPanel
                      request={selected}
                      workspace={workspace}
                      now={now}
                      busy={busy}
                      onAction={takeAction}
                      onBack={() => setSelectedId(null)}
                    />
                  ) : (
                    <div className="no-selection">
                      <OnboardingArt />
                      <h2>
                        They build.
                        <br />
                        You do your thing.
                      </h2>
                      <p>
                        When an agent needs a sign-in, you’ll see its request
                        here.
                      </p>
                      <button
                        className="button button-light"
                        onClick={() => navigate("settings")}
                      >
                        <Bell size={15} />
                        Notify me
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div className="bottom-tip">
                <span className="tip-icon">
                  <Smartphone size={18} />
                </span>
                <p>
                  <strong>Go ahead, step away.</strong> Add Keep Safe to your
                  Home Screen for a faster handoff.
                </p>
                <button
                  className="text-link"
                  onClick={() => navigate("settings")}
                >
                  Get set up <ArrowRight size={14} />
                </button>
              </div>
            </>
          ) : section === "activity" ? (
            <>
              <div className="page-heading simple-heading">
                <div>
                  <span className="eyebrow">
                    THE LITTLE THINGS THAT KEEP WORK MOVING
                  </span>
                  <h1>
                    A trail of <span>helping hands.</span>
                  </h1>
                  <p>Closed requests, without the private browser content.</p>
                </div>
                <button
                  className="button button-light button-small"
                  onClick={exportHistory}
                  disabled={!history.length}
                >
                  <ArrowDownToLine size={15} />
                  Export
                </button>
              </div>
              <div className="content-card activity-card">
                <div className="section-title">
                  <h2>
                    Recent activity <span>{history.length}</span>
                  </h2>
                  <span className="subtle-label">
                    {isDemo ? "DEMO HISTORY" : "THIS BRIDGE"}
                  </span>
                </div>
                {history.length ? (
                  <div className="activity-list">
                    {[...history]
                      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                      .map((request) => (
                        <button
                          className="activity-row"
                          key={request.id}
                          onClick={() => {
                            setSelectedId(request.id);
                            setSection("inbox");
                          }}
                        >
                          <AgentMark name={request.agent} small />
                          <div>
                            <strong>{request.title}</strong>
                            <span>
                              {request.agent} · {domain(request.origin)}
                            </span>
                          </div>
                          <StatusPill request={request} now={now} />
                          <time>
                            {new Date(request.updatedAt).toLocaleTimeString(
                              [],
                              { hour: "2-digit", minute: "2-digit" },
                            )}
                          </time>
                          <ChevronRight size={15} />
                        </button>
                      ))}
                  </div>
                ) : (
                  <EmptyState
                    title="A fresh start."
                    text="Requests appear here after you hand back, decline, or let them expire."
                  />
                )}
              </div>
              <HistoryControls workspace={workspace} now={now} notify={notify} />
              <div className="privacy-strip">
                <ShieldCheck size={19} />
                <p>
                  History records what happened to the request. Passwords,
                  cookies, and browser frames aren’t part of it.
                </p>
              </div>
            </>
          ) : section === "devices" ? (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">
                    YOUR COMPUTER, WHEREVER YOU ARE
                  </span>
                  <h1>
                    A small bridge.
                    <br />
                    <span>A little more freedom.</span>
                  </h1>
                  <p>Connect once. Help any of your agents from your phone.</p>
                </div>
                <OnboardingArt />
              </div>
              <DeviceManager workspace={workspace} notify={notify} notificationForRemember={notifications.forRemember} />
              <div className="setup-grid">
                <section className="content-card device-card">
                  <div className="section-title">
                    <h2>Your connection</h2>
                    <span
                      className={`status-pill ${isDemo ? "expired" : workspace.status === "connected" ? "active" : "pending"}`}
                    >
                      {isDemo
                        ? "Not connected"
                        : workspace.status === "connected"
                          ? "Connected"
                          : "Reconnecting"}
                    </span>
                  </div>
                  <div className="computer-illustration">
                    <Laptop size={68} strokeWidth={1} />
                    <span>
                      <ShieldCheck size={20} />
                    </span>
                  </div>
                  <h3>
                    {isDemo
                      ? "Bring your own browser."
                      : workspace.info?.name || "Your computer"}
                  </h3>
                  <p>
                    {isDemo
                      ? "A free, local bridge keeps the browser and its cookies on your computer. Your phone gets a secure, temporary window into it."
                      : workspace.connection?.url}
                  </p>
                  <button
                    className="button button-dark"
                    onClick={() => setConnectOpen(true)}
                  >
                    <Link2 size={16} />
                    {isDemo ? "Connect your computer" : "Update pairing"}
                    <ArrowRight size={16} />
                  </button>
                  {!isDemo && !workspace.connection?.device ? (
                    <button
                      className="text-link disconnect-link"
                      onClick={() => {
                        workspace.disconnect();
                        setSelectedId(null);
                        notify(
                          "Disconnected. Pairing details were removed from this tab.",
                        );
                      }}
                    >
                      <Unplug size={14} />
                      Disconnect this tab
                    </button>
                  ) : null}
                </section>
                <section className="content-card setup-card">
                  <div className="section-title">
                    <h2>Three steps. Then go.</h2>
                    <span className="subtle-label">SELF-HOSTED · £0</span>
                  </div>
                  <ol className="setup-steps">
                    <li>
                      <span>01</span>
                      <div>
                        <h3>Start the bridge</h3>
                        <p>
                          Clone the private repository on the computer your
                          agents use, install dependencies, then start Keep
                          Safe.
                        </p>
                        <div className="code-snippet">
                          <Terminal size={14} />
                          <code>npm run bridge</code>
                          <button
                            className="icon-button"
                            aria-label="Copy bridge command"
                            onClick={() => {
                              navigator.clipboard
                                .writeText("npm run bridge")
                                .then(() => notify("Bridge command copied."))
                                .catch(() =>
                                  notify(
                                    "Run npm run bridge in the repository folder.",
                                  ),
                                );
                            }}
                          >
                            <Copy size={14} />
                          </button>
                        </div>
                      </div>
                    </li>
                    <li>
                      <span>02</span>
                      <div>
                        <h3>Pair your phone</h3>
                        <p>
                          Use a secure HTTPS tunnel or private network. Open the
                          pairing link printed by the bridge on your phone.
                        </p>
                        <p>
                          Run <code>npm run bridge -- setup</code> on your
                          computer for connection commands. If pairing fails,
                          the connection guide explains the diagnostic checks.
                        </p>
                        <a
                          className="text-link"
                          href={`${repository}/blob/main/docs/connection.md`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Connection guide <ExternalLink size={13} />
                        </a>
                      </div>
                    </li>
                    <li>
                      <span>03</span>
                      <div>
                        <h3>Give your agents the tool</h3>
                        <p>
                          Add the Keep Safe MCP server to T3 Code, Claude,
                          Codex, or any MCP-compatible agent.
                        </p>
                        <a
                          className="text-link"
                          href={`${repository}/blob/main/README.md`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Full setup & agent configuration{" "}
                          <ExternalLink size={13} />
                        </a>
                      </div>
                    </li>
                  </ol>
                </section>
              </div>
              <div className="supported-agents">
                <span>ONE BRIDGE. YOUR WHOLE CREW.</span>
                <div>
                  <span>
                    <AgentMark name="Claude Code" small />
                    Claude Code
                  </span>
                  <span>
                    <AgentMark name="Codex" small />
                    Codex
                  </span>
                  <span>
                    <AgentMark name="Antigravity" small />
                    Antigravity
                  </span>
                  <span>
                    <Code2 size={20} />
                    T3 Code + any MCP agent
                  </span>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="page-heading simple-heading">
                <div>
                  <span className="eyebrow">MAKE YOURSELF AT HOME</span>
                  <h1>
                    A few <span>good defaults.</span>
                  </h1>
                  <p>Less to manage. More peace of mind.</p>
                </div>
                <Settings2
                  size={38}
                  strokeWidth={1.1}
                  className="settings-heading-icon"
                />
              </div>
              <div className="settings-grid">
                <section className="content-card settings-card">
                  <div className="settings-section-icon">
                    <Bell size={22} />
                  </div>
                  <h2>A nudge when you’re needed.</h2>
                  <p>
                    Get a phone notification when an agent sends a request. You
                    stay in charge of when to open it.
                  </p>
                  <p className={notifications.error ? "notification-status error" : "notification-status"} role={notifications.error ? "alert" : "status"}>{notifications.message}</p>
                  <div className="notification-actions" aria-busy={notifications.busy || notifications.checking}>
                    <button
                      className="button button-dark"
                      ref={notificationEnableButton}
                      disabled={notifications.busy || notifications.checking || notifications.enabled}
                      onClick={notifications.enable}
                    >
                      {notifications.busy || notifications.checking ? <LoaderCircle size={16} className="spin" /> : notifications.enabled ? <Check size={16} /> : <Bell size={16} />}
                      {notifications.enabled ? "Notifications enabled" : "Enable notifications"}
                    </button>
                    {notifications.enabled && notifications.canDisable ? <button className="button button-light" disabled={notifications.busy} onClick={turnOffNotifications}>Turn off notifications</button> : null}
                    {notifications.canCheck ? <button className="button button-light" disabled={notifications.busy || notifications.checking} onClick={notifications.refresh}>Check notification status</button> : null}
                  </div>
                  <p className="settings-note">Enrollment confirms this computer is registered to send alerts. It does not confirm delivery. Turning alerts off keeps this phone paired and leaves browser permission unchanged.</p>
                  <div className="ios-note">
                    <Smartphone size={17} />
                    <p>
                      <strong>On an iPhone?</strong> Open this app in Safari,
                      tap Share → Add to Home Screen, then launch it from there
                      to enable notifications.
                    </p>
                  </div>
                </section>
                <section className="content-card settings-card privacy-card">
                  <div className="settings-section-icon">
                    <ShieldCheck size={22} />
                  </div>
                  <h2>Private, by design.</h2>
                  <p>
                    Your browser runs on your computer. You decide which
                    requests to open.
                  </p>
                  <ul className="privacy-list">
                    <li>
                      <Check size={15} />
                      <div>
                        <strong>No saved passwords</strong>
                        <span>
                          Text goes to the live website. Keep Safe never saves
                          it.
                        </span>
                      </div>
                    </li>
                    <li>
                      <Check size={15} />
                      <div>
                        <strong>Cookies stay local</strong>
                        <span>
                          The browser profile stays on your computer, never in
                          this hosted dashboard.
                        </span>
                      </div>
                    </li>
                    <li>
                      <Check size={15} />
                      <div>
                        <strong>Temporary control</strong>
                        <span>
                          Requests expire. Handing back closes your control of
                          the browser.
                        </span>
                      </div>
                    </li>
                    <li>
                      <Check size={15} />
                      <div>
                        <strong>You have the final say</strong>
                        <span>
                          Agents can request access. Only your owner token can
                          approve it.
                        </span>
                      </div>
                    </li>
                  </ul>
                </section>
                <section className="content-card about-card">
                  <Logo />
                  <p>
                    Built for the moments your agents need a human.
                    <br />
                    Early access. The repository is private while we develop the
                    app.
                  </p>
                  <a
                    className="button button-light button-small"
                    href={repository}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Code2 size={15} />
                    Project & documentation <ExternalLink size={12} />
                  </a>
                </section>
              </div>
            </>
          )}
          <footer className="page-footer">
            <span>
              <ShieldCheck size={13} />A human touch for your agents.
            </span>
            <a
              href={`${repository}/blob/main/README.md`}
              target="_blank"
              rel="noreferrer"
            >
              Documentation <ExternalLink size={11} />
            </a>
          </footer>
        </div>
      </main>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {(
          [
            { key: "inbox", label: "Inbox", Icon: Inbox },
            { key: "activity", label: "Activity", Icon: Activity },
            { key: "devices", label: "Connect", Icon: MonitorSmartphone },
            { key: "settings", label: "Settings", Icon: Settings2 },
          ] as const
        ).map(({ key, label, Icon }) => (
          <button
            key={key}
            className={section === key ? "active" : ""}
            aria-current={section === key ? "page" : undefined}
            onClick={() => navigate(key)}
          >
            <span>
              <Icon size={20} />
              {key === "inbox" && current.length ? (
                <i>{current.length}</i>
              ) : null}
            </span>
            {label}
          </button>
        ))}
      </nav>
      {connectOpen ? (
        <ConnectDialog
          workspace={workspace}
          notificationForRemember={notifications.forRemember}
          onClose={() => setConnectOpen(false)}
        />
      ) : null}
      {toast && !(mobileLayout && selectedId && section === "inbox") ? (
        <Toast message={toast} onDismiss={() => setToast("")} />
      ) : null}
    </div>
  );
}

function ArrowUpRightIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 12 12 4M4 4h8v8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
