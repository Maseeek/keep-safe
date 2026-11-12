import { useEffect, useState } from "react";
import { Check, Clock3, ShieldCheck, Smartphone } from "lucide-react";
import type { PairingState } from "../../../packages/shared/src/protocol";
import { CopyButton, QrCode } from "./pairing-ui";
import { parseInvite } from "./workspace";

/** Read once at load: the page that `keep-safe pair` opens on the computer. */
export function readDeskLink(): string | null {
  const link = new URLSearchParams(window.location.hash.slice(1)).get("desk");
  return link && parseInvite(link) ? link : null;
}

/** Shown on the computer: a large QR code for the phone, and whether it has been used. */
export function PairingDesk({ link }: { link: string }) {
  const invite = parseInvite(link)!;
  const [state, setState] = useState<{ state: PairingState; name?: string }>({ state: "waiting" });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const response = await fetch("/api/pair/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: invite.code }), cache: "no-store" });
        const next = await response.json() as { state: PairingState; name?: string };
        if (stopped) return;
        setState(next);
        if (next.state !== "waiting") return;
      } catch { /* The bridge may be restarting: keep asking. */ }
      timer = setTimeout(() => { void check(); }, 1500);
    };
    void check();
    return () => { stopped = true; clearTimeout(timer); };
  }, [invite.code]);
  const code = `${invite.code.slice(0, 4)}-${invite.code.slice(4)}`;
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
          <p>Run <code>keep-safe pair</code> on this computer for a new one.</p>
        </> : <>
          <h1 id="desk-title">Scan with your phone</h1>
          <p>Use the phone camera, or the scanner inside the Keep Safe app.</p>
          <QrCode value={link} label="Pairing QR code" />
          <div className="desk-code"><span>Pairing code</span><strong>{code}</strong></div>
          {invite.url !== window.location.origin || link.includes("bridge=") ? <p className="desk-address">Computer address: <code>{invite.url.replace(/^https?:\/\//, "")}</code></p> : null}
          <div className="desk-actions"><CopyButton text={link} label="Copy pairing link" /></div>
          <p className="desk-note" role="status"><Smartphone size={15} aria-hidden="true" /> Waiting for your phone. The code works once and expires in ten minutes.</p>
        </>}
      </section>
    </main>
  );
}
