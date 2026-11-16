import { FRAME_HEADER_LIMIT, type FrameHeader } from "../../../packages/shared/src/protocol";

/** The newest image of the remote page. It lives outside React state so a
 * live stream does not re-render the app thirty times a second. Images stay
 * in memory only and are dropped the moment the view is cleared. */
export interface Screen {
  show(image: string | Blob): void;
  clear(): void;
  current(): string | null;
  subscribe(listener: (source: string | null) => void): () => void;
}

export function createScreen(): Screen {
  let source: string | null = null;
  let owned = false;
  const listeners = new Set<(source: string | null) => void>();
  const replace = (next: string | null, blob: boolean) => {
    const previous = owned ? source : null;
    source = next; owned = blob;
    for (const listener of listeners) listener(source);
    // An image already on screen stays there until the next one has loaded.
    if (previous) URL.revokeObjectURL(previous);
  };
  return {
    show(image) { if (typeof image === "string") replace(image, false); else replace(URL.createObjectURL(image), true); },
    clear() { if (source !== null) replace(null, false); },
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
