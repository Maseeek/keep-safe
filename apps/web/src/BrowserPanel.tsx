import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  ExternalLink,
  Eye,
  Keyboard,
  LoaderCircle,
  LockKeyhole,
  MousePointer2,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import type { LoginRequest } from "../../../packages/shared/src/protocol";
import type { Workspace } from "./workspace";
import { browserAddress } from "./browser-address";

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
  const [demoStep, setDemoStep] = useState(0);
  const [denyOpen, setDenyOpen] = useState(false);
  const [showText, setShowText] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const wheelBuffer = useRef({ deltaX: 0, deltaY: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined });
  const isDemo = !workspace.connection;
  const finished = ["completed", "denied", "expired"].includes(request.status);
  const expired = !finished && new Date(request.expiresAt).getTime() <= now;
  const active =
    !expired && (request.status === "approved" || request.status === "active");
  const liveFrame =
    workspace.frame?.requestId === request.id ? workspace.frame : null;
  const canInput =
    active && workspace.status === "connected" && !!liveFrame && !expired;
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
    setDenyOpen(false);
  }, [request.id]);
  useEffect(() => {
    if (!active || expired || workspace.status !== "connected") setText("");
  }, [active, expired, workspace.status]);
  useEffect(() => {
    // A pending wheel event belongs to this request and this control interval.
    // Never replay it after a disconnect, handback, or request switch.
    return () => {
      const buffer = wheelBuffer.current;
      if (buffer.timer) clearTimeout(buffer.timer);
      buffer.timer = undefined;
      buffer.deltaX = 0;
      buffer.deltaY = 0;
    };
  }, [request.id, canInput]);

  const sendText = (event: React.FormEvent) => {
    event.preventDefault();
    if (!text || !canInput) return;
    const value = text;
    setText("");
    workspace.send({ type: "text", text: value });
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
        <span className={`micro-status ${active ? "green" : ""}`}>
          <span />
          {active
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
          <div className="address" title={address.label}>
            {address.secure ? (
              <LockKeyhole size={11} aria-label="HTTPS connection" />
            ) : (
              <TriangleAlert size={11} aria-label="Page is not using HTTPS" />
            )}
            <span>{address.label}</span>
          </div>
          <span className="frame-mode">
            {isDemo ? "DEMO" : active ? "LIVE" : "PRIVATE"}
          </span>
        </div>
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
        ) : liveFrame ? (
          <div className="remote-screen">
            <img
              ref={imageRef}
              src={`data:image/jpeg;base64,${liveFrame.data}`}
              width={liveFrame.width}
              height={liveFrame.height}
              alt={`Live browser on ${domain(liveFrame.url)}. Tap the page to interact.`}
              draggable={false}
              onClick={(event) => {
                if (!canInput || !imageRef.current) return;
                const bounds = imageRef.current.getBoundingClientRect();
                if (!bounds.width || !bounds.height) return;
                const clamp = (value: number, max: number) =>
                  Math.max(0, Math.min(max, Math.round(value)));
                workspace.send({
                  type: "click",
                  x: clamp(
                    ((event.clientX - bounds.left) / bounds.width) *
                      liveFrame.width,
                    liveFrame.width,
                  ),
                  y: clamp(
                    ((event.clientY - bounds.top) / bounds.height) *
                      liveFrame.height,
                    liveFrame.height,
                  ),
                });
              }}
              onWheel={(event) => {
                if (!canInput) return;
                const clampScroll = (value: number) =>
                  Math.max(-3000, Math.min(3000, Math.round(value)));
                wheelBuffer.current.deltaX = clampScroll(
                  wheelBuffer.current.deltaX + event.deltaX,
                );
                wheelBuffer.current.deltaY = clampScroll(
                  wheelBuffer.current.deltaY + event.deltaY,
                );
                if (!wheelBuffer.current.timer) {
                  wheelBuffer.current.timer = setTimeout(() => {
                    const { deltaX, deltaY } = wheelBuffer.current;
                    wheelBuffer.current.deltaX = 0;
                    wheelBuffer.current.deltaY = 0;
                    wheelBuffer.current.timer = undefined;
                    if (deltaX || deltaY)
                      workspace.send({ type: "scroll", deltaX, deltaY });
                  }, 50);
                }
              }}
            />
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
      {active && !isDemo && !expired ? (
        <div className="remote-controls">
          <div className="remote-toolbar">
            <button
              className={`button button-light button-small ${showKeyboard ? "selected" : ""}`}
              onClick={() => setShowKeyboard(!showKeyboard)}
              aria-expanded={showKeyboard}
            >
              <Keyboard size={16} />
              Type text
            </button>
            <div className="keyboard-keys">
              <button
                title="Press Tab in browser"
                onClick={() => workspace.send({ type: "key", key: "Tab" })}
                disabled={!canInput}
              >
                Tab
              </button>
              <button
                title="Press Enter in browser"
                onClick={() => workspace.send({ type: "key", key: "Enter" })}
                disabled={!canInput}
              >
                &#x21b5;
              </button>
              <button
                title="Press Backspace in browser"
                onClick={() =>
                  workspace.send({ type: "key", key: "Backspace" })
                }
                disabled={!canInput}
              >
                &#x232b;
              </button>
              <button
                title="Scroll browser up"
                onClick={() =>
                  workspace.send({ type: "scroll", deltaX: 0, deltaY: -400 })
                }
                disabled={!canInput}
              >
                <ArrowUp size={15} />
              </button>
              <button
                title="Scroll browser down"
                onClick={() =>
                  workspace.send({ type: "scroll", deltaX: 0, deltaY: 400 })
                }
                disabled={!canInput}
              >
                <ArrowDown size={15} />
              </button>
            </div>
          </div>
          {showKeyboard ? (
            <form className="remote-text-form" onSubmit={sendText}>
              <label htmlFor="remote-input">
                Tap a field in the browser, then send text
              </label>
              <div className="input-with-button">
                <input
                  id="remote-input"
                  type={showText ? "text" : "password"}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="Text to send to the selected field"
                  disabled={!canInput}
                />
                <button
                  className="button button-dark button-small"
                  type="submit"
                  disabled={!canInput || !text}
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
            Tap to click. Use arrows to scroll. Type text into the selected
            field.
          </p>
        </div>
      ) : null}
      {!finished && !expired ? (
        <div className="session-actions">
          <button
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
              (!isDemo && workspace.status !== "connected") ||
              (active && !isDemo && !liveFrame)
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
        <div
          className="inline-confirm"
          role="alertdialog"
          aria-modal="true"
          aria-label="Decline this request"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setDenyOpen(false);
            }
            if (event.key === "Tab") {
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ),
              );
              const first = buttons[0];
              const last = buttons.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
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
        </div>
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
