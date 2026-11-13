import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Bell, Check, KeyRound, LoaderCircle, MonitorSmartphone, PlusSquare, Share, ShieldCheck, Smartphone, Sparkles } from "lucide-react";
import { PairForm, PromptCard, QrCode } from "./pairing-ui";
import type { Workspace } from "./workspace";

interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }

/** Install state for the three cases that differ: already installed, a browser
 * that can prompt (Android, desktop Chromium), and iOS, which needs the Share menu. */
export function useInstall() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(() => window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);
  useEffect(() => {
    const ready = (event: Event) => { event.preventDefault(); setPrompt(event as InstallPrompt); };
    const done = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener("beforeinstallprompt", ready);
    window.addEventListener("appinstalled", done);
    return () => { window.removeEventListener("beforeinstallprompt", ready); window.removeEventListener("appinstalled", done); };
  }, []);
  // No capability query tells iOS Safari apart, and only it needs these steps.
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return {
    installed, ios, canPrompt: !!prompt,
    async install() {
      if (!prompt) return false;
      await prompt.prompt();
      const choice = await prompt.userChoice.catch(() => ({ outcome: "dismissed" as const }));
      setPrompt(null);
      return choice.outcome === "accepted";
    },
  };
}

function Mark() {
  return <span className="brand-symbol" aria-hidden="true"><ShieldCheck size={22} strokeWidth={1.8} /></span>;
}

/** A looping three-beat picture of the product: asked, signed in, handed back. */
function HandoffArt() {
  return (
    <div className="handoff-art" aria-hidden="true">
      <div className="handoff-phone">
        <span className="handoff-notch" />
        <div className="handoff-card handoff-ask"><Sparkles size={14} /><span><b>Claude Code</b> needs you to sign in to GitHub</span></div>
        <div className="handoff-site">
          <span className="handoff-field"><i /></span>
          <span className="handoff-field"><i /></span>
          <span className="handoff-button" />
        </div>
        <div className="handoff-card handoff-done"><Check size={14} /><span>Handed back. Your agent is working again.</span></div>
      </div>
    </div>
  );
}

function Steps({ current, total }: { current: number; total: number }) {
  return <div className="welcome-progress" role="img" aria-label={`Step ${current} of ${total}`}>{Array.from({ length: total }, (_, index) => <span key={index} className={index < current ? "done" : ""} />)}</div>;
}

type Step = "intro" | "install" | "computer" | "pair";

export function Welcome({ workspace, onDemo, onOwnerToken, onPaired }: { workspace: Workspace; onDemo: () => void; onOwnerToken: () => void; onPaired: () => void }) {
  const install = useInstall();
  const invited = !!workspace.pendingInvite;
  const wide = useWide();
  // iOS keeps Home Screen apps in separate storage, so pairing in Safari would
  // not carry over. Offer the install first when the link arrives there.
  const holdForInstall = invited && install.ios && !install.installed;
  const [step, setStep] = useState<Step>(invited ? (holdForInstall ? "install" : "pair") : "intro");
  useEffect(() => {
    if (invited && !holdForInstall) void workspace.claimPendingInvite().then(ok => { if (ok) onPaired(); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const needsInstall = !install.installed && (install.ios || install.canPrompt);
  const order: Step[] = ["intro", ...(needsInstall ? ["install" as const] : []), "computer", "pair"];
  const next = () => setStep(order[Math.min(order.length - 1, order.indexOf(step) + 1)]);
  const back = () => setStep(order[Math.max(0, order.indexOf(step) - 1)]);

  if (invited && step === "pair") return (
    <main className="welcome">
      <section className="welcome-step" aria-labelledby="welcome-title">
        <Mark />
        {workspace.pairingError ? <>
          <h1 id="welcome-title">That code did not work</h1>
          <p className="welcome-lead">{workspace.pairingError}</p>
          <p>Codes last ten minutes and work once. On your computer, run <code>keep-safe pair</code> for a new one, or ask your agent to.</p>
          <PairForm workspace={workspace} onPaired={onPaired} />
          <button className="text-link" onClick={() => { workspace.dropPendingInvite(); workspace.clearPairingError(); setStep("intro"); }}>Start over</button>
        </> : <>
          <h1 id="welcome-title">Pairing with your computer…</h1>
          <p className="welcome-lead" role="status"><LoaderCircle className="spin" size={18} aria-hidden="true" /> One moment.</p>
        </>}
      </section>
    </main>
  );

  if (wide && step === "intro" && !invited) return <DesktopWelcome workspace={workspace} onDemo={onDemo} onOwnerToken={onOwnerToken} onPaired={onPaired} />;

  return (
    <main className="welcome">
      <header className="welcome-top">
        {step !== "intro" ? <button className="icon-button" aria-label="Back" onClick={back}><ArrowLeft size={20} /></button> : <span />}
        <Steps current={order.indexOf(step) + 1} total={order.length} />
        <span />
      </header>
      {step === "intro" ? (
        <section className="welcome-step" aria-labelledby="welcome-title">
          <HandoffArt />
          <h1 id="welcome-title">Sign in for your agents, from your phone.</h1>
          <p className="welcome-lead">When a coding agent hits a login page, you get a ping. Sign in on your phone and hand the browser back.</p>
          <div className="welcome-actions">
            <button className="button button-dark button-large" onClick={next}>Get started <ArrowRight size={18} aria-hidden="true" /></button>
            <button className="button button-quiet" onClick={onDemo}>Try the demo first</button>
          </div>
        </section>
      ) : step === "install" ? (
        <section className="welcome-step" aria-labelledby="welcome-title">
          <span className="welcome-icon"><Smartphone size={26} strokeWidth={1.6} aria-hidden="true" /></span>
          <h1 id="welcome-title">Add Keep Safe to your Home Screen</h1>
          <p className="welcome-lead">It opens like an app and can notify you when an agent needs you.</p>
          {install.ios ? (
            <ol className="welcome-list">
              <li><span><Share size={18} aria-hidden="true" /></span><div><b>Tap Share</b> in Safari's toolbar.</div></li>
              <li><span><PlusSquare size={18} aria-hidden="true" /></span><div>Choose <b>Add to Home Screen</b>.</div></li>
              <li><span><ShieldCheck size={18} aria-hidden="true" /></span><div><b>Open Keep Safe</b> from your Home Screen and carry on there{invited ? ", then scan the QR code again from inside the app" : ""}.</div></li>
            </ol>
          ) : null}
          <div className="welcome-actions">
            {install.canPrompt ? <button className="button button-dark button-large" onClick={() => { void install.install().then(next); }}>Install app</button> : null}
            <button className={install.canPrompt ? "button button-quiet" : "button button-light button-large"} onClick={() => { if (invited) { setStep("pair"); void workspace.claimPendingInvite().then(ok => { if (ok) onPaired(); }); } else next(); }}>
              {install.ios ? "Continue in Safari instead" : "Not now"}
            </button>
          </div>
        </section>
      ) : step === "computer" ? (
        <section className="welcome-step" aria-labelledby="welcome-title">
          <span className="welcome-icon"><MonitorSmartphone size={26} strokeWidth={1.6} aria-hidden="true" /></span>
          <h1 id="welcome-title">Set up your computer</h1>
          <p className="welcome-lead">On the computer your agents run on, paste this into any coding agent. It installs Keep Safe and opens a page with a QR code.</p>
          <PromptCard compact />
          <div className="welcome-actions">
            <button className="button button-dark button-large" onClick={next}>I can see the QR code <ArrowRight size={18} aria-hidden="true" /></button>
          </div>
        </section>
      ) : (
        <section className="welcome-step" aria-labelledby="welcome-title">
          <span className="welcome-icon"><KeyRound size={26} strokeWidth={1.6} aria-hidden="true" /></span>
          <h1 id="welcome-title">Pair this phone</h1>
          <p className="welcome-lead">Scan the QR code on your computer. One scan is all it takes, on Wi-Fi or mobile data.</p>
          <PairForm workspace={workspace} onPaired={onPaired} />
          <button className="text-link" onClick={onOwnerToken}>Use an owner token instead</button>
        </section>
      )}
    </main>
  );
}

function useWide() {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 900px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 900px)");
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return wide;
}

/** What a visitor on a computer sees: the one prompt that sets everything up. */
function DesktopWelcome({ workspace, onDemo, onOwnerToken, onPaired }: { workspace: Workspace; onDemo: () => void; onOwnerToken: () => void; onPaired: () => void }) {
  const [pairing, setPairing] = useState(false);
  return (
    <main className="landing">
      <header className="landing-top">
        <span className="brand"><Mark /><span>keep<span className="brand-light">safe</span></span></span>
        <nav aria-label="Welcome">
          <a href="https://github.com/Maseeek/keep-safe#readme" target="_blank" rel="noreferrer">Docs</a>
          <button className="button button-light button-small" onClick={onDemo}>Try the demo</button>
        </nav>
      </header>
      <section className="landing-hero">
        <div>
          <h1>Your agent hit a login page. <span>Sign in from your phone.</span></h1>
          <p className="landing-lead">Keep Safe shows you the agent's real browser on your phone. You tap and type the sign-in yourself, then hand it back. Passwords and cookies never leave your computer.</p>
          <PromptCard />
          <p className="landing-note">Free and self-hosted. Works with Claude Code, Codex, Cursor, T3 Code and any agent that speaks MCP.</p>
        </div>
        <HandoffArt />
      </section>
      <section className="landing-steps" aria-label="How it works">
        <article><span>1</span><h2>Paste the prompt</h2><p>Your agent installs Keep Safe on this computer and connects it to your agents. It takes a minute or two.</p></article>
        <article><span>2</span><h2>Scan the QR code</h2><p>A page with a QR code opens on this computer. Point your phone camera at it. One scan pairs the phone, with nothing else to install or type.</p></article>
        <article><span>3</span><h2>Approve from anywhere</h2><p>An agent asks, your phone pings, you sign in on the live page and hand the browser back.</p></article>
      </section>
      <section className="landing-phone">
        <QrCode value={window.location.origin} label="QR code that opens Keep Safe on your phone" />
        <div>
          <h2>Starting on your phone?</h2>
          <p>This code only opens Keep Safe on your phone. It walks you through adding it to your Home Screen. The code that pairs your phone appears after you paste the prompt above.</p>
          <div className="landing-links">
            <button className="text-link" onClick={() => setPairing(!pairing)} aria-expanded={pairing}><Bell size={14} aria-hidden="true" /> Pair this browser with a code</button>
            <button className="text-link" onClick={onOwnerToken}>Use an owner token</button>
          </div>
          {pairing ? <PairForm workspace={workspace} onPaired={onPaired} /> : null}
        </div>
      </section>
      <footer className="landing-foot">
        <span><ShieldCheck size={14} aria-hidden="true" /> No password storage, no input logs, no recordings.</span>
        <a href="https://github.com/Maseeek/keep-safe" target="_blank" rel="noreferrer">GitHub</a>
      </footer>
    </main>
  );
}
