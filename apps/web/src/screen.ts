import { FRAME_HEADER_LIMIT, type FrameHeader } from "../../../packages/shared/src/protocol";

/** The newest image of the remote page. It lives outside React state so a
 * live stream does not re-render the app thirty times a second. Images stay
 * in memory only and are dropped the moment the view is cleared. */
export interface Screen {
  /** Shows an image once it has decoded. `onShown` runs when it is on screen,
   * or when it was skipped for a newer image or failed to decode, so a caller
   * waiting on it is never left waiting. */
  show(image: string | Blob, onShown?: () => void): void;
  clear(): void;
  current(): string | null;
  subscribe(listener: (source: string | null) => void): () => void;
}

interface Pending { source: string; owned: boolean; onShown?: () => void; decoder?: HTMLImageElement }

/** Decodes off the page, so the visible image swaps to an already decoded
 * picture instead of decoding while it is shown. */
function decode(item: Pending): Promise<void> {
  const image = new Image();
  image.decoding = "async";
  item.decoder = image;
  image.src = item.source;
  if (typeof image.decode === "function") return image.decode();
  return new Promise((resolve, reject) => {
    if (image.complete && image.naturalWidth) { resolve(); return; }
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("The image did not decode."));
  });
}

export function createScreen(): Screen {
  let source: string | null = null;
  let owned = false;
  /** Keeps the shown picture's decoded copy alive while it is on screen. */
  let shownDecoder: HTMLImageElement | undefined;
  const listeners = new Set<(source: string | null) => void>();
  /** The image decoding now, and the newest one waiting behind it. A decode
   * in progress is never abandoned: on a busy phone a stream of replacements
   * would otherwise never finish one and the view would freeze. */
  let decoding: Pending | null = null;
  let queued: Pending | null = null;
  let generation = 0;
  const canDecode = typeof Image === "function";

  const settle = (item: Pending) => {
    item.decoder = undefined;
    try { item.onShown?.(); } catch { /* A caller's acknowledgement never breaks the view. */ }
  };
  const discard = (item: Pending) => {
    if (item.owned) URL.revokeObjectURL(item.source);
    settle(item);
  };
  const replace = (next: string | null, blob: boolean) => {
    const previous = owned ? source : null;
    source = next; owned = blob;
    for (const listener of listeners) listener(source);
    // An image already on screen stays there until the next one has loaded.
    if (previous) URL.revokeObjectURL(previous);
  };
  const publish = (item: Pending) => {
    replace(item.source, item.owned);
    shownDecoder = item.decoder;
    settle(item);
  };
  const start = (item: Pending) => {
    decoding = item;
    const started = generation;
    const advance = () => {
      if (started !== generation) return;
      decoding = null;
      const next = queued; queued = null;
      if (next) start(next);
    };
    decode(item).then(() => true, () => false).then(ok => {
      if (started !== generation) { discard(item); return; }
      if (!ok) { discard(item); advance(); return; }
      // Shown as soon as it decodes: the browser paints it on its next frame
      // without waiting on timers. The newest finished image is shown even
      // when a newer one is waiting, so a fast stream still moves on a slow phone.
      publish(item);
      advance();
    }, () => { discard(item); advance(); });
  };

  return {
    show(image, onShown) {
      const item: Pending = typeof image === "string" ? { source: image, owned: false, onShown } : { source: URL.createObjectURL(image), owned: true, onShown };
      if (!canDecode) { publish(item); return; }
      if (decoding) { if (queued) discard(queued); queued = item; return; }
      start(item);
    },
    clear() {
      generation++;
      const waiting = queued; queued = null; decoding = null;
      if (waiting) discard(waiting);
      shownDecoder = undefined;
      if (source !== null) replace(null, false);
    },
    current: () => source,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** Splits a binary frame into what it says about itself and its JPEG. */
export function readBinaryFrame(data: unknown): { header: FrameHeader; image: Blob } | null {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 6) return null;
  const length = new DataView(data).getUint32(0);
  if (length < 2 || length > FRAME_HEADER_LIMIT || 4 + length >= data.byteLength) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, length))) as FrameHeader | null;
    if (!header || header.type !== "frame" || typeof header.requestId !== "string" || typeof header.url !== "string" ||
      !Number.isFinite(header.width) || !Number.isFinite(header.height) || header.width <= 0 || header.height <= 0) return null;
    return { header, image: new Blob([new Uint8Array(data, 4 + length)], { type: "image/jpeg" }) };
  } catch { return null; }
}
