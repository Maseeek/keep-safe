import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Bell,
  BellRing,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  Code2,
  ExternalLink,
  Inbox,
  KeyRound,
  Laptop,
  Link2,
  LoaderCircle,
  LockKeyhole,
  MonitorSmartphone,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Smartphone,
  Unplug,
  X,
} from "lucide-react";
import type { LoginRequest } from "../../../packages/shared/src/protocol";
import { AgentMark, BrowserPanel, domain, timeLeft } from "./BrowserPanel";
import { useWorkspace, validateConnection, type Connection, type Workspace } from "./workspace";
import { notificationMessage, readNotificationEntry, verifyNotificationIntent, withoutNotificationEntry, type NotificationIntent } from "./notification-intent";
import { DeviceManager } from "./DeviceManager";
import { HistoryControls } from "./HistoryControls";
import { useNotifications } from "./useNotifications";
import { PairForm, PromptCard } from "./pairing-ui";
import { PairingDesk, readDeskLink } from "./PairingDesk";
import { useInstall, Welcome } from "./Welcome";

type Section = "inbox" | "activity" | "devices" | "settings";
type Filter = "all" | "pending" | "active";
const repository = "https://github.com/Maseeek/keep-safe";
const notificationGuidance = "This notification cannot identify a request on this computer. Connect to the computer that sent it, then choose a request from its queue.";
interface PendingNotification {
  intent: NotificationIntent;
  source: Connection | null;
  interaction: number;
  section: Section;
  selectedId: string | null;
  renderedId: string | null;
  explicit: boolean;
  verified: boolean;
}
interface NotificationNotice { message: string; action?: PendingNotification }
function NotificationNoticeView({ notice, open, dismiss }: { notice: NotificationNotice; open: () => void; dismiss: () => void }) {
  return <div className="pairing-expired-notice notification-notice" role="status" aria-label="Notification notice">
    <Bell size={18} aria-hidden="true" /><p>{notice.message}</p>
    {notice.action ? <button className="button button-light button-small" onClick={open}>Open request <ArrowRight size={13} aria-hidden="true" /></button> : null}
    <button className="icon-button" aria-label="Dismiss notification notice" onClick={dismiss}><X size={15} /></button>
  </div>;
}

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
      <AgentMark name={request.agent} />
      <span className="request-card-body">
        <span className="request-card-top">
          <strong>{request.agent}</strong>
          <span className="request-site">{domain(request.origin)}</span>
        </span>
        <span className="request-card-title">{request.title}</span>
        <span className="request-card-bottom">
          <StatusPill request={request} now={now} />
          <span className="request-time">
            <Clock3 size={12} aria-hidden="true" />
            {timeLeft(request.expiresAt, now)}
          </span>
        </span>
      </span>
      <ChevronRight size={18} className="card-chevron" aria-hidden="true" />
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
      <h2 id="connect-title">Connect with an owner token</h2>
      <p>
        For advanced setups. Most phones pair faster with the QR code from
        <code> keep-safe pair</code>.
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
            <strong>Keep this phone paired</strong>
            <small>
              A separate, revocable device key is saved on this phone. Your
              owner token is never saved across sessions. Pairing ends after
              30 days without use.
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

export function App() {
  const [notificationEntry] = useState(() => readNotificationEntry(window.location.href));
  const [section, setSection] = useState<Section>("inbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const interaction = useRef(0);
  const [pendingNotification, setPendingNotificationState] = useState<PendingNotification | null>(() => notificationEntry.present && notificationEntry.intent
    ? { intent: notificationEntry.intent, source: workspace.connection, interaction: 0, section: "inbox", selectedId: null, renderedId: null, explicit: false, verified: false } : null);
  const pendingNotificationRef = useRef(pendingNotification);
  const setPendingNotification = useCallback((next: PendingNotification | null) => {
    pendingNotificationRef.current = next;
    setPendingNotificationState(next);
  }, []);
  const [notificationNotice, setNotificationNotice] = useState<NotificationNotice | null>(() => notificationEntry.present && !notificationEntry.intent ? { message: notificationGuidance } : null);
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
    selectedId !== null ? workspace.requests.find((request) => request.id === selectedId)
      : notificationEntry.present ? undefined : filtered[0];
  const notificationRoute = useRef({ connection: workspace.connection, info: workspace.info, requests: workspace.requests, section, selectedId, selected, connectOpen });
  notificationRoute.current = { connection: workspace.connection, info: workspace.info, requests: workspace.requests, section, selectedId, selected, connectOpen };
  useLayoutEffect(() => {
    if (notificationEntry.present) window.history.replaceState(null, "", withoutNotificationEntry(window.location.href));
  }, [notificationEntry]);
  useEffect(() => {
    const changed = () => { interaction.current++; };
    document.addEventListener("pointerdown", changed, true);
    document.addEventListener("keydown", changed, true);
    return () => { document.removeEventListener("pointerdown", changed, true); document.removeEventListener("keydown", changed, true); };
  }, []);
  const receiveNotification = useCallback((entry: ReturnType<typeof notificationMessage>, explicit = false) => {
    if (!entry?.present) return;
    if (!entry.intent) { setPendingNotification(null); setNotificationNotice({ message: notificationGuidance }); return; }
    const current = notificationRoute.current;
    setNotificationNotice(null);
    setPendingNotification({ intent: entry.intent, source: current.connection, interaction: interaction.current, section: current.section,
      selectedId: current.selectedId, renderedId: current.selected?.id || null, explicit, verified: false });
  }, [setPendingNotification]);
  useEffect(() => {
    const pending = pendingNotification;
    if (!pending || pending.verified || pendingNotificationRef.current !== pending) return;
    if (!pending.source || pending.source !== workspace.connection) {
      setPendingNotification(null); setNotificationNotice({ message: notificationGuidance }); return;
    }
    let cancelled = false;
    void verifyNotificationIntent(pending.intent, pending.source, async () => {
      const [info, result] = await Promise.all([
        workspace.api<NonNullable<Workspace["info"]>>("/api/info"),
        workspace.api<LoginRequest[] | { requests: LoginRequest[] }>("/api/requests"),
      ]);
      return { info, requests: Array.isArray(result) ? result : result.requests };
    }, source => !cancelled && notificationRoute.current.connection === source && pendingNotificationRef.current === pending)
      .then(result => {
        if (cancelled || pendingNotificationRef.current !== pending) return;
        if (result.kind === "ready") setPendingNotification({ ...pending, verified: true });
        else {
          setPendingNotification(null);
          setNotificationNotice({ message: result.kind === "unavailable" ? "This notification’s request is no longer available. Choose a current request from the queue."
            : result.kind === "failed" ? "This notification could not be checked. Check your connection, then choose a request from the queue." : notificationGuidance });
        }
      });
    return () => { cancelled = true; };
  }, [pendingNotification, workspace.connection, workspace.api, setPendingNotification]);
  useEffect(() => {
    const pending = pendingNotification;
    if (!pending?.verified || pendingNotificationRef.current !== pending) return;
    const current = notificationRoute.current;
    if (current.connection !== pending.source || interaction.current !== pending.interaction || current.section !== pending.section || current.selectedId !== pending.selectedId || (current.selected?.id || null) !== pending.renderedId) {
      setPendingNotification(null); setNotificationNotice({ message: "Your view or connection changed. Choose the notification’s request from the correct computer’s queue." }); return;
    }
    if (workspace.status !== "connected" || !workspace.info) return;
    if (workspace.info.vapidPublicKey !== pending.intent.sourceKey) {
      setPendingNotification(null); setNotificationNotice({ message: notificationGuidance }); return;
    }
    const target = workspace.requests.find(request => request.id === pending.intent.requestId);
    setPendingNotification(null);
    if (!target || !["pending", "approved", "active"].includes(target.status) || !Number.isFinite(Date.parse(target.expiresAt)) || Date.parse(target.expiresAt) <= Date.now()) {
      setNotificationNotice({ message: "This notification’s request is no longer available. Choose a current request from the queue." }); return;
    }
    const activeView = current.section === "inbox" && current.selected && ["approved", "active"].includes(current.selected.status) && Date.parse(current.selected.expiresAt) > Date.now();
    if (!pending.explicit && (current.connectOpen || (activeView && current.selected?.id !== target.id))) {
      setNotificationNotice({ message: "Another request is waiting on this computer. Opening it leaves your current browser view and clears unsent text.", action: pending }); return;
    }
    if (current.section === "inbox" && current.selected?.id === target.id) return;
    setNotificationNotice(null); setSelectedId(target.id); setSection("inbox");
  }, [pendingNotification, workspace.connection, workspace.status, workspace.info, workspace.requests, now, setPendingNotification]);
  useEffect(() => {
    if (notificationNotice?.action && notificationNotice.action.source !== workspace.connection)
      setNotificationNotice({ message: notificationGuidance });
  }, [workspace.connection, notificationNotice]);
  const openNotificationRequest = () => {
    const action = notificationNotice?.action;
    if (!action) return;
    if (action.source !== notificationRoute.current.connection || notificationRoute.current.info?.vapidPublicKey !== action.intent.sourceKey) {
      setNotificationNotice({ message: notificationGuidance }); return;
    }
    receiveNotification({ present: true, intent: action.intent }, true);
  };

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
    const openRequest = (event: MessageEvent) => receiveNotification(notificationMessage(event.data));
    navigator.serviceWorker.addEventListener("message", openRequest);
    return () =>
      navigator.serviceWorker.removeEventListener("message", openRequest);
  }, [receiveNotification]);

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

  const [deskLink] = useState(readDeskLink);
  const [demo, setDemo] = useState(() => {
    try { return new URLSearchParams(window.location.search).has("demo") || sessionStorage.getItem("keep-safe.demo") === "1"; } catch { return false; }
  });
  const [pairOpen, setPairOpen] = useState(false);
  const [welcomeBack, setWelcomeBack] = useState(false);
  const install = useInstall();
  const enterDemo = () => { try { sessionStorage.setItem("keep-safe.demo", "1"); } catch { /* This tab only. */ } setDemo(true); };
  const leaveDemo = () => { try { sessionStorage.removeItem("keep-safe.demo"); } catch { /* Already gone. */ } setDemo(false); setSelectedId(null); setSection("inbox"); };
  const paired = () => { setPairOpen(false); setWelcomeBack(true); };
  const computerName = workspace.info?.computerName || "Your computer";
  const sectionTitle = section === "inbox" ? "Inbox" : section === "activity" ? "Activity" : section === "devices" ? "Connect" : "Settings";
  const statusLabel = isDemo ? "Demo mode" : workspace.status === "connected" ? "Bridge connected" : workspace.status === "connecting" ? "Connecting…" : "Bridge offline";

  if (deskLink) return <PairingDesk code={deskLink.code} link={deskLink.link} />;

  if (!workspace.connection && !demo) return (
    <div className="welcome-shell">
      {workspace.pairingNotice ? (
        <div className="pairing-expired-notice" role="status">
          <ShieldCheck size={18} aria-hidden="true" />
          <p>{workspace.pairingNotice}</p>
          <button className="icon-button" aria-label="Dismiss pairing notice" onClick={workspace.dismissPairingNotice}><X size={15} /></button>
        </div>
      ) : null}
      <Welcome workspace={workspace} onDemo={enterDemo} onOwnerToken={() => setConnectOpen(true)} onPaired={paired} />
      {connectOpen ? <ConnectDialog workspace={workspace} notificationForRemember={notifications.forRemember} onClose={() => setConnectOpen(false)} /> : null}
      {toast ? <Toast message={toast} onDismiss={() => setToast("")} /> : null}
    </div>
  );

  const liveSelected = mobileLayout && !!selectedId && section === "inbox";
  return (
    <div className={`app-shell${liveSelected ? " has-detail" : ""}`}>
      <aside className="sidebar">
        <Logo />
        <nav className="main-nav" aria-label="Main navigation">
          <button className={section === "inbox" ? "active" : ""} aria-current={section === "inbox" ? "page" : undefined} onClick={() => navigate("inbox")}>
            <Inbox size={18} aria-hidden="true" />
            Inbox
            {current.length ? <span className="nav-count">{current.length}</span> : null}
          </button>
          <button className={section === "activity" ? "active" : ""} aria-current={section === "activity" ? "page" : undefined} onClick={() => navigate("activity")}>
            <Activity size={18} aria-hidden="true" />
            Activity
          </button>
          <button className={section === "devices" ? "active" : ""} aria-current={section === "devices" ? "page" : undefined} onClick={() => navigate("devices")}>
            <MonitorSmartphone size={18} aria-hidden="true" />
            Connections{!isDemo ? <span className="nav-connected" /> : null}
          </button>
          <button className={section === "settings" ? "active" : ""} aria-current={section === "settings" ? "page" : undefined} onClick={() => navigate("settings")}>
            <Settings2 size={18} aria-hidden="true" />
            Settings
          </button>
        </nav>
        <div className="sidebar-bottom">
          <span className={`bridge-status ${workspace.status === "connected" ? "online" : ""}`}><span />{isDemo ? "Demo workspace" : computerName}</span>
          <a className="sidebar-link" href={repository} target="_blank" rel="noreferrer"><Code2 size={15} aria-hidden="true" /> Docs <ExternalLink size={12} aria-hidden="true" /></a>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="mobile-brand"><Logo compact /></div>
          <strong className="topbar-title">{sectionTitle}</strong>
          <div className="topbar-actions">
            <span className={`bridge-status ${workspace.status === "connected" ? "online" : ""}`}><span />{statusLabel}</span>
            <button className="icon-button notification-button" aria-label="Set up phone notifications" onClick={() => navigate("settings")}>
              {notifications.enabled ? <BellRing size={19} /> : <Bell size={19} />}
            </button>
          </div>
        </header>
        <div className="page-content">
          {notificationNotice && !liveSelected ? (
            <NotificationNoticeView notice={notificationNotice} open={openNotificationRequest} dismiss={() => setNotificationNotice(null)} />
          ) : null}
          {workspace.pairingNotice ? (
            <div className="pairing-expired-notice" role="status">
              <ShieldCheck size={18} aria-hidden="true" />
              <p>{workspace.pairingNotice}</p>
              <button className="text-link" onClick={() => setPairOpen(true)}>Pair again <ArrowRight size={13} aria-hidden="true" /></button>
              <button className="icon-button" aria-label="Dismiss pairing notice" onClick={workspace.dismissPairingNotice}><X size={15} /></button>
            </div>
          ) : null}
          {isDemo ? (
            <div className="demo-banner">
              <span className="demo-badge">DEMO</span>
              <p>Sample requests. <span>Nothing is real.</span></p>
              <button onClick={leaveDemo}>Set up <ArrowRight size={13} aria-hidden="true" /></button>
            </div>
          ) : workspace.status !== "connected" ? (
            <div className="connection-banner" role="status">
              <LoaderCircle size={16} className="spin" aria-hidden="true" />
              <div>
                <strong>{workspace.status === "error" ? "Connection needs attention" : "Looking for your computer…"}</strong>
                <p>{workspace.error || "Keep your computer awake and Keep Safe running there. This reconnects on its own. If the computer restarted, scan a new code from it."}</p>
              </div>
              <button className="text-link" onClick={() => setPairOpen(true)}>Scan new code <ArrowRight size={14} aria-hidden="true" /></button>
            </div>
          ) : null}
          {section === "inbox" ? (
            <div className={`inbox-layout ${selectedId ? "has-selection" : ""}`}>
              <section className="queue-section" aria-label="Request inbox">
                <div className="section-title">
                  <h1>Inbox {current.length ? <span>{current.length}</span> : null}</h1>
                  <button
                    className="icon-button"
                    onClick={() => {
                      if (isDemo) {
                        workspace.resetDemo();
                        setSelectedId(null);
                        notify("Demo workspace reset. Three agents are ready for your help.");
                      } else navigate("devices");
                    }}
                    aria-label={isDemo ? "Reset demo requests" : "View bridge connection"}
                  >
                    {isDemo ? <RotateCcw size={17} /> : <Link2 size={17} />}
                  </button>
                </div>
                {current.length > 1 || filter !== "all" || query ? (
                  <div className="queue-tools">
                    <div className="queue-filters" role="group" aria-label="Filter requests">
                      <button className={filter === "all" ? "selected" : ""} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All requests</button>
                      <button className={filter === "pending" ? "selected" : ""} aria-pressed={filter === "pending"} onClick={() => setFilter("pending")}>Needs you <span>{pending.length}</span></button>
                      <button className={filter === "active" ? "selected" : ""} aria-pressed={filter === "active"} onClick={() => setFilter("active")}>Active</button>
                    </div>
                    {current.length > 2 || query ? (
                      <label className="search-field">
                        <Search size={16} aria-hidden="true" />
                        <input type="search" placeholder="Find an agent or website" aria-label="Search requests" value={query} onChange={(event) => setQuery(event.target.value)} />
                      </label>
                    ) : null}
                  </div>
                ) : null}
                <div className="request-list">
                  {filtered.length ? (
                    filtered.map((request) => (
                      <RequestCard key={request.id} request={request} selected={(!mobileLayout || !!selectedId) && selected?.id === request.id} now={now} onClick={() => setSelectedId(request.id)} />
                    ))
                  ) : (
                    <EmptyState
                      title={query ? "No matching requests." : filter === "active" ? "No sessions open." : "You’re all caught up."}
                      text={query ? "Try another agent name or website." : filter === "active" ? "Approve a request to take the browser into your hands." : "When an agent needs a sign-in, its request appears here."}
                      action={isDemo ? (
                        <button className="button button-light button-small" onClick={() => { workspace.resetDemo(); setFilter("all"); setQuery(""); }}>Reset demo <RotateCcw size={13} aria-hidden="true" /></button>
                      ) : !notifications.enabled ? (
                        <button className="button button-light button-small" onClick={() => navigate("settings")}><Bell size={14} aria-hidden="true" /> Notify me</button>
                      ) : undefined}
                    />
                  )}
                </div>
              </section>
              <div
                className="detail-section"
                ref={detailSection}
                tabIndex={-1}
                role={mobileLayout && selectedId ? "dialog" : undefined}
                aria-modal={mobileLayout && selectedId ? true : undefined}
                aria-label={mobileLayout && selectedId ? "Browser request" : undefined}
              >
                {mobileLayout && selectedId && toast ? <Toast message={toast} onDismiss={() => setToast("")} inline /> : null}
                {mobileLayout && selectedId && notificationNotice ? (
                  <NotificationNoticeView notice={notificationNotice} open={openNotificationRequest} dismiss={() => setNotificationNotice(null)} />
                ) : null}
                {selected && (!mobileLayout || selectedId) ? (
                  <BrowserPanel request={selected} workspace={workspace} now={now} busy={busy} onAction={takeAction} onBack={() => setSelectedId(null)} />
                ) : (
                  <div className="no-selection">
                    <span className="empty-icon"><ShieldCheck size={28} strokeWidth={1.5} aria-hidden="true" /></span>
                    {selectedId !== null ? <>
                      <h2>Request unavailable</h2>
                      <p>Choose a current request from this computer’s queue.</p>
                      <button className="button button-light" onClick={() => setSelectedId(null)}>Back to inbox <ArrowRight size={15} aria-hidden="true" /></button>
                    </> : <>
                      <h2>Nothing needs you right now</h2>
                      <p>When an agent needs a sign-in, you’ll see its request here.</p>
                    </>}
                  </div>
                )}
              </div>
            </div>
          ) : section === "activity" ? (
            <div className="page-column">
              <div className="section-title">
                <h1>Activity {history.length ? <span>{history.length}</span> : null}</h1>
                <button className="button button-light button-small" onClick={exportHistory} disabled={!history.length}><ArrowDownToLine size={15} aria-hidden="true" /> Export</button>
              </div>
              <div className="content-card activity-card">
                {history.length ? (
                  <div className="activity-list">
                    {[...history].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((request) => (
                      <button className="activity-row" key={request.id} onClick={() => { setSelectedId(request.id); setSection("inbox"); }}>
                        <AgentMark name={request.agent} small />
                        <div>
                          <strong>{request.title}</strong>
                          <span>{request.agent} · {domain(request.origin)}</span>
                        </div>
                        <StatusPill request={request} now={now} />
                        <time>{new Date(request.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                        <ChevronRight size={15} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="Nothing here yet." text="Requests appear here after you hand back, decline, or let them expire." />
                )}
              </div>
              <HistoryControls workspace={workspace} now={now} notify={notify} />
              <p className="privacy-strip"><ShieldCheck size={16} aria-hidden="true" /> History records what happened to a request. Passwords, cookies and browser images are never part of it.</p>
            </div>
          ) : section === "devices" ? (
            <div className="page-column">
              <div className="section-title"><h1>Connect</h1></div>
              <section className="content-card device-card">
                <div className="device-card-head">
                  <span className="device-card-icon"><Laptop size={24} strokeWidth={1.5} aria-hidden="true" /></span>
                  <div>
                    <h2>{isDemo ? "No computer connected" : computerName}</h2>
                    <p>{isDemo ? "The demo runs entirely on this device." : workspace.connection?.url.replace(/^https?:\/\//, "")}</p>
                    <span className={`status-pill ${isDemo ? "expired" : workspace.status === "connected" ? "active" : "pending"}`}>
                      {isDemo ? "Not connected" : workspace.status === "connected" ? "Connected" : "Reconnecting"}
                    </span>
                  </div>
                </div>
                <div className="device-card-actions">
                  <button className="button button-dark" onClick={() => setPairOpen(true)}><KeyRound size={16} aria-hidden="true" /> {isDemo ? "Pair with a code" : "Pair again"}</button>
                  <button className="button button-light" onClick={() => setConnectOpen(true)}><Link2 size={16} aria-hidden="true" /> {isDemo ? "Connect your computer" : "Update pairing"}</button>
                  {!isDemo && !workspace.connection?.device ? (
                    <button
                      className="text-link disconnect-link"
                      onClick={() => {
                        workspace.disconnect();
                        setSelectedId(null);
                        notify("Disconnected. Pairing details were removed from this tab.");
                      }}
                    >
                      <Unplug size={14} aria-hidden="true" /> Disconnect this tab
                    </button>
                  ) : null}
                </div>
              </section>
              <DeviceManager workspace={workspace} notify={notify} notificationForRemember={notifications.forRemember} />
              <section className="content-card setup-card">
                <h2>Set up a computer</h2>
                <p>Paste this into a coding agent on the computer your agents use. It installs Keep Safe, starts it and shows a QR code to scan here.</p>
                <PromptCard compact />
                <a className="text-link" href={`${repository}/blob/main/docs/connection.md`} target="_blank" rel="noreferrer">Connection guide <ExternalLink size={13} aria-hidden="true" /></a>
              </section>
            </div>
          ) : (
            <div className="page-column">
              <div className="section-title"><h1>Settings</h1></div>
              <section className="content-card settings-card">
                <div className="settings-card-head">
                  <span className="settings-section-icon"><Bell size={20} aria-hidden="true" /></span>
                  <h2>A nudge when you’re needed.</h2>
                </div>
                <p>Get a phone notification when an agent sends a request. You decide when to open it.</p>
                <p className={notifications.error ? "notification-status error" : "notification-status"} role={notifications.error ? "alert" : "status"}>{notifications.message}</p>
                <div className="notification-actions" aria-busy={notifications.busy || notifications.checking}>
                  <button className="button button-dark" ref={notificationEnableButton} disabled={notifications.busy || notifications.checking || notifications.enabled} onClick={notifications.enable}>
                    {notifications.busy || notifications.checking ? <LoaderCircle size={16} className="spin" /> : notifications.enabled ? <Check size={16} /> : <Bell size={16} />}
                    {notifications.enabled ? "Notifications enabled" : "Enable notifications"}
                  </button>
                  {notifications.enabled && notifications.canDisable ? <button className="button button-light" disabled={notifications.busy} onClick={turnOffNotifications}>Turn off notifications</button> : null}
                  {notifications.canCheck ? <button className="button button-light" disabled={notifications.busy || notifications.checking} onClick={notifications.refresh}>Check notification status</button> : null}
                </div>
                <p className="settings-note">Enrollment confirms this computer is registered to send alerts. It does not confirm delivery. Turning alerts off keeps this phone paired and leaves browser permission unchanged.</p>
                {install.ios && !install.installed ? (
                  <p className="ios-note"><Smartphone size={16} aria-hidden="true" /><span><strong>On an iPhone?</strong> Open this app in Safari, tap Share → Add to Home Screen, then launch it from there to enable notifications.</span></p>
                ) : null}
              </section>
              {!install.installed && install.canPrompt ? (
                <section className="content-card settings-card">
                  <div className="settings-card-head"><span className="settings-section-icon"><Smartphone size={20} aria-hidden="true" /></span><h2>Install the app</h2></div>
                  <p>Opens full screen from your Home Screen, without browser bars.</p>
                  <div className="notification-actions"><button className="button button-light" onClick={() => { void install.install(); }}>Install Keep Safe</button></div>
                </section>
              ) : null}
              <section className="content-card settings-card privacy-card">
                <div className="settings-card-head"><span className="settings-section-icon"><ShieldCheck size={20} aria-hidden="true" /></span><h2>Private by design</h2></div>
                <ul className="privacy-list">
                  <li><Check size={15} aria-hidden="true" /><div><strong>No saved passwords</strong><span>Text goes to the live website. Keep Safe never saves it.</span></div></li>
                  <li><Check size={15} aria-hidden="true" /><div><strong>Cookies stay on your computer</strong><span>The browser runs there, never in this app.</span></div></li>
                  <li><Check size={15} aria-hidden="true" /><div><strong>Temporary control</strong><span>Requests expire. Handing back ends your control of the browser.</span></div></li>
                  <li><Check size={15} aria-hidden="true" /><div><strong>You have the final say</strong><span>Agents can ask. Only a paired phone can approve.</span></div></li>
                </ul>
              </section>
              <p className="about-line">Keep Safe {workspace.info?.version ? `bridge ${workspace.info.version}` : "early access"} · <a href={repository} target="_blank" rel="noreferrer">Project and documentation</a></p>
            </div>
          )}
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
          <button key={key} className={section === key ? "active" : ""} aria-current={section === key ? "page" : undefined} onClick={() => navigate(key)}>
            <span>
              <Icon size={22} aria-hidden="true" />
              {key === "inbox" && current.length ? <i>{current.length}</i> : null}
            </span>
            {label}
          </button>
        ))}
      </nav>
      {connectOpen ? <ConnectDialog workspace={workspace} notificationForRemember={notifications.forRemember} onClose={() => setConnectOpen(false)} /> : null}
      {pairOpen ? (
        <Sheet title="Pair with your computer" onClose={() => setPairOpen(false)}>
          <p>On your computer, run <code>keep-safe pair</code>, then scan the QR code it shows.</p>
          <PairForm workspace={workspace} onPaired={paired} />
        </Sheet>
      ) : null}
      {welcomeBack && workspace.connection ? (
        <Sheet title={`Paired with ${computerName}`} onClose={() => setWelcomeBack(false)}>
          <p>Requests from your agents will appear in your inbox. This phone stays paired while you keep using it.</p>
          <ul className="paired-next">
            <li className={notifications.enabled ? "done" : ""}>
              <span><Bell size={18} aria-hidden="true" /></span>
              <div><strong>Notifications</strong><small>{notifications.enabled ? "On for this computer." : "Get a ping when an agent needs you."}</small></div>
              {notifications.enabled ? <Check size={18} aria-hidden="true" /> : <button className="button button-dark button-small" disabled={notifications.busy || notifications.checking} onClick={notifications.enable}>Turn on</button>}
            </li>
            {!install.installed && (install.canPrompt || install.ios) ? (
              <li>
                <span><Smartphone size={18} aria-hidden="true" /></span>
                <div><strong>Home Screen</strong><small>{install.ios ? "In Safari: Share, then Add to Home Screen. Pair again inside the app." : "Open Keep Safe like an app."}</small></div>
                {install.canPrompt ? <button className="button button-light button-small" onClick={() => { void install.install(); }}>Install</button> : null}
              </li>
            ) : null}
          </ul>
          <button className="button button-dark button-large" onClick={() => setWelcomeBack(false)}>Done</button>
        </Sheet>
      ) : null}
      {toast && !liveSelected ? <Toast message={toast} onDismiss={() => setToast("")} /> : null}
    </div>
  );
}

/** A modal that rises from the bottom on phones and centers on larger screens. */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return (
    <dialog ref={dialog} className="sheet" aria-labelledby="sheet-title" onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="sheet-body">
        <div className="sheet-head">
          <h2 id="sheet-title">{title}</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}><X size={20} /></button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
