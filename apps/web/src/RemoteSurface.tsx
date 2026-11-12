import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { BrowserFrame, Workspace } from "./workspace";

interface Props {
  frame: BrowserFrame;
  enabled: boolean;
  controlIdentity: unknown;
  alt: string;
  send: Workspace["send"];
  /** Displayed size in CSS pixels, chosen by the stage so the image fills it. */
  display?: { width: number; height: number };
  /** Called for every accepted tap, with viewport coordinates for local feedback. */
  onTap?: (point: { clientX: number; clientY: number }) => void;
}
interface Scope {
  requestId: string;
  source: string;
  width: number;
  height: number;
  enabled: boolean;
  identity: unknown;
}
interface Gesture {
  pointerId: number;
  scope: Scope;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  started: number;
  dragging: boolean;
  x: number;
  y: number;
}
interface PendingScroll {
  scope: Scope;
  kind: "touch" | "wheel";
  deltaX: number;
  deltaY: number;
  x?: number;
  y?: number;
  timer?: ReturnType<typeof setTimeout>;
}
const clampDelta = (value: number) => Math.max(-3000, Math.min(3000, value));

/** Only coordinates and gesture state are retained here. Screenshot refreshes
 * are not new control intervals; navigation, geometry and pairing changes are.
 */
export function RemoteSurface({ frame, enabled, controlIdentity, alt, send, display, onTap }: Props) {
  const tapped = useRef(onTap);
  tapped.current = onTap;
  const image = useRef<HTMLImageElement>(null);
  const scope = useMemo<Scope>(() => ({
    requestId: frame.requestId, source: frame.url, width: frame.width,
    height: frame.height, enabled, identity: controlIdentity,
  }), [frame.requestId, frame.url, frame.width, frame.height, enabled, controlIdentity]);
  const current = useRef(scope);
  current.current = scope;
  const sender = useRef(send);
  sender.current = send;
  const gesture = useRef<Gesture | null>(null);
  const press = useRef<{ scope: Scope; pointerId: number; pointerType: string } | null>(null);
  const contacts = useRef({ ids: new Set<number>(), blocked: false });
  const pending = useRef<PendingScroll | null>(null);
  const lastScroll = useRef(-Infinity);

  const valid = useCallback((owner: Scope) => current.current === owner && owner.enabled &&
    Number.isFinite(owner.width) && Number.isFinite(owner.height) && owner.width > 0 && owner.height > 0 &&
    document.visibilityState !== "hidden" && !!image.current?.isConnected, []);
  const cancelScroll = useCallback(() => {
    if (pending.current?.timer !== undefined) clearTimeout(pending.current.timer);
    pending.current = null;
  }, []);
  const cancel = useCallback(() => {
    const previous = gesture.current;
    gesture.current = null;
    press.current = null;
    cancelScroll();
    if (contacts.current.ids.size) contacts.current.blocked = true;
    if (previous && image.current?.hasPointerCapture(previous.pointerId)) {
      try { image.current.releasePointerCapture(previous.pointerId); } catch { /* Pointer already ended. */ }
    }
  }, [cancelScroll]);

  const point = useCallback((owner: Scope, clientX: number, clientY: number, inside = false) => {
    const bounds = image.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    if (inside && (clientX < bounds.left || clientX >= bounds.right || clientY < bounds.top || clientY >= bounds.bottom)) return;
    return {
      x: Math.max(0, Math.min(owner.width - 1, Math.round((clientX - bounds.left) * owner.width / bounds.width))),
      y: Math.max(0, Math.min(owner.height - 1, Math.round((clientY - bounds.top) * owner.height / bounds.height))),
      scaleX: owner.width / bounds.width, scaleY: owner.height / bounds.height,
    };
  }, []);
  const queue = useCallback((owner: Scope, kind: PendingScroll["kind"], deltaX: number, deltaY: number, x?: number, y?: number) => {
    if (!valid(owner) || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    let batch = pending.current;
    if (!batch || batch.scope !== owner || batch.kind !== kind) {
      cancelScroll();
      batch = { scope: owner, kind, deltaX: 0, deltaY: 0, x, y };
      pending.current = batch;
    }
    if (kind === "wheel") { batch.x = x; batch.y = y; }
    batch.deltaX = clampDelta(batch.deltaX + deltaX);
    batch.deltaY = clampDelta(batch.deltaY + deltaY);
    if (batch.timer !== undefined) return;
    const captured = batch;
    const flush = () => {
      if (pending.current !== captured) return;
      captured.timer = undefined;
      if (!valid(captured.scope)) { pending.current = null; return; }
      const remaining = 50 - (performance.now() - lastScroll.current);
      if (remaining > 0) { captured.timer = setTimeout(flush, Math.ceil(remaining)); return; }
      pending.current = null;
      const deltaX = Math.round(captured.deltaX); const deltaY = Math.round(captured.deltaY);
      if (deltaX || deltaY) {
        lastScroll.current = performance.now();
        sender.current({ type: "scroll", deltaX, deltaY, x: captured.x, y: captured.y });
      }
    };
    captured.timer = setTimeout(flush, 50);
  }, [cancelScroll, valid]);

  useLayoutEffect(() => {
    cancel();
    return cancel;
  }, [scope, cancel]);
  useEffect(() => {
    const target = image.current;
    if (!target) return;
    const down = (event: PointerEvent) => {
      press.current = null;
      if (event.pointerType !== "touch") return;
      contacts.current.ids.add(event.pointerId);
      if (!event.isPrimary || contacts.current.ids.size > 1) {
        contacts.current.blocked = true;
        cancel();
      }
    };
    const ended = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      contacts.current.ids.delete(event.pointerId);
      if (!contacts.current.ids.size) contacts.current.blocked = false;
    };
    const cancelled = (event: PointerEvent) => {
      if (event.pointerType === "touch") { cancel(); ended(event); }
      else press.current = null;
    };
    const leave = () => { cancel(); contacts.current.ids.clear(); contacts.current.blocked = false; };
    const visibility = () => { if (document.visibilityState === "hidden") leave(); };
    const wheel = (event: WheelEvent) => {
      // Trackpad pinch/ctrl+wheel belongs to the host browser's zoom controls.
      if (event.ctrlKey) { cancel(); return; }
      const owner = current.current;
      const location = point(owner, event.clientX, event.clientY);
      if (!valid(owner) || !location) return;
      if (event.cancelable) event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? target.getBoundingClientRect().height : 1;
      const anchor = point(owner, event.clientX, event.clientY, true);
      queue(owner, "wheel", event.deltaX * unit * location.scaleX, event.deltaY * unit * location.scaleY, anchor?.x, anchor?.y);
    };
    let size = target.getBoundingClientRect();
    const resize = new ResizeObserver(() => {
      const next = target.getBoundingClientRect();
      if (next.width !== size.width || next.height !== size.height) cancel();
      size = next;
    });
    resize.observe(target);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", ended);
    window.addEventListener("pointercancel", cancelled, true);
    window.addEventListener("blur", leave);
    document.addEventListener("visibilitychange", visibility);
    target.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cancel();
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", ended);
      window.removeEventListener("pointercancel", cancelled, true);
      window.removeEventListener("blur", leave);
      document.removeEventListener("visibilitychange", visibility);
      target.removeEventListener("wheel", wheel);
      resize.disconnect();
    };
  }, [cancel, point, queue, valid]);

  const move = (event: ReactPointerEvent<HTMLImageElement>) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (!valid(active.scope) || contacts.current.blocked || contacts.current.ids.size !== 1) { cancel(); return; }
    const location = point(active.scope, event.clientX, event.clientY);
    if (!location) { cancel(); return; }
    if (!active.dragging && Math.hypot(event.clientX - active.startX, event.clientY - active.startY) >= 8) active.dragging = true;
    if (active.dragging) {
      queue(active.scope, "touch", (active.lastX - event.clientX) * location.scaleX, (active.lastY - event.clientY) * location.scaleY, active.x, active.y);
      active.lastX = event.clientX; active.lastY = event.clientY;
    }
  };

  return <img ref={image} src={`data:image/jpeg;base64,${frame.data}`} width={frame.width} height={frame.height}
    alt={alt} draggable={false} style={display ? { width: display.width, height: display.height } : undefined}
    // Keeps the phone keyboard open while tapping around the page: without
    // this the tap would move focus off the typing field and close it.
    onMouseDown={event => event.preventDefault()}
    onPointerDown={event => {
      if (event.pointerType === "mouse" || event.pointerType === "pen") {
        if (event.button === 0 && valid(scope)) press.current = { scope, pointerId: event.pointerId, pointerType: event.pointerType };
        return;
      }
      if (event.pointerType !== "touch") return;
      press.current = null;
      const location = point(scope, event.clientX, event.clientY, true);
      if (!valid(scope) || !event.isPrimary || contacts.current.blocked || contacts.current.ids.size !== 1 || !location) {
        contacts.current.blocked = true; cancel(); return;
      }
      cancelScroll();
      gesture.current = { pointerId: event.pointerId, scope, startX: event.clientX, startY: event.clientY,
        lastX: event.clientX, lastY: event.clientY, started: performance.now(), dragging: false, x: location.x, y: location.y };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { cancel(); }
    }}
    onPointerMove={move}
    onPointerUp={event => {
      const active = gesture.current;
      if (!active || active.pointerId !== event.pointerId || event.pointerType !== "touch") return;
      move(event);
      if (gesture.current !== active) return;
      const location = point(active.scope, event.clientX, event.clientY, true);
      const tap = !active.dragging && performance.now() - active.started < 500 && !contacts.current.blocked &&
        contacts.current.ids.size === 1 && valid(active.scope) && !!location;
      // Clear before normal capture release: lostpointercapture must not drop
      // this swipe's final coalesced delta, or turn it into a compatibility tap.
      gesture.current = null;
      if (tap && location && sender.current({ type: "click", x: location.x, y: location.y })) tapped.current?.({ clientX: event.clientX, clientY: event.clientY });
      try { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* Capture already ended. */ }
    }}
    onPointerCancel={cancel}
    onLostPointerCapture={event => { if (gesture.current?.pointerId === event.pointerId) cancel(); }}
    onContextMenu={event => { if (gesture.current || contacts.current.ids.size) { event.preventDefault(); cancel(); } }}
    onClick={event => {
      const native = event.nativeEvent as MouseEvent & { pointerId?: number; pointerType?: string; sourceCapabilities?: { firesTouchEvents?: boolean } | null };
      const touch = native.pointerType === "touch" || native.sourceCapabilities?.firesTouchEvents === true;
      const provenance = press.current;
      press.current = null;
      // Touch commits only on its checked pointerup. Legacy compatibility mouse
      // clicks lack a genuine mouse/pen down and cannot target a new request.
      const matchingPress = provenance?.scope === scope &&
        (!native.pointerType || native.pointerType === provenance.pointerType) &&
        (native.pointerId === undefined || native.pointerId === provenance.pointerId);
      if (touch || (event.detail !== 0 && !matchingPress) || !valid(scope)) {
        event.preventDefault(); return;
      }
      const location = point(scope, event.clientX, event.clientY);
      if (location && sender.current({ type: "click", x: location.x, y: location.y })) tapped.current?.({ clientX: event.clientX, clientY: event.clientY });
    }} />;
}
