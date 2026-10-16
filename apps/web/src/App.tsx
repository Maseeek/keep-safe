import { useCallback, useEffect, useRef, useState } from "react";
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

function ConnectDialog({
  workspace,
  onClose,
}: {
  workspace: Workspace;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(workspace.connection?.url || "");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      workspace.connect(validateConnection(url, token));
      setToken("");
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Check your connection details.",
      );
    }
  };
  return (
    <dialog
      ref={dialog}
      className="connect-dialog"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      aria-labelledby="connect-title"
    >
      <button
        className="icon-button dialog-close"
        onClick={onClose}
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
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="pairing-note">
          <LockKeyhole size={15} />
          <span>
            The token is held for this browser tab. Use HTTPS when connecting
            from your phone.
          </span>
        </div>
        <button className="button button-dark" type="submit">
          Connect securely <ArrowRight size={17} />
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
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const notify = useCallback((message: string) => setToast(message), []);
  const workspace = useWorkspace(notify);
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
  useEffect(() => {
    setNotificationsEnabled(false);
    if (!workspace.connection || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setNotificationsEnabled(!!subscription))
      .catch(() => {});
  }, [workspace.connection]);

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
  const enableNotifications = async () => {
    if (isDemo) {
      setSection("settings");
      notify("Connect your computer to enable real phone notifications.");
      return;
    }
    if (
      !("Notification" in window) ||
      !("PushManager" in window) ||
      !("serviceWorker" in navigator)
    ) {
      notify(
        "This browser does not support push. On iPhone, add Keep Safe to your Home Screen and open it there.",
      );
      return;
    }
    if (!workspace.info?.pushEnabled || !workspace.info.vapidPublicKey) {
      notify(
        "Enable Web Push in your bridge first. The setup guide explains the free VAPID configuration.",
      );
      return;
    }
    setNotificationBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted")
        throw new Error(
          "Notifications were not enabled. You can change permission in your browser’s site settings.",
        );
      const registration = await navigator.serviceWorker.ready;
      const key = workspace.info.vapidPublicKey
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      const bytes = Uint8Array.from(atob(key), (char) => char.charCodeAt(0));
      const subscription =
        (await registration.pushManager.getSubscription()) ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: bytes,
        }));
      await workspace.api("/api/push/subscribe", {
        method: "POST",
        body: JSON.stringify(subscription),
      });
      setNotificationsEnabled(true);
      notify(
        "You’re on the list. We’ll notify you when your agent needs a hand.",
      );
    } catch (reason) {
      notify(
        reason instanceof Error
          ? reason.message
          : "Could not enable notifications.",
      );
    } finally {
      setNotificationBusy(false);
    }
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
            onClick={() => navigate("activity")}
          >
            <Activity size={18} />
            Activity
          </button>
          <button
            className={section === "devices" ? "active" : ""}
            onClick={() => navigate("devices")}
          >
            <MonitorSmartphone size={18} />
            Connections{!isDemo ? <span className="nav-connected" /> : null}
          </button>
          <button
            className={section === "settings" ? "active" : ""}
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
              onClick={enableNotifications}
            >
              {notificationsEnabled ? (
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
                      onClick={() => setFilter("all")}
                    >
                      All requests
                    </button>
                    <button
                      className={filter === "pending" ? "selected" : ""}
                      onClick={() => setFilter("pending")}
                    >
                      Needs you <span>{pending.length}</span>
                    </button>
                    <button
                      className={filter === "active" ? "selected" : ""}
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
                <div className="detail-section">
                  {selected ? (
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
                        onClick={enableNotifications}
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
                  {!isDemo ? (
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
                      Disconnect this phone
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
                  <button
                    className="button button-dark"
                    disabled={notificationBusy || notificationsEnabled}
                    onClick={enableNotifications}
                  >
                    {notificationBusy ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : notificationsEnabled ? (
                      <Check size={16} />
                    ) : (
                      <Bell size={16} />
                    )}
                    {notificationsEnabled
                      ? "Notifications enabled"
                      : "Enable notifications"}
                  </button>
                  {isDemo ? (
                    <div className="settings-note">
                      <Link2 size={14} />
                      Pair your computer first to enable real notifications.
                    </div>
                  ) : !workspace.info?.pushEnabled ? (
                    <div className="settings-note">
                      <Terminal size={14} />
                      Your bridge needs free VAPID keys to send Web Push.
                    </div>
                  ) : null}
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
                    Early access. Private repository, with open source planned.
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
          onClose={() => setConnectOpen(false)}
        />
      ) : null}
      {toast ? (
        <div className="toast" role="status">
          <span>
            <Check size={15} />
          </span>
          <p>{toast}</p>
          <button
            onClick={() => setToast("")}
            aria-label="Dismiss notification"
          >
            <X size={16} />
          </button>
        </div>
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
