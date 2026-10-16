import { useEffect, useRef, useState } from "react";
import { LoaderCircle, ShieldCheck, Trash2, X } from "lucide-react";
import { canClearHistory, type Workspace } from "./workspace";

function ClearHistoryDialog({ count, busy, error, demo, onCancel, onConfirm }: {
  count: number;
  busy: boolean;
  error: string;
  demo: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    cancel.current?.focus();
    return () => element?.close();
  }, []);
  return (
    <dialog ref={dialog} className="connect-dialog device-confirm-dialog history-confirm-dialog"
      aria-labelledby="history-confirm-title" aria-describedby="history-confirm-description"
      onCancel={event => { if (busy) event.preventDefault(); else onCancel(); }}>
      <button className="icon-button dialog-close" aria-label="Close confirmation" disabled={busy} onClick={onCancel}><X size={19} /></button>
      <div className="dialog-icon"><Trash2 size={26} /></div>
      <h2 id="history-confirm-title">Clear finished history?</h2>
      <p id="history-confirm-description">
        Remove up to {count} {demo ? "demo " : ""}finished {count === 1 ? "request" : "requests"} whose original access time has ended.
        Active requests and unexpired handoffs stay available. This cannot be undone.
      </p>
      <p>History exports you already downloaded and cookies in an externally attached agent browser remain under your control.</p>
      {error ? <p className="history-error" role="alert">{error}</p> : null}
      <div className="device-confirm-actions">
        <button ref={cancel} className="button button-light" disabled={busy} onClick={onCancel}>Keep history</button>
        <button className="button button-danger" disabled={busy} onClick={onConfirm}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}
          {busy ? "Clearing…" : "Clear history"}
        </button>
      </div>
    </dialog>
  );
}

export function HistoryControls({ workspace, now, notify }: { workspace: Workspace; now: number; notify: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const opener = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLElement>(null);
  const latestConnection = useRef(workspace.connection);
  latestConnection.current = workspace.connection;
  const demo = !workspace.connection;
  const supported = demo || workspace.info?.historyRetentionHours !== undefined;
  const clearable = workspace.requests.filter(request => canClearHistory(request, now)).length;
  const protectedCount = workspace.requests.filter(request => ["completed", "denied", "expired"].includes(request.status) && !canClearHistory(request, now)).length;
  useEffect(() => { setOpen(false); setBusy(false); setError(""); }, [workspace.connection]);
  const close = (cleared = false) => {
    setOpen(false);
    setError("");
    requestAnimationFrame(() => {
      const target = cleared || opener.current?.disabled ? container.current : opener.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
    });
  };
  const clear = async () => {
    const source = workspace.connection;
    setBusy(true);
    setError("");
    try {
      const result = await workspace.clearHistory();
      if (latestConnection.current !== source) return;
      close(true);
      notify(`${demo ? "Demo: cleared" : "Cleared"} ${result.removed} finished ${result.removed === 1 ? "request" : "requests"}.${result.protected ? ` Kept ${result.protected} while access or browser cleanup is still pending.` : ""}`);
    } catch (reason) {
      if (latestConnection.current === source) setError(reason instanceof Error ? reason.message : "History could not be cleared. Check your connection and try again.");
    } finally { if (latestConnection.current === source) setBusy(false); }
  };
  return (
    <section className="content-card history-controls" aria-labelledby="history-controls-title" ref={container} tabIndex={-1}>
      <div className="history-controls-copy">
        <h2 id="history-controls-title"><ShieldCheck size={18} /> Your history, your choice.</h2>
        <p>{demo ? "Demo history stays in this tab. Try clearing an older finished request." : supported ? "Eligible finished history clears automatically 24 hours after its original expiry, or earlier when space is needed. Browser cleanup must finish first. History stays on your computer." : "This bridge keeps request history in memory. Update the bridge on your computer to use cleanup controls."}</p>
        <p>Requests stay available until their original expiry so your agents can finish the handoff.</p>
        <span className="history-counts">{clearable} past expiry{protectedCount ? ` · ${protectedCount} kept until expiry` : ""}</span>
      </div>
      <button ref={opener} className="button button-light" disabled={!supported || !clearable || busy}
        onClick={() => { setError(""); setOpen(true); }}><Trash2 size={15} /> Clear finished history</button>
      {open ? <ClearHistoryDialog count={clearable} busy={busy} error={error} demo={demo} onCancel={() => close()} onConfirm={() => { void clear(); }} /> : null}
    </section>
  );
}
