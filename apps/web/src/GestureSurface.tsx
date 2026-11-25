import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useScreenImage, type SurfaceProps } from "./RemoteSurface";

interface Scope {
  requestId: string;
  source: string;
  width: number;
  height: number;
  enabled: boolean;
  identity: unknown;
  /** Switching between touching and selecting ends whatever was held. */
  selecting: boolean;
}
/** A finger or pressed mouse button that the remote page currently sees. */
interface Press {
  kind: "touch" | "mouse";
  pointerId: number;
  scope: Scope;
  startX: number;
  startY: number;
  started: number;
  moved: boolean;
}
interface Pending { kind: "touch" | "mouse"; clientX: number; clientY: number; t: number }
/** When the event happened on this device, so the page sees the finger's real speed. */
const at = (kind: "touch" | "mouse", time: number) => kind === "touch" && Number.isFinite(time) && time >= 0 ? { t: Math.round(time * 10) / 10 } : {};

const maxZoom = 4;
/** Movement below this still counts as a tap. Close to Chromium's own slop. */
const tapSlop = 12;
const moveIntervalMs = 15;
const clampDelta = (value: number) => Math.max(-3000, Math.min(3000, value));

/** Forwards what the hand does instead of guessing what it means. One finger
 * goes to the page as a real touch, so the website handles taps, scrolling
 * with momentum, sliders, drag puzzles and long presses itself. Two fingers
 * zoom and move the view on this device. A mouse hovers, presses and drags.
 * Only coordinates are kept here, never what the page shows. */
export function GestureSurface({ frame, screen, enabled, controlIdentity, alt, send, display, onTap, selecting = false }: SurfaceProps) {
  const image = useRef<HTMLImageElement>(null);
  useScreenImage(image, screen);
  const tapped = useRef(onTap);
  tapped.current = onTap;
  const sender = useRef(send);
  sender.current = send;
  const scope = useMemo<Scope>(() => ({
    requestId: frame.requestId, source: frame.url, width: frame.width,
    height: frame.height, enabled, identity: controlIdentity, selecting,
  }), [frame.requestId, frame.url, frame.width, frame.height, enabled, controlIdentity, selecting]);
  const current = useRef(scope);
  current.current = scope;

  const press = useRef<Press | null>(null);
  const contacts = useRef(new Map<number, { x: number; y: number }>());
  /** Fingers left over from a zoom, or from a refused press, do nothing until all lift. */
  const blocked = useRef(false);
  const pending = useRef<Pending | null>(null);
  const moveTimer = useRef<number | undefined>(undefined);
  const lastMove = useRef(-Infinity);
  const view = useRef({ zoom: 1, x: 0, y: 0 });
  const pinch = useRef<{ distance: number; zoom: number; anchorX: number; anchorY: number } | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const wheel = useRef<{ scope: Scope; deltaX: number; deltaY: number; x: number; y: number; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const lastWheel = useRef(-Infinity);
  const lastTapAt = useRef(-Infinity);

  const valid = useCallback((owner: Scope) => current.current === owner && owner.enabled &&
    owner.width > 0 && owner.height > 0 && document.visibilityState !== "hidden" && !!image.current?.isConnected, []);
  /** Maps a point on this screen to the page, through any zoom. */
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

  const applyView = useCallback((zoom: number, x: number, y: number) => {
    const element = image.current;
    if (!element) return;
    const next = Math.max(1, Math.min(maxZoom, zoom));
    // The zoomed image always covers the space the page was given.
    const width = element.offsetWidth; const height = element.offsetHeight;
    view.current = { zoom: next, x: Math.min(0, Math.max(width - width * next, x)), y: Math.min(0, Math.max(height - height * next, y)) };
    const { zoom: scale, x: left, y: top } = view.current;
    element.style.transform = scale === 1 ? "" : `translate(${left}px, ${top}px) scale(${scale})`;
    setZoomed(scale > 1.01);
  }, []);

  const clearMoves = useCallback(() => {
    pending.current = null;
    if (moveTimer.current !== undefined) { cancelAnimationFrame(moveTimer.current); moveTimer.current = undefined; }
  }, []);
  const flushMove = useCallback(() => {
    const move = pending.current;
    pending.current = null;
    if (!move) return;
    const owner = press.current?.scope ?? current.current;
    const location = valid(owner) ? point(owner, move.clientX, move.clientY, !press.current) : undefined;
    if (!location) return;
    lastMove.current = performance.now();
    sender.current({ type: move.kind, phase: "move", x: location.x, y: location.y, ...at(move.kind, move.t) } as Parameters<typeof send>[0]);
  }, [point, valid]);
  /** At most one move per screen refresh. Only the newest position is sent. */
  const queueMove = useCallback((move: Pending) => {
    pending.current = move;
    if (moveTimer.current !== undefined) return;
    const run = () => {
      if (performance.now() - lastMove.current < moveIntervalMs) { moveTimer.current = requestAnimationFrame(run); return; }
      moveTimer.current = undefined;
      flushMove();
    };
    moveTimer.current = requestAnimationFrame(run);
  }, [flushMove]);

  /** Takes the finger or button off the remote page without completing anything. */
  const cancel = useCallback(() => {
    const active = press.current;
    press.current = null;
    clearMoves();
    if (wheel.current?.timer !== undefined) clearTimeout(wheel.current.timer);
    wheel.current = null;
    pinch.current = null;
    if (contacts.current.size) blocked.current = true;
    if (!active) return;
    // The page may already be gone. The bridge also lifts a held pointer when
    // this view stops, so a refused message here leaves nothing pressed.
    // Still the same request on the same connection, even if the page size or
    // address changed: the remote page must not keep the button held.
    const now = current.current;
    if (now.requestId === active.scope.requestId && now.identity === active.scope.identity && now.enabled) sender.current({ type: active.kind, phase: "cancel", x: 0, y: 0 });
    if (image.current?.hasPointerCapture(active.pointerId)) {
      try { image.current.releasePointerCapture(active.pointerId); } catch { /* Pointer already ended. */ }
    }
  }, [clearMoves]);

  useLayoutEffect(() => {
    cancel();
    return cancel;
  }, [scope, cancel]);
  // A different page size or request starts unzoomed.
  useLayoutEffect(() => { applyView(1, 0, 0); }, [frame.requestId, frame.width, frame.height, display?.width, display?.height, applyView]);

  // Attached before the first paint, so the image never shows without them.
  useLayoutEffect(() => {
    const target = image.current;
    if (!target) return;
    const leave = () => { cancel(); contacts.current.clear(); blocked.current = false; };
    const visibility = () => { if (document.visibilityState === "hidden") leave(); };
    const scroll = (event: WheelEvent) => {
      // Trackpad pinch and ctrl+wheel belong to this browser's own zoom.
      if (event.ctrlKey) return;
      const owner = current.current;
      const location = point(owner, event.clientX, event.clientY, true);
      if (!valid(owner) || !location) return;
      if (event.cancelable) event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? target.getBoundingClientRect().height : 1;
      let batch = wheel.current;
      if (!batch || batch.scope !== owner) {
        if (batch?.timer !== undefined) clearTimeout(batch.timer);
        batch = wheel.current = { scope: owner, deltaX: 0, deltaY: 0, x: location.x, y: location.y };
      }
      batch.x = location.x; batch.y = location.y;
      batch.deltaX = clampDelta(batch.deltaX + event.deltaX * unit * location.scaleX);
      batch.deltaY = clampDelta(batch.deltaY + event.deltaY * unit * location.scaleY);
      if (batch.timer !== undefined) return;
      const captured = batch;
      const flush = () => {
        if (wheel.current !== captured) return;
        captured.timer = undefined;
        if (!valid(captured.scope)) { wheel.current = null; return; }
        const remaining = 30 - (performance.now() - lastWheel.current);
        if (remaining > 0) { captured.timer = setTimeout(flush, Math.ceil(remaining)); return; }
        wheel.current = null;
        const deltaX = Math.round(captured.deltaX); const deltaY = Math.round(captured.deltaY);
        if (!deltaX && !deltaY) return;
        lastWheel.current = performance.now();
        sender.current({ type: "scroll", deltaX, deltaY, x: captured.x, y: captured.y });
      };
      captured.timer = setTimeout(flush, 0);
    };
    let size = { width: target.offsetWidth, height: target.offsetHeight };
    const resize = new ResizeObserver(() => {
      if (target.offsetWidth !== size.width || target.offsetHeight !== size.height) cancel();
      size = { width: target.offsetWidth, height: target.offsetHeight };
    });
    resize.observe(target);
    window.addEventListener("blur", leave);
    document.addEventListener("visibilitychange", visibility);
    target.addEventListener("wheel", scroll, { passive: false });
    return () => {
      leave();
      window.removeEventListener("blur", leave);
      document.removeEventListener("visibilitychange", visibility);
      target.removeEventListener("wheel", scroll);
      resize.disconnect();
    };
  }, [cancel, point, valid]);

  const down = (event: ReactPointerEvent<HTMLImageElement>) => {
    const touch = event.pointerType === "touch";
    if (!touch && event.button !== 0) return;
    if (touch) {
      contacts.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (contacts.current.size > 1) {
        // A second finger means the owner is zooming this view, not the page.
        cancel();
        blocked.current = true;
        const [first, second] = [...contacts.current.values()];
        const bounds = event.currentTarget.getBoundingClientRect();
        const { zoom, x, y } = view.current;
        const middleX = (first.x + second.x) / 2; const middleY = (first.y + second.y) / 2;
        pinch.current = contacts.current.size === 2 ? {
          distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)), zoom,
          // The point of the unzoomed image under the middle of the two fingers.
          anchorX: (middleX - (bounds.left - x) - x) / zoom, anchorY: (middleY - (bounds.top - y) - y) / zoom,
        } : null;
        return;
      }
    }
    if (blocked.current || press.current) return;
    const location = point(scope, event.clientX, event.clientY, true);
    // While selecting, a finger is sent as a mouse: dragging then marks text.
    const kind = touch && !selecting ? "touch" : "mouse";
    if (!valid(scope) || !location || !sender.current({ type: kind, phase: kind === "touch" ? "start" : "down", x: location.x, y: location.y, ...at(kind, event.timeStamp) } as Parameters<typeof send>[0])) {
      if (touch) blocked.current = true;
      return;
    }
    clearMoves();
    press.current = { kind, pointerId: event.pointerId, scope, startX: event.clientX, startY: event.clientY, started: performance.now(), moved: false };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* The press still ends on pointerup. */ }
  };

  const move = (event: ReactPointerEvent<HTMLImageElement>) => {
    const touch = event.pointerType === "touch";
    if (touch && contacts.current.has(event.pointerId)) contacts.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const zooming = pinch.current;
    if (touch && zooming && contacts.current.size === 2) {
      const [first, second] = [...contacts.current.values()];
      const bounds = event.currentTarget.getBoundingClientRect();
      const origin = { x: bounds.left - view.current.x, y: bounds.top - view.current.y };
      const zoom = Math.max(1, Math.min(maxZoom, zooming.zoom * Math.hypot(first.x - second.x, first.y - second.y) / zooming.distance));
      applyView(zoom, (first.x + second.x) / 2 - origin.x - zooming.anchorX * zoom, (first.y + second.y) / 2 - origin.y - zooming.anchorY * zoom);
      return;
    }
    const active = press.current;
    if (active) {
      if (active.pointerId !== event.pointerId) return;
      if (!valid(active.scope)) { cancel(); return; }
      if (!active.moved && Math.hypot(event.clientX - active.startX, event.clientY - active.startY) >= tapSlop) active.moved = true;
      queueMove({ kind: active.kind, clientX: event.clientX, clientY: event.clientY, t: event.timeStamp });
    } else if (!touch && valid(scope)) queueMove({ kind: "mouse", clientX: event.clientX, clientY: event.clientY, t: event.timeStamp }); // Hover.
  };

  const up = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (event.pointerType === "touch") {
      contacts.current.delete(event.pointerId);
      if (contacts.current.size < 2) pinch.current = null;
      if (!contacts.current.size) blocked.current = false;
    }
    const active = press.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (!valid(active.scope)) { cancel(); return; }
    if (!active.moved && Math.hypot(event.clientX - active.startX, event.clientY - active.startY) >= tapSlop) active.moved = true;
    // The release lands exactly where the finger was: send that position first.
    pending.current = { kind: active.kind, clientX: event.clientX, clientY: event.clientY, t: event.timeStamp };
    if (moveTimer.current !== undefined) { cancelAnimationFrame(moveTimer.current); moveTimer.current = undefined; }
    if (active.moved) flushMove(); else pending.current = null;
    press.current = null;
    const location = point(active.scope, event.clientX, event.clientY);
    const tap = !active.moved && performance.now() - active.started < 600;
    if (!location) { sender.current({ type: active.kind, phase: "cancel", x: 0, y: 0 }); return; }
    if (sender.current({ type: active.kind, phase: active.kind === "touch" ? "end" : "up", x: location.x, y: location.y, ...(tap ? { tap: true } : {}), ...at(active.kind, event.timeStamp) } as Parameters<typeof send>[0]) && tap) {
      if (active.kind === "touch") lastTapAt.current = performance.now();
      tapped.current?.({ clientX: event.clientX, clientY: event.clientY });
    }
    try { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* Capture already ended. */ }
  };

  const cancelled = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (event.pointerType === "touch") {
      contacts.current.delete(event.pointerId);
      if (contacts.current.size < 2) pinch.current = null;
    }
    if (press.current?.pointerId === event.pointerId) cancel();
    if (!contacts.current.size) blocked.current = false;
  };

  return <>
    <img ref={image} className="takes-gestures" width={frame.width} height={frame.height}
      alt={alt} draggable={false} style={display ? { width: display.width, height: display.height } : undefined}
      // Keeps the phone keyboard open while touching the page: without this
      // the press would move focus off the typing field and close it.
      onMouseDown={event => event.preventDefault()}
      onTouchEnd={event => { if (performance.now() - lastTapAt.current < 120) event.preventDefault(); }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancelled}
      onLostPointerCapture={event => { if (press.current?.pointerId === event.pointerId) cancel(); }}
      onContextMenu={event => event.preventDefault()} />
    {zoomed ? <button type="button" className="zoom-reset" onClick={() => applyView(1, 0, 0)}>Reset zoom</button> : null}
  </>;
}
