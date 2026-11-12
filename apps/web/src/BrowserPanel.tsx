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
  Info,
  Keyboard,
  LoaderCircle,
  Maximize2,
  Minimize2,
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
import { LiveKeyboard, type LiveKeyboardHandle } from "./LiveKeyboard";

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
  const [showDetails, setShowDetails] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [stageSize, setStageSize] = useState<{ width: number; height: number } | null>(null);
  const [typing, setTyping] = useState(false);
  const [taps, setTaps] = useState<{ id: number; x: number; y: number }[]>([]);
  const [lift, setLift] = useState(0);
  const [keyboardArea, setKeyboardArea] = useState<{ top: number; height: number } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const keyboard = useRef<LiveKeyboardHandle>(null);
  const lastTapY = useRef<number | null>(null);
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

  const live = active && !isDemo;
  // Measure the space the website gets, before the browser is opened, so it
  // is laid out for this screen rather than letterboxed into it.
  useLayoutEffect(() => {
    const element = stage.current;
    if (!live || !element) { setStageSize(null); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = (immediate: boolean) => {
      const width = Math.floor(element.clientWidth); const height = Math.floor(element.clientHeight);
      if (width < 200 || height < 200) return;
      const apply = () => {
        setStageSize(previous => previous && previous.width === width && previous.height === height ? previous : { width, height });
        workspace.setViewport({ width, height, scale: Math.min(2, Math.max(1, window.devicePixelRatio || 1)), touch: window.matchMedia("(pointer: coarse)").matches });
      };
      clearTimeout(timer);
      if (immediate) apply();
      // The on-screen keyboard and rotation animate through many sizes.
      // Open tool panels borrow space from the page; that is not a new screen size.
      else timer = setTimeout(() => { if (!keyboard.current?.focused() && !panel.current?.querySelector(".page-control-content, .more-browser-keys, .remote-text-form")) apply(); }, 250);
    };
    measure(true);
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(element);
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [live, workspace.setViewport, workspace.browserPaused, workspace.navigationBusy, fullScreen]);
  useEffect(() => {
    workspace.watch(active && !isDemo && !expired ? request.id : null);
    return () => workspace.watch(null);
  }, [active, isDemo, request.id, workspace.watch, expired]);
  // Follow the browser's own full-screen state (Escape, system back).
  useEffect(() => {
    const changed = () => { if (!document.fullscreenElement) setFullScreen(false); };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    if (live && !finished && !expired) return;
    setFullScreen(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, [live, finished, expired]);
  const toggleFullScreen = () => {
    const next = !fullScreen;
    setFullScreen(next);
    // Hides browser bars where the platform allows it. The layout fills the
    // screen either way, which is all an installed app needs.
    if (next) void document.documentElement.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {});
    else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  };
  // While the phone keyboard is open, fit the whole live view into the space
  // above it and slide the page so the tapped field stays in view.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || !typing) { setKeyboardArea(null); setLift(0); return; }
    const update = () => {
      const open = viewport.height < window.innerHeight - 120;
      setKeyboardArea(open ? { top: Math.round(viewport.offsetTop), height: Math.round(viewport.height) } : null);
      const image = stage.current?.querySelector("img");
      const room = stage.current?.clientHeight ?? 0;
      if (!open || !image || lastTapY.current === null || !room) { setLift(0); return; }
      setLift(Math.round(Math.max(0, Math.min(image.clientHeight - room, lastTapY.current - room * 0.4))));
    };
    update();
    const settle = setTimeout(update, 350);
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => { clearTimeout(settle); viewport.removeEventListener("resize", update); viewport.removeEventListener("scroll", update); };
  }, [typing, taps.length]);
  useEffect(() => {
    setText("");
    setDemoStep(0);
    setShowKeyboard(false);
    setShowMoreKeys(false);
    setDenyOpen(false);
    setShowOrigin(false);
    setShowText(false);
    setShowDetails(false);
    setTaps([]);
    lastTapY.current = null;
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

  const tapped = useCallback((point: { clientX: number; clientY: number }) => {
    const bounds = stage.current?.getBoundingClientRect();
    if (!bounds) return;
    const image = stage.current?.querySelector("img")?.getBoundingClientRect();
    if (image) lastTapY.current = point.clientY - image.top;
    const id = performance.now();
    setTaps(previous => [...previous.slice(-3), { id, x: point.clientX - bounds.left, y: point.clientY - bounds.top }]);
    setTimeout(() => setTaps(previous => previous.filter(tap => tap.id !== id)), 450);
  }, [typing]);
  const target = workspace.typingTarget?.requestId === request.id ? workspace.typingTarget : null;
  // A tap landed in a text field: bring up the keyboard. Phones that insist on
  // a direct touch show the highlighted Keyboard button instead.
  useEffect(() => {
    if (target?.editable && canInput && !showKeyboard) keyboard.current?.focus();
  }, [target?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  const displaySize = liveFrame && stageSize ? (() => {
    const scale = Math.min(stageSize.width / liveFrame.width, stageSize.height / liveFrame.height);
    return { width: Math.round(liveFrame.width * scale), height: Math.round(liveFrame.height * scale) };
  })() : undefined;
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

  const liveNow = live && !finished && !expired;
  const toolsOpen = showKeyboard || showMoreKeys;
  const addressButton = (
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
  );
  return (
    <section
      ref={panel}
      style={keyboardArea ? { position: "fixed", left: 0, right: 0, top: keyboardArea.top, height: keyboardArea.height } : undefined}
      className={`browser-panel${keyboardArea ? " is-typing" : ""}${toolsOpen ? " has-tools" : ""}${live && !finished && !expired ? " is-live" : ""}${fullScreen ? " is-full-screen" : ""}${showDetails ? " shows-details" : ""}`}
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
        {liveNow ? addressButton : <span className="panel-label">Request</span>}
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
        {live && !finished && !expired ? <>
          <span className="panel-timer"><Clock3 size={13} aria-hidden="true" />{timeLeft(request.expiresAt, now)}</span>
          <button className="icon-button" aria-label={showDetails ? "Hide request details" : "Show request details"} aria-pressed={showDetails} onClick={() => setShowDetails(!showDetails)}><Info size={18} /></button>
          <button className="icon-button" aria-label={fullScreen ? "Exit full screen" : "Full screen"} aria-pressed={fullScreen} onClick={toggleFullScreen}>{fullScreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
        </> : null}
      </div>
      <div className="detail-heading">
        <AgentMark name={request.agent} />
        <div>
          <h2>{request.title}</h2>
          <p>
            {request.agent} <span>is asking you to sign in</span>
          </p>
        </div>
      </div>
      <div className="reason-box">
        <p>
          {request.reason ||
            "Please sign in to this website so I can continue my task."}
        </p>
      </div>
      <div className="session-meta">
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
          {liveNow ? null : addressButton}
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
            <div className="state-emblem"><LockKeyhole size={26} aria-hidden="true" /></div>
            <h3>Approve to open the browser</h3>
            <p>
              You’ll see the real website and sign in yourself. The agent waits until you hand it back.
            </p>
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
        ) : (
          <div className="remote-screen" ref={stage}>
            {liveFrame ? <div className="remote-page" style={lift ? { transform: `translateY(${-lift}px)` } : undefined}>
              <RemoteSurface frame={liveFrame} enabled={canInput} controlIdentity={workspace.connection} display={displaySize} onTap={tapped}
                alt={`Live browser on ${domain(liveFrame.url)}. Tap to click, or swipe inside the image to scroll the website.`}
                send={workspace.send} />
            </div> : (
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
            {taps.map(tap => <span key={tap.id} className="tap-ripple" style={{ left: tap.x, top: tap.y }} aria-hidden="true" />)}
            {liveFrame && workspace.status !== "connected" ? (
              <div className="reconnect-cover">
                <LoaderCircle className="spin" size={24} />
                <span>Reconnecting to your browser…</span>
              </div>
            ) : null}
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
          <div className="remote-toolbar">
            <div className="remote-toolbar-actions">
              <LiveKeyboard ref={keyboard} enabled={canInput && !workspace.focusBlocked} wanted={!!target?.editable} kind={target?.kind}
                send={workspace.send} onActive={setTyping} />
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
              {workspace.info?.pageControlsAvailable ? <ControlNavigator key={request.id} workspace={workspace} requestId={request.id} enabled={canInput && !workspace.focusBusy} onFocusRequested={() => setText("")} /> : null}
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
          <p className="input-hint">Tap the page to click, swipe to scroll. Tap a text field, then type.</p>
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
      {!live ? <p className="session-safety">
        <ShieldCheck size={13} aria-hidden="true" />
        Passwords stay with the website. Cookies stay on your computer.
      </p> : null}
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
    </section>
  );
}
