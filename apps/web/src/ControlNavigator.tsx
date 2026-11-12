import { useState } from "react";
import { createPortal } from "react-dom";
import { Check, List, LoaderCircle, LockKeyhole, RefreshCw } from "lucide-react";
import type { Workspace } from "./workspace";
import type { PageControl } from "../../../packages/shared/src/protocol";

const controlName = (control: PageControl, index: number) => control.name || `Unnamed ${control.role} ${index + 1}`;
const frameContext = (control: PageControl) => control.embedded ? `Embedded page · ${control.frameOrigin || "origin unavailable"}` : "";

/** The button sits in the tool row; the list opens in the tray above it. */
export function ControlNavigator({ workspace, requestId, enabled, onFocusRequested, tray }: { workspace: Workspace; requestId: string; enabled: boolean; onFocusRequested: () => void; tray?: HTMLElement | null }) {
  const [open, setOpen] = useState(false);
  const snapshot = workspace.pageControls?.requestId === requestId ? workspace.pageControls.snapshot : null;
  const focusedIndex = snapshot && workspace.focusedControl?.snapshotId === snapshot.snapshotId
    ? snapshot.controls.findIndex(control => control.id === workspace.focusedControl?.controlId) : -1;
  const focused = focusedIndex >= 0 ? snapshot?.controls[focusedIndex] : undefined;
  const list = (
<div id="page-control-list" className="page-control-content">
        <div className="page-control-heading"><h3>Choose a control</h3>
          <button className="icon-button" aria-label="Refresh page controls" disabled={!enabled || workspace.controlsBusy || workspace.focusBusy} onClick={workspace.inspectControls}><RefreshCw size={16} /></button>
        </div>
        <p>Focus a labeled field or button, then use Type text or the remote keys. Field values and link addresses are not read.</p>
        {workspace.controlsBusy ? <p role="status"><LoaderCircle size={15} className="spin" /> Reading controls…</p> : null}
        {workspace.controlsError ? <p className="page-control-error" role="alert">{workspace.controlsError} Choose a field again, or use a browser tap, Tab or Shift+Tab before sending input.</p> : null}
        {snapshot ? <>
          <p className="page-control-origin">From {snapshot.origin}</p>
          {snapshot.controls.length ? <ul className="page-control-list">{snapshot.controls.map((control, index) => <li key={control.id}>
            <button aria-label={`Focus ${controlName(control, index)}`} aria-describedby={`page-control-state-${control.id}`} disabled={!enabled || control.disabled || workspace.focusBusy || workspace.controlsBusy}
              onClick={() => { onFocusRequested(); workspace.focusControl(snapshot.snapshotId, control.id); }}>
              <span className="page-control-name">{control.protected ? <LockKeyhole size={14} /> : null}{controlName(control, index)}</span>
              <span id={`page-control-state-${control.id}`} className="page-control-role">{control.protected ? "Password field" : control.role}{control.checked === undefined ? "" : control.checked ? " · checked" : " · unchecked"}{control.disabled ? " · unavailable" : ""}{control.embedded ? <span className="page-control-frame">{frameContext(control)}</span> : null}</span>
            </button>
          </li>)}</ul> : <p>No supported visible controls found. Use the live browser keys or refresh after the page changes.</p>}
          {snapshot.truncated ? <p>Showing {snapshot.controls.length} {snapshot.controls.length === 1 ? "control" : "controls"} from a limited scan.</p> : null}
        </> : null}
        <p className="page-control-focus" role="status" aria-live="polite">
          {workspace.focusBusy ? "Waiting for the browser to confirm focus…" : focused ? <><Check size={15} /><span>Focus confirmed on {controlName(focused, focusedIndex)}{focused.embedded ? ` in ${focused.frameOrigin || "the embedded page"}` : ""}.</span></> : workspace.focusBlocked ? "Confirm a field before sending text or keys. A browser tap, Tab or Shift+Tab also restores input." : ""}
        </p>
        <p className="page-control-limit">Main page, supported embedded pages and web components. Some forms still need browser taps or keys. Physical screen-reader testing is still pending.</p>
      </div>
  );
  return (
    <section className="control-navigator" aria-label="Remote page controls">
      <button className="button button-light button-small" disabled={!enabled}
        aria-expanded={open} aria-controls={open ? "page-control-list" : undefined}
        onClick={() => { if (!open) workspace.inspectControls(); setOpen(!open); }}>
        <List size={16} /> Page controls
      </button>
      {open ? (tray ? createPortal(list, tray) : tray === undefined ? list : null) : null}
    </section>
  );
}
