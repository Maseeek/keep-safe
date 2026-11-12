import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Keyboard } from "lucide-react";
import type { EditableKind } from "../../../packages/shared/src/protocol";
import type { Workspace } from "./workspace";

export interface LiveKeyboardHandle { focus(): void; focused(): boolean }
interface Props {
  enabled: boolean;
  /** The remote page has a text field focused, so typing would land somewhere. */
  wanted: boolean;
  kind?: EditableKind;
  send: Workspace["send"];
  onActive: (active: boolean) => void;
}

/** One placeholder character stays in the field so Backspace always has
 * something to delete. Typed characters are forwarded and removed at once:
 * nothing typed is kept on the phone. */
const sentinel = "•";
const forwardedKeys = new Set(["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Home", "End", "PageUp", "PageDown"]);

/** Types straight into the remote page with the phone's own keyboard. A
 * password-type field keeps keyboards from suggesting, learning or showing
 * what is typed, whatever the remote field is. */
export const LiveKeyboard = forwardRef<LiveKeyboardHandle, Props>(function LiveKeyboard({ enabled, wanted, kind, send, onActive }, handle) {
  const input = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);
  const composing = useRef(false);
  const reset = () => {
    const element = input.current;
    if (!element) return;
    element.value = sentinel;
    try { element.setSelectionRange(1, 1); } catch { /* Not focused yet. */ }
  };
  useImperativeHandle(handle, () => ({
    focus() { if (enabled) input.current?.focus({ preventScroll: true }); },
    focused: () => document.activeElement === input.current,
  }), [enabled]);
  useEffect(() => { if (!enabled && document.activeElement === input.current) input.current?.blur(); }, [enabled]);
  useEffect(() => {
    const clear = () => { if (document.visibilityState === "hidden") { reset(); input.current?.blur(); } };
    document.addEventListener("visibilitychange", clear);
    window.addEventListener("pagehide", clear);
    return () => { document.removeEventListener("visibilitychange", clear); window.removeEventListener("pagehide", clear); };
  }, []);
  const flush = () => {
    const element = input.current;
    if (!element || composing.current) return;
    const value = element.value;
    reset();
    if (!value.startsWith(sentinel)) {
      // The placeholder was deleted (Backspace), or replaced along with new text.
      if (value.length < sentinel.length || !value) send({ type: "key", key: "Backspace" });
      else send({ type: "text", text: value });
      return;
    }
    const text = value.slice(sentinel.length);
    if (text) send({ type: "text", text });
  };
  const numeric = kind === "numeric" || kind === "tel";
  return (
    <span className={`live-keyboard${active ? " is-active" : ""}${wanted && !active ? " is-wanted" : ""}`}>
      <button type="button" className={`button button-light button-small${active ? " selected" : ""}`} disabled={!enabled}
        aria-pressed={active} aria-label={active ? "Hide keyboard" : "Keyboard: type straight into the page"}
        // Keep focus where it is on press, then move it deliberately on click.
        onMouseDown={event => event.preventDefault()}
        onClick={() => { if (active) input.current?.blur(); else input.current?.focus({ preventScroll: true }); }}>
        <Keyboard size={16} aria-hidden="true" />
        {wanted && !active ? "Tap to type" : "Keyboard"}
      </button>
      <input ref={input} className="live-keyboard-input" type="password" aria-label="Type into the remote page" tabIndex={-1}
        autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go"
        inputMode={numeric ? "numeric" : kind === "email" ? "email" : kind === "url" ? "url" : "text"}
        disabled={!enabled} defaultValue={sentinel}
        onFocus={() => { reset(); setActive(true); onActive(true); }}
        onBlur={() => { reset(); setActive(false); onActive(false); }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; flush(); }}
        onInput={flush}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          const combo = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a";
          if (combo) { event.preventDefault(); send({ type: "key", key: "ControlOrMeta+A" }); return; }
          if (event.ctrlKey || event.metaKey || event.altKey || !forwardedKeys.has(event.key)) return;
          event.preventDefault();
          send({ type: "key", key: event.key === "Tab" && event.shiftKey ? "Shift+Tab" : event.key });
        }} />
    </span>
  );
});
