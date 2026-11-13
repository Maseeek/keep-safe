import { useEffect, useRef, useState } from "react";
import { Camera, Check, ClipboardPaste, Copy, LoaderCircle, Share2, X } from "lucide-react";
import { foreignPairingLink, parseInvite, type PairingInvite, type Workspace } from "./workspace";
import { qrPath } from "./qr";

export const installCommand = "npx -y github:Maseeek/keep-safe setup";
export const agentPrompt = `Set up Keep Safe on this computer so I can approve website logins from my phone.

1. Run: ${installCommand}
   It needs Node.js 20 or newer and takes a minute or two the first time. It starts Keep Safe in the background, adds its MCP server to the agent CLIs it finds, and opens a page with a QR code in my browser.
2. I cannot see your terminal. Give me the "QR code page" link from its output as a clickable link, and tell me to scan the QR code on that page with my phone camera. One scan pairs my phone.
3. If your own MCP settings were not updated, add the JSON it printed under "Other MCP clients".
4. From now on, when a website needs me to sign in, call the keep-safe request_login tool, wait with wait_for_login, then continue in the same browser once I hand it back. Never ask me for passwords in chat.`;

/** True when this page came from the computer's own bridge rather than the
 * hosted app, so a bare code is enough to pair. */
export const servedByBridge = !window.location.hostname.endsWith(".vercel.app") && window.location.port !== "5173";

export function QrCode({ value, label }: { value: string; label: string }) {
  const { path, size } = qrPath(value);
  // Always dark on white with a quiet zone: phone cameras expect it, in either theme.
  return (
    <svg className="qr-code" viewBox={`-3 -3 ${size + 6} ${size + 6}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect x={-3} y={-3} width={size + 6} height={size + 6} fill="#ffffff" rx={1.5} />
      <path d={path} fill="#101214" />
    </svg>
  );
}

export function CopyButton({ text, label, className = "button button-light button-small", done = "Copied" }: { text: string; label: string; className?: string; done?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button type="button" className={className} onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {}); }}>
      {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      <span aria-live="polite">{copied ? done : label}</span>
    </button>
  );
}

/** The prompt a person pastes into their coding agent on the computer. */
export function PromptCard({ compact = false }: { compact?: boolean }) {
  const canShare = typeof navigator.share === "function";
  return (
    <div className={`prompt-card${compact ? " is-compact" : ""}`}>
      <div className="prompt-card-head">
        <span>Paste into your coding agent</span>
        <div>
          {canShare ? <button type="button" className="button button-light button-small" onClick={() => { void navigator.share({ title: "Set up Keep Safe", text: agentPrompt }).catch(() => {}); }}><Share2 size={15} aria-hidden="true" /> Send to computer</button> : null}
          <CopyButton text={agentPrompt} label="Copy prompt" className="button button-dark button-small" />
        </div>
      </div>
      <pre tabIndex={0}>{agentPrompt}</pre>
      <div className="prompt-card-foot">
        <span>Or run it yourself</span>
        <div><code>{installCommand}</code><CopyButton text={installCommand} label="Copy" /></div>
      </div>
    </div>
  );
}

type Detector = { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> };

/** Reads a pairing QR code with the camera. Frames stay on the phone. */
export function QrScanner({ onResult, onCancel }: { onResult: (text: string) => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const result = useRef(onResult);
  result.current = onResult;
  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach(track => track.stop()); };
    void (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { setError("This page cannot use the camera here. Enter the code instead."); return; }
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false }); }
      catch { setError("Camera access was not allowed. Allow it in your browser settings, or enter the code instead."); return; }
      if (stopped || !video.current) { stop(); return; }
      video.current.srcObject = stream;
      await video.current.play().catch(() => {});
      setReady(true);
      const Native = (window as unknown as { BarcodeDetector?: new (options: { formats: string[] }) => Detector }).BarcodeDetector;
      let detector: Detector | undefined;
      try { detector = Native ? new Native({ formats: ["qr_code"] }) : undefined; } catch { detector = undefined; }
      // Browsers without a built-in detector decode frames with a bundled library.
      const decode = detector ? undefined : (await import("jsqr")).default;
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const scan = async () => {
        if (stopped) return;
        const source = video.current;
        if (source && source.readyState >= 2 && source.videoWidth) {
          try {
            let text = "";
            if (detector) text = (await detector.detect(source))[0]?.rawValue ?? "";
            else if (decode && context) {
              const scale = Math.min(1, 640 / source.videoWidth);
              canvas.width = Math.round(source.videoWidth * scale); canvas.height = Math.round(source.videoHeight * scale);
              context.drawImage(source, 0, 0, canvas.width, canvas.height);
              const image = context.getImageData(0, 0, canvas.width, canvas.height);
              text = decode(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })?.data ?? "";
            }
            if (text && !stopped) { stop(); result.current(text); return; }
          } catch { /* Try the next frame. */ }
        }
        timer = setTimeout(() => { void scan(); }, 160);
      };
      void scan();
    })();
    return stop;
  }, []);
  return (
    <div className="qr-scanner">
      <div className="qr-scanner-view">
        <video ref={video} playsInline muted aria-label="Camera preview" />
        {!error ? <span className="qr-scanner-frame" aria-hidden="true" /> : null}
        {!ready && !error ? <span className="qr-scanner-wait"><LoaderCircle className="spin" size={22} aria-hidden="true" /> Starting camera…</span> : null}
        {error ? <p className="qr-scanner-error" role="alert"><Camera size={20} aria-hidden="true" />{error}</p> : null}
      </div>
      <p>{error ? "" : "Point the camera at the QR code on your computer."}</p>
      <button type="button" className="button button-light" onClick={onCancel}><X size={16} aria-hidden="true" /> Cancel</button>
    </div>
  );
}

/** Scan, paste or type: three ways to hand the app one pairing code. */
export function PairForm({ workspace, onPaired, autoScan = false }: { workspace: Workspace; onPaired?: () => void; autoScan?: boolean }) {
  const [scanning, setScanning] = useState(autoScan);
  const [text, setText] = useState("");
  const [address, setAddress] = useState("");
  const [problem, setProblem] = useState("");
  const selfHosted = servedByBridge;
  const [needsAddress, setNeedsAddress] = useState(false);
  const submit = async (invite: PairingInvite | null, scanned?: string) => {
    // A code for an app the computer serves itself: open it, as the camera would.
    const elsewhere = !invite && scanned ? foreignPairingLink(scanned) : null;
    if (elsewhere) { window.location.assign(elsewhere); return; }
    if (!invite) { setProblem("That is not a Keep Safe pairing code. Use the QR code or link your computer shows after keep-safe pair."); return; }
    setProblem("");
    if (await workspace.pairWithCode(invite)) onPaired?.();
  };
  const fromText = (value: string) => parseInvite(value, address.trim() || (selfHosted ? window.location.origin : undefined));
  const bareCode = /^[A-Za-z0-9]{4}[\s-]?[A-Za-z0-9]{4}$/.test(text.trim());
  useEffect(() => { setNeedsAddress(bareCode && !selfHosted); }, [bareCode, selfHosted]);
  if (scanning) return <QrScanner onCancel={() => setScanning(false)} onResult={value => { setScanning(false); void submit(parseInvite(value), value); }} />;
  return (
    <form className="pair-form" onSubmit={event => { event.preventDefault(); void submit(fromText(text), needsAddress ? undefined : text); }}>
      <button type="button" className="button button-dark button-large" onClick={() => { workspace.clearPairingError(); setProblem(""); setScanning(true); }} disabled={workspace.pairingBusy}>
        <Camera size={18} aria-hidden="true" /> Scan QR code
      </button>
      <div className="pair-form-divider"><span>{selfHosted ? "or enter it" : "or paste the link"}</span></div>
      <label htmlFor="pair-code">{selfHosted ? "Pairing code or link" : "Pairing link"}</label>
      <div className="pair-form-row">
        <input id="pair-code" value={text} onChange={event => setText(event.target.value)} placeholder={selfHosted ? "ABCD-2345" : "Paste the pairing link"} autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="go" />
        {navigator.clipboard?.readText ? <button type="button" className="icon-button" aria-label="Paste from clipboard" onClick={() => { void navigator.clipboard.readText().then(value => setText(value.trim()), () => {}); }}><ClipboardPaste size={18} /></button> : null}
      </div>
      {needsAddress ? <>
        <p className="pair-form-hint">A typed code also needs your computer's address. Scanning the QR code or pasting the pairing link is quicker.</p>
        <label htmlFor="pair-address">Computer address <span>shown under "Cannot scan?"</span></label>
        <input id="pair-address" value={address} onChange={event => setAddress(event.target.value)} placeholder="example-words.trycloudflare.com" inputMode="url" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </> : null}
      {problem || workspace.pairingError ? <p className="form-error" role="alert">{problem || workspace.pairingError}</p> : null}
      <button type="submit" className="button button-light" disabled={!text.trim() || workspace.pairingBusy || (needsAddress && !address.trim())}>
        {workspace.pairingBusy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : null}
        {workspace.pairingBusy ? "Pairing…" : "Pair this phone"}
      </button>
    </form>
  );
}
