import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Keyboard } from "lucide-react";
import type { EditableKind } from "../../../packages/shared/src/protocol";
import type { Workspace } from "./workspace";

export interface LiveKeyboardHandle {
  focus(): void;
  focused(): boolean;
  /** Call inside the tap itself. Where the browser lets a page open the
   * keyboard on request, takes focus now without showing it, so a later
   * `focus()` can open it even though the bridge answers after the tap. */
  prime(): void;
  /** The tap did not land in a text field: lets go of a primed focus. */
  unprime(): void;
}

/** Chrome on Android: opens the keyboard on request while the page still has
 * the tap's user activation. Missing on iOS and Firefox, which keep focus(). */
type VirtualKeyboard = { show(): void; hide(): void };
const virtualKeyboard = (): VirtualKeyboard | undefined => {
  const candidate = (navigator as Navigator & { virtualKeyboard?: Partial<VirtualKeyboard> }).virtualKeyboard;
  return typeof candidate?.show === "function" && typeof candidate.hide === "function" ? candidate as VirtualKeyboard : undefined;
};
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
  /** Focused during a tap, keyboard not shown yet. Not "active" until shown. */
  const primed = useRef(false);
  const primeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settle = () => { clearTimeout(primeTimer.current); primeTimer.current = undefined; };
  /** Opens the keyboard for a primed focus. */
  const reveal = () => {
    const element = input.current;
    settle();
    if (!primed.current || !element || document.activeElement !== element) return false;
    primed.current = false;
    try { virtualKeyboard()?.show(); } catch { /* The button stays as a fallback. */ }
    reset(); setActive(true); onActive(true);
    return true;
  };
  const unprime = () => {
    settle();
    if (!primed.current) return;
    primed.current = false;
    input.current?.blur();
  };
  const reset = () => {
    const element = input.current;
    if (!element) return;
    element.value = sentinel;
    try { element.setSelectionRange(1, 1); } catch { /* Not focused yet. */ }
  };
  useImperativeHandle(handle, () => ({
    focus() { if (enabled && !reveal()) input.current?.focus({ preventScroll: true }); },
    focused: () => document.activeElement === input.current,
    prime() {
      const element = input.current;
      if (!enabled || !element || !virtualKeyboard() || document.activeElement === element) return;
      // Manual: focus alone keeps the keyboard down until the bridge says the
      // tap landed in a text field.
      element.setAttribute("virtualkeyboardpolicy", "manual");
      primed.current = true;
      element.focus({ preventScroll: true });
      if (document.activeElement !== element) { primed.current = false; element.removeAttribute("virtualkeyboardpolicy"); return; }
      // An older bridge, or a browser that reports no focus, never answers.
      settle();
      primeTimer.current = setTimeout(unprime, 2000);
    },
    unprime,
  }), [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!enabled && document.activeElement === input.current) input.current?.blur(); }, [enabled]);
  useEffect(() => settle, []);
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
        onClick={() => { if (active) input.current?.blur(); else if (!reveal()) input.current?.focus({ preventScroll: true }); }}>
        <Keyboard size={17} aria-hidden="true" />
        <span className="dock-label">{wanted && !active ? "Tap to type" : "Keyboard"}</span>
      </button>
      <input ref={input} className="live-keyboard-input" type="password" aria-label="Type into the remote page" tabIndex={-1}
        autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go"
        inputMode={numeric ? "numeric" : kind === "email" ? "email" : kind === "url" ? "url" : "text"}
        disabled={!enabled} defaultValue={sentinel}
        onFocus={() => { reset(); if (!primed.current) { setActive(true); onActive(true); } }}
        onBlur={event => {
          const wasPrimed = primed.current;
          primed.current = false; settle();
          event.currentTarget.removeAttribute("virtualkeyboardpolicy");
          reset();
          if (!wasPrimed) { setActive(false); onActive(false); }
        }}
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
