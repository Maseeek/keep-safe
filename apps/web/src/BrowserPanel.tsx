import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Clock3,
  ExternalLink,
  Eye,
  Keyboard,
  LoaderCircle,
  LockKeyhole,
  MousePointer2,
  Pause,
  RotateCw,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import type { LoginRequest } from "../../../packages/shared/src/protocol";
import type { Workspace } from "./workspace";
import { browserAddress } from "./browser-address";
import { ControlNavigator } from "./ControlNavigator";
import { RemoteSurface } from "./RemoteSurface";

export function AgentMark({
  name,
  small = false,
}: {
  name: string;
  small?: boolean;
}) {
  const claude = /claude/i.test(name);
  const codex = /codex/i.test(name);
  return (
    <span
      className={`agent-mark ${claude ? "claude" : codex ? "codex" : "gravity"} ${small ? "small" : ""}`}
      aria-hidden="true"
    >
      {claude ? "\u2733" : codex ? "\u2318" : "A"}
    </span>
  );
}

export function domain(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.protocol.replace(/:$/, "") || url;
  } catch {
    return url;
  }
}

export function timeLeft(expiresAt: string, now: number) {
  const seconds = Math.max(
    0,
    Math.ceil((new Date(expiresAt).getTime() - now) / 1000),
  );
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

interface Props {
  request: LoginRequest;
  workspace: Workspace;
  now: number;
  busy: boolean;
  onAction: (id: string, action: "approve" | "deny" | "complete") => void;
  onBack: () => void;
}

const additionalKeys = [
  { key: "Space", label: "Space" },
  { key: "Escape", label: "Esc" },
  { key: "Shift+Tab", label: "Shift+Tab" },
  { key: "ArrowUp", label: "↑ Up" },
  { key: "ArrowDown", label: "↓ Down" },
  { key: "ArrowLeft", label: "← Left" },
  { key: "ArrowRight", label: "→ Right" },
  { key: "Home", label: "Home" },
  { key: "End", label: "End" },
  { key: "PageUp", label: "Page Up" },
  { key: "PageDown", label: "Page Down" },
  { key: "Delete", label: "Delete" },
  { key: "ControlOrMeta+A", label: "Select all" },
] as const;

export function BrowserPanel({
  request,
  workspace,
  now,
  busy,
  onAction,
  onBack,
}: Props) {
  const [text, setText] = useState("");
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [showMoreKeys, setShowMoreKeys] = useState(false);
  const [demoStep, setDemoStep] = useState(0);
  const [denyOpen, setDenyOpen] = useState(false);
  const [showText, setShowText] = useState(false);
  const [showOrigin, setShowOrigin] = useState(false);
  const denyTrigger = useRef<HTMLButtonElement>(null);
  const denyDialog = useRef<HTMLDialogElement>(null);
  const resumeTrigger = useRef<HTMLButtonElement>(null);
  const draftInput = useRef<HTMLInputElement>(null);
  const isDemo = !workspace.connection;
  const finished = ["completed", "denied", "expired"].includes(request.status);
  const expired = !finished && new Date(request.expiresAt).getTime() <= now;
  const active =
    !expired && (request.status === "approved" || request.status === "active");
  const liveFrame =
    workspace.frame?.requestId === request.id ? workspace.frame : null;
  const canInput =
    active && workspace.status === "connected" && !!liveFrame && !expired && !workspace.focusBusy &&
    !workspace.browserPaused && workspace.browserVisible && !workspace.navigationBusy;
  const canNavigate = active && !expired && !!liveFrame && workspace.status === "connected" &&
    !workspace.browserPaused && workspace.browserVisible && !workspace.navigationBusy;
  const keyInputBlocked = !canInput || workspace.focusBusy || workspace.focusBlocked;
  const moreKeysId = `remote-more-keys-${request.id}`;
  const address = browserAddress(liveFrame?.url ?? request.url);
  const requestedAddress = browserAddress(request.url);

  useEffect(() => {
    workspace.watch(active && !isDemo && !expired ? request.id : null);
    return () => workspace.watch(null);
  }, [active, isDemo, request.id, workspace.watch, expired]);

  useEffect(() => {
    setText("");
    setDemoStep(0);
    setShowKeyboard(false);
    setShowMoreKeys(false);
    setDenyOpen(false);
    setShowOrigin(false);
    setShowText(false);
  }, [request.id]);
  const clearLocalInput = useCallback(() => {
    if (draftInput.current) {
      draftInput.current.value = "";
      draftInput.current.type = "password";
    }
    setText("");
    setShowText(false);
  }, []);
  useLayoutEffect(clearLocalInput, [clearLocalInput, request.id, workspace.connection, liveFrame?.url, workspace.navigationBusy]);
  useEffect(() => {
    const clearDraft = () => {
      clearLocalInput();
      setShowKeyboard(false);
      setShowMoreKeys(false);
    };
    const visibility = () => { if (document.visibilityState === "hidden") clearDraft(); };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", clearDraft);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", clearDraft);
    };
  }, [clearLocalInput]);
  useEffect(() => {
    if (!active || isDemo || !workspace.browserPaused || !workspace.browserVisible) return;
    const timer = requestAnimationFrame(() => {
      if (document.activeElement === document.body) resumeTrigger.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(timer);
  }, [active, isDemo, workspace.browserPaused, workspace.browserVisible]);
  useEffect(() => {
    if (!active || expired || workspace.status !== "connected") setText("");
    if (!active || expired) setShowMoreKeys(false);
  }, [active, expired, workspace.status]);
  useEffect(() => { if (workspace.focusBlocked) setText(""); }, [workspace.focusBlocked]);
  useEffect(() => {
    if (!denyOpen) return;
    const dialog = denyDialog.current;
    const trigger = denyTrigger.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [denyOpen]);

  const sendText = (event: React.FormEvent) => {
    event.preventDefault();
    if (!text || !canInput || workspace.focusBlocked || workspace.focusBusy) return;
    const value = text;
    setText("");
    workspace.send({ type: "text", text: value });
  };
  const navigate = (direction: "back" | "forward" | "reload") => {
    clearLocalInput();
    workspace.navigateBrowser(direction);
  };

  return (
    <section
      className="browser-panel"
      aria-label={`Request from ${request.agent}`}
    >
      <div className="panel-topline">
        <button
          className="icon-button back-button"
          aria-label="Back to requests"
          onClick={onBack}
        >
          <ArrowLeft size={20} />
        </button>
        <span>REQUEST DETAILS</span>
        <span className={`micro-status ${active && !workspace.browserPaused ? "green" : ""}`}>
          <span />
          {active && !isDemo && workspace.browserPaused
            ? "View paused"
            : active && workspace.navigationBusy
              ? "Loading website"
            : active
            ? "You\u2019re in control"
            : finished || expired
              ? "Session closed"
              : "Awaiting you"}
        </span>
      </div>
      <div className="detail-heading">
        <AgentMark name={request.agent} />
        <div>
          <h2>{request.title}</h2>
          <p>
            {request.agent} <span>needs a human touch</span>
          </p>
        </div>
      </div>
      <div className="reason-box">
        <span className="quote-mark" aria-hidden="true">&ldquo;</span>
        <p>
          {request.reason ||
            "Please sign in to this website so I can continue my task."}
        </p>
      </div>
      <div className="session-meta">
        <span>
          <LockKeyhole size={13} />
          {domain(request.origin)}
        </span>
        <span>
          <Clock3 size={13} />
          {finished
            ? "Closed"
            : expired
              ? "Expired"
              : `${timeLeft(request.expiresAt, now)} remaining`}
        </span>
      </div>
      <div className={`browser-window ${active ? "is-active" : ""}`}>
        <div className="browser-chrome">
          <span className="window-dots">
            <i />
            <i />
            <i />
          </span>
          <button
            className="address"
            title={address.label}
            aria-label={`Website origin: ${address.label}`}
            aria-expanded={showOrigin}
            aria-controls={showOrigin ? "full-browser-origin" : undefined}
            onClick={() => setShowOrigin(!showOrigin)}
          >
            {address.secure ? (
              <LockKeyhole size={11} aria-label="HTTPS connection" />
            ) : (
              <TriangleAlert size={11} aria-label="Page is not using HTTPS" />
            )}
            <span>{address.label}</span>
          </button>
          <span className="frame-mode">
            {isDemo ? "DEMO" : active && workspace.browserPaused ? "PAUSED" : active && workspace.navigationBusy ? "LOADING" : active ? "LIVE" : "PRIVATE"}
          </span>
        </div>
        {showOrigin ? (
          <div className="full-browser-origin" id="full-browser-origin">
            <strong>{address.label}</strong>
            <span>{address.secure ? "HTTPS website" : "This page is not using HTTPS."}</span>
          </div>
        ) : null}
        {active && !expired && !isDemo && !workspace.browserPaused && workspace.info?.navigationAvailable && workspace.navigationAvailable ? (
          <div className="website-navigation" role="group" aria-label="Website navigation">
            <span>Website navigation</span>
            <div>
              <button aria-label="Back in the website" disabled={!canNavigate} onClick={() => navigate("back")}><ArrowLeft size={16} aria-hidden="true" /> Back</button>
              <button aria-label="Forward in the website" disabled={!canNavigate} onClick={() => navigate("forward")}><ArrowRight size={16} aria-hidden="true" /> Forward</button>
              <button aria-label="Reload website" disabled={!canNavigate} onClick={() => navigate("reload")}><RotateCw size={15} aria-hidden="true" /> Reload</button>
            </div>
          </div>
        ) : null}
        {finished || expired ? (
          <div
            className={`browser-state finished ${request.status === "denied" ? "was-denied" : ""}`}
          >
            <div className="state-emblem">
              {request.status === "completed" ? (
                <CheckCheck size={28} />
              ) : request.status === "denied" ? (
                <X size={28} />
              ) : (
                <Clock3 size={28} />
              )}
            </div>
            <h3>
              {request.status === "completed"
                ? "Back in good hands."
                : request.status === "denied"
                  ? "Request declined."
                  : "This request has expired."}
            </h3>
            <p>
              {request.status === "completed"
                ? `${request.agent} can get back to work. Your control of this browser has ended.`
                : request.status === "denied"
                  ? "The agent was notified. No browser access was granted."
                  : "Ask your agent to send a fresh request when you\u2019re ready."}
            </p>
          </div>
        ) : !active ? (
          <div className="browser-state">
            <div className="permission-illustration">
              <div className="illustration-cursor">
                <MousePointer2 size={17} />
              </div>
              <div className="illustration-site">
                <span />
                <span />
                <div>
                  <LockKeyhole size={22} />
                </div>
                <span />
                <span />
              </div>
              <div className="illustration-shield">
                <ShieldCheck size={22} />
              </div>
            </div>
            <h3>A little help. Then off they go.</h3>
            <p>
              Approve this request to open the browser and sign in yourself.
            </p>
            <span className="privacy-caption">
              <Eye size={13} />
              You'll see the actual website
            </span>
          </div>
        ) : isDemo ? (
          <div className="browser-state demo-browser">
            <span className="demo-surface-label">
              INTERACTIVE DEMO · NO REAL WEBSITE
            </span>
            <div className="demo-step-icon">
              {demoStep ? <Check size={30} /> : <MousePointer2 size={30} />}
            </div>
            <h3>
              {demoStep ? "That\u2019s the handoff." : "Your phone. Their browser."}
            </h3>
            <p>
              {demoStep
                ? "In a live session, you would now be signed in. Hand control back to let your agent continue."
                : "In a live session, the website appears here. You can tap, scroll, and type directly into its browser."}
            </p>
            {!demoStep ? (
              <button
                className="button button-light"
                onClick={() => setDemoStep(1)}
              >
                Simulate signing in <ArrowRight size={15} />
              </button>
            ) : (
              <span className="demo-success">
                <Check size={14} />
                Demo sign-in complete
              </span>
            )}
            <small>Never enter real credentials in the demo.</small>
          </div>
        ) : workspace.browserPaused ? (
          <div className="browser-state browser-paused">
            <div className="state-emblem"><Pause size={27} aria-hidden="true" /></div>
            <h3>Browser paused</h3>
            <p>Viewing and input are paused. The website may keep running on your computer.</p>
            <p>Your request stays open, and your agent waits for handback. Resume, then choose a field again before typing.</p>
            <button ref={resumeTrigger} className="button button-dark" disabled={!workspace.browserVisible || busy}
              onClick={() => workspace.resumeBrowser(request.id)}>
              <Eye size={16} aria-hidden="true" /> Resume browser
            </button>
          </div>
        ) : workspace.navigationBusy ? (
          <div className="browser-state" role="status">
            <LoaderCircle className="spin" size={28} aria-hidden="true" />
            <h3>Loading website…</h3>
            <p>Waiting for the browser to confirm navigation and show a fresh image. Then choose a field again before typing.</p>
          </div>
        ) : liveFrame ? (
          <div className="remote-screen">
            <RemoteSurface frame={liveFrame} enabled={canInput} controlIdentity={workspace.connection}
              alt={`Live browser on ${domain(liveFrame.url)}. Tap to click, or swipe inside the image to scroll the website.`}
              send={workspace.send} />
            {workspace.status !== "connected" ? (
              <div className="reconnect-cover">
                <LoaderCircle className="spin" size={24} />
                <span>Reconnecting to your browser…</span>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="browser-state">
            <LoaderCircle className="spin" size={30} />
            <h3>
              {workspace.info?.browserAvailable === false
                ? "Browser needs a moment."
                : "Opening your browser\u2026"}
            </h3>
            <p>
              {workspace.info?.browserAvailable === false
                ? "Check that Chromium is installed and the bridge can reach your agent\u2019s browser."
                : "Connecting securely to your computer. Your live session will appear here."}
            </p>
          </div>
        )}
      </div>
      {active && !isDemo && workspace.navigationError ? <p className="website-navigation-error" role="alert">{workspace.navigationError}</p> : null}
      {active && !isDemo && workspace.navigationUncertain ? <p className="website-navigation-hint" role="status">Resume and check the website before handing back.</p> : null}
      {active && !isDemo && !expired && !workspace.browserPaused ? (
        <div className="remote-controls">
          {!workspace.navigationBusy && liveFrame && (!workspace.info?.navigationAvailable || !workspace.navigationAvailable) ? (
            <p className="website-navigation-hint">{workspace.info?.navigationAvailable
              ? "Use the website’s own links and buttons in this browser."
              : "Update the bridge on your computer for website Back, Forward and Reload."}</p>
          ) : null}
          {workspace.info?.pageControlsAvailable ? <ControlNavigator key={request.id} workspace={workspace} requestId={request.id} enabled={canInput && !workspace.focusBusy} onFocusRequested={() => setText("")} /> : null}
          <div className="remote-toolbar">
            <div className="remote-toolbar-actions">
              <button
                className={`button button-light button-small ${showKeyboard ? "selected" : ""}`}
                onClick={() => setShowKeyboard(!showKeyboard)}
                aria-expanded={showKeyboard}
                aria-controls={showKeyboard ? "remote-text-form" : undefined}
              >
                <Keyboard size={16} />
                Type text
              </button>
              <button
                className={`button button-light button-small ${showMoreKeys ? "selected" : ""}`}
                aria-expanded={showMoreKeys}
                aria-controls={showMoreKeys ? moreKeysId : undefined}
                onClick={() => setShowMoreKeys(!showMoreKeys)}
              >
                More keys <ChevronDown size={15} aria-hidden="true" className={showMoreKeys ? "more-keys-chevron expanded" : "more-keys-chevron"} />
              </button>
            </div>
            <div className="keyboard-keys" role="group" aria-label="Common browser controls">
              <button
                title="Press Tab in browser"
                aria-label="Press Tab in browser"
                onClick={() => workspace.send({ type: "key", key: "Tab" })}
                disabled={!canInput}
              >
                Tab
              </button>
              <button
                title="Press Enter in browser"
                aria-label="Press Enter in browser"
                onClick={() => workspace.send({ type: "key", key: "Enter" })}
                disabled={keyInputBlocked}
              >
                &#x21b5;
              </button>
              <button
                title="Press Backspace in browser"
                aria-label="Press Backspace in browser"
                onClick={() =>
                  workspace.send({ type: "key", key: "Backspace" })
                }
                disabled={keyInputBlocked}
              >
                &#x232b;
              </button>
              <button
                title="Scroll browser up"
                aria-label="Scroll browser up"
                onClick={() =>
                  workspace.send({ type: "scroll", deltaX: 0, deltaY: -400 })
                }
                disabled={!canInput}
              >
                <ArrowUp size={15} />
              </button>
              <button
                title="Scroll browser down"
                aria-label="Scroll browser down"
                onClick={() =>
                  workspace.send({ type: "scroll", deltaX: 0, deltaY: 400 })
                }
                disabled={!canInput}
              >
                <ArrowDown size={15} />
              </button>
            </div>
          </div>
          {showMoreKeys ? (
            <div className="more-browser-keys" id={moreKeysId} role="group" aria-label="More browser keys">
              <p>Send a key to the browser’s selected control. The scroll buttons above move the page.</p>
              <div className="more-key-grid">
                {additionalKeys.map(({ key, label }) => {
                  const name = key === "ControlOrMeta+A" ? "Select all in browser" : `Press ${key} in browser`;
                  return <button key={key} title={name} aria-label={name}
                    disabled={!canInput || (key !== "Shift+Tab" && keyInputBlocked)}
                    onClick={() => workspace.send({ type: "key", key })}>{label}</button>;
                })}
              </div>
            </div>
          ) : null}
          {showKeyboard ? (
            <form className="remote-text-form" id="remote-text-form" onSubmit={sendText}>
              <label htmlFor="remote-input">
                Tap a field in the browser, then send text
              </label>
              <div className="input-with-button">
                <input
                  ref={draftInput}
                  id="remote-input"
                  type={showText ? "text" : "password"}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="Text to send to the selected field"
                  disabled={!canInput || workspace.focusBlocked}
                />
                <button
                  className="button button-dark button-small"
                  type="submit"
                  disabled={!canInput || !text || workspace.focusBlocked}
                >
                  Send <ArrowUp size={14} />
                </button>
              </div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={showText}
                  onChange={(event) => setShowText(event.target.checked)}
                />
                Show text
              </label>
              <small>
                Sent directly to the browser and cleared here. Never saved by
                Keep Safe.
              </small>
            </form>
          ) : null}
          <p className="input-hint">
            <MousePointer2 size={12} />
            Tap to click. Swipe inside the image to scroll the website, or outside
            it to move this app. Scroll buttons and More keys are also available.
          </p>
        </div>
      ) : null}
      {!finished && !expired ? (
        <div className="session-actions">
          <button
            ref={denyTrigger}
            className="button button-light"
            onClick={() => setDenyOpen(true)}
            disabled={busy}
          >
            {active ? "End session" : "Decline"}
          </button>
          <button
            className="button button-dark"
            onClick={() =>
              onAction(request.id, active ? "complete" : "approve")
            }
            disabled={
              busy ||
              (active && workspace.navigationBusy) ||
              (active && workspace.navigationUncertain) ||
              (!isDemo && workspace.status !== "connected") ||
              (active && !isDemo && !liveFrame && !workspace.browserPaused)
            }
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : active ? (
              <CheckCheck size={17} />
            ) : (
              <LockKeyhole size={16} />
            )}
            {active ? "Done, hand back" : "Approve & open"}
            {!busy ? <ArrowRight size={16} /> : null}
          </button>
        </div>
      ) : (
        <button className="button button-light closed-back" onClick={onBack}>
          Back to inbox <ArrowRight size={15} />
        </button>
      )}
      <p className="session-safety">
        <ShieldCheck size={13} />
        Passwords stay with the website. Cookies stay on your computer.
      </p>
      {active &&
      liveFrame &&
      !isDemo &&
      address.label !== requestedAddress.label ? (
        <div className="redirect-note">
          <ExternalLink size={14} />
          <span>
            This page moved to <strong>{address.label}</strong>. Check
            the address before entering credentials.
          </span>
        </div>
      ) : null}
      {denyOpen ? (
        <dialog
          ref={denyDialog}
          className="inline-confirm"
          role="alertdialog"
          aria-modal="true"
          aria-label="Decline this request"
          onCancel={(event) => {
            event.preventDefault();
            setDenyOpen(false);
          }}
        >
          <h3>
            {active ? "End this browser session?" : "Decline this request?"}
          </h3>
          <p>
            {active
              ? "Your agent will be told the request was denied. Only hand back if you want the agent to continue."
              : "Your agent will be told you declined. You can ask it to send another request later."}
          </p>
          <div>
            <button
              autoFocus
              className="button button-light"
              onClick={() => setDenyOpen(false)}
            >
              Cancel
            </button>
            <button
              className="button button-danger"
              disabled={busy}
              onClick={() => {
                setDenyOpen(false);
                onAction(request.id, "deny");
              }}
            >
              Yes, {active ? "end session" : "decline"}
            </button>
          </div>
        </dialog>
      ) : null}
      <div className="flow-steps">
        <span className={active || finished ? "done" : "current"}>
          <i>{active || finished ? <Check size={10} /> : "1"}</i>Approve
        </span>
        <ChevronRight size={12} />
        <span
          className={
            active ? "current" : request.status === "completed" ? "done" : ""
          }
        >
          <i>{request.status === "completed" ? <Check size={10} /> : "2"}</i>
          Sign in
        </span>
        <ChevronRight size={12} />
        <span className={request.status === "completed" ? "done" : ""}>
          <i>{request.status === "completed" ? <Check size={10} /> : "3"}</i>
          Hand back
        </span>
      </div>
    </section>
  );
}
