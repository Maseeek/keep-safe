import { useEffect, useState } from "react";
import { Check, Clock3, ShieldCheck, Smartphone } from "lucide-react";
import type { PairingState } from "../../../packages/shared/src/protocol";
import { CopyButton, QrCode } from "./pairing-ui";
import { parseInvite } from "./workspace";

/** Read once at load: the page that `keep-safe pair` opens on the computer.
 * `#qr=CODE` asks the bridge for the link; `#desk=LINK` carries it. */
export function readDeskLink(): { code: string; link?: string } | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const link = params.get("desk");
  const invite = link ? parseInvite(link) : null;
  if (link && invite) return { code: invite.code, link };
  const code = (params.get("qr") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z0-9]{8}$/.test(code) ? { code } : null;
}

/** Shown on the computer: a large QR code for the phone, and whether it has been used. */
export function PairingDesk({ code, link: given }: { code: string; link?: string }) {
  const [state, setState] = useState<{ state: PairingState | "loading"; name?: string }>({ state: given ? "waiting" : "loading" });
  const [link, setLink] = useState(given ?? "");
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const response = await fetch("/api/pair/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }), cache: "no-store" });
        const next = await response.json() as { state: PairingState; name?: string; link?: string };
        if (stopped) return;
        if (next.link && parseInvite(next.link)) setLink(current => current || next.link!);
        setState(next);
        if (next.state !== "waiting") return;
      } catch { /* The bridge may be restarting: keep asking. */ }
      timer = setTimeout(() => { void check(); }, 1500);
    };
    void check();
    return () => { stopped = true; clearTimeout(timer); };
  }, [code]);
  const address = link ? parseInvite(link)?.url.replace(/^https?:\/\//, "") : "";
  return (
    <main className="desk">
      <section className="desk-card" aria-labelledby="desk-title">
        <span className="brand"><span className="brand-symbol" aria-hidden="true"><ShieldCheck size={22} strokeWidth={1.8} /></span><span>keep<span className="brand-light">safe</span></span></span>
        {state.state === "claimed" ? <>
          <span className="desk-result ok"><Check size={34} aria-hidden="true" /></span>
          <h1 id="desk-title">{state.name ?? "Your phone"} is paired</h1>
          <p>Requests from your agents now appear on that phone. You can close this tab.</p>
        </> : state.state === "expired" ? <>
          <span className="desk-result"><Clock3 size={34} aria-hidden="true" /></span>
          <h1 id="desk-title">This code has expired</h1>
          <p>Run <code>keep-safe pair</code> on this computer for a new one, or ask your agent to.</p>
        </> : !link ? <>
          <h1 id="desk-title">Getting your code…</h1>
          <p role="status">One moment.</p>
        </> : <>
          <h1 id="desk-title">Scan with your phone</h1>
          <p>Point your phone camera at this code. Keep Safe opens and pairs by itself.</p>
          <QrCode value={link} label="Pairing QR code" />
          <p className="desk-note" role="status"><Smartphone size={15} aria-hidden="true" /> Waiting for your phone. The code works once and expires in ten minutes.</p>
          <details className="desk-more">
            <summary>Cannot scan?</summary>
            <p>Send this link to your phone and open it there.</p>
            <div className="desk-actions"><CopyButton text={link} label="Copy pairing link" /></div>
            <div className="desk-code"><span>Or type this code in the app</span><strong>{`${code.slice(0, 4)}-${code.slice(4)}`}</strong></div>
            {address && address !== window.location.host ? <p className="desk-address">Computer address: <code>{address}</code></p> : null}
          </details>
        </>}
      </section>
    </main>
  );
}
