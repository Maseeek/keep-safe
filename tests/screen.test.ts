import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScreen, readBinaryFrame } from '../apps/web/src/screen';

/** A stand-in for the phone's image decoder: each decode finishes only when
 * the test says so, so ordering is exact. */
const decodes: Array<{ src: string; resolve(): void; reject(): void }> = [];
class FakeImage {
  decoding = 'auto';
  src = '';
  decode() { return new Promise<void>((resolve, reject) => { decodes.push({ src: this.src, resolve, reject }); }); }
}
const revoked: string[] = [];
let urls = 0;
const flush = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };
/** Lets a decode finish. */
async function finish(index: number, ok = true) {
  const decode = decodes[index];
  if (ok) decode.resolve(); else decode.reject();
  await flush();
}

beforeEach(() => {
  // The screen must not depend on timers: a paused or hidden page has none.
  vi.useFakeTimers();
  decodes.length = 0; revoked.length = 0; urls = 0;
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:frame-${++urls}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => { revoked.push(url); });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });

describe('the phone screen', () => {
  it('shows an image only after it decodes, then reports it shown', async () => {
    const screen = createScreen();
    const seen: Array<string | null> = [];
    screen.subscribe(source => seen.push(source));
    const shown = vi.fn();
    screen.show(jpeg(), shown);
    expect(screen.current()).toBeNull();
    expect(seen).toEqual([]);
    expect(shown).not.toHaveBeenCalled();
    await finish(0);
    expect(seen).toEqual(['blob:frame-1']);
    expect(screen.current()).toBe('blob:frame-1');
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it('never abandons a decode, keeps only the newest waiting image, and reports skipped ones', async () => {
    const screen = createScreen();
    const seen: Array<string | null> = [];
    screen.subscribe(source => seen.push(source));
    const first = vi.fn(); const second = vi.fn(); const third = vi.fn();
    screen.show(jpeg(), first);
    screen.show(jpeg(), second);
    screen.show(jpeg(), third);
    // One decode at a time. The second was replaced by the third while waiting.
    expect(decodes).toHaveLength(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(revoked).toEqual(['blob:frame-2']);
    await finish(0);
    expect(seen).toEqual(['blob:frame-1']);
    expect(first).toHaveBeenCalledTimes(1);
    // The newest image decodes next.
    expect(decodes.map(decode => decode.src)).toEqual(['blob:frame-1', 'blob:frame-3']);
    await finish(1);
    expect(seen).toEqual(['blob:frame-1', 'blob:frame-3']);
    expect(third).toHaveBeenCalledTimes(1);
    // The previous image is released only once its replacement is on screen.
    expect(revoked).toEqual(['blob:frame-2', 'blob:frame-1']);
  });

  it('keeps moving on a phone slower than the stream', async () => {
    const screen = createScreen();
    const seen: Array<string | null> = [];
    screen.subscribe(source => seen.push(source));
    screen.show(jpeg());
    for (let round = 0; round < 4; round++) {
      screen.show(jpeg()); screen.show(jpeg());
      await finish(round);
    }
    // Every finished decode reached the screen even though newer images kept arriving.
    expect(seen).toHaveLength(4);
  });

  it('skips an image that fails to decode and still reports it, then carries on', async () => {
    const screen = createScreen();
    const seen: Array<string | null> = [];
    screen.subscribe(source => seen.push(source));
    const broken = vi.fn(); const good = vi.fn();
    screen.show(jpeg(), broken);
    screen.show(jpeg(), good);
    await finish(0, false);
    expect(broken).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
    expect(revoked).toContain('blob:frame-1');
    await finish(1);
    expect(seen).toEqual(['blob:frame-2']);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('drops pending images on clear and never shows them afterwards', async () => {
    const screen = createScreen();
    const seen: Array<string | null> = [];
    screen.subscribe(source => seen.push(source));
    screen.show(jpeg());
    await finish(0);
    const decodingNow = vi.fn(); const waiting = vi.fn();
    screen.show(jpeg(), decodingNow);
    screen.show(jpeg(), waiting);
    screen.clear();
    expect(seen).toEqual(['blob:frame-1', null]);
    expect(waiting).toHaveBeenCalledTimes(1);
    await finish(1);
    expect(seen).toEqual(['blob:frame-1', null]);
    expect(screen.current()).toBeNull();
    expect(decodingNow).toHaveBeenCalledTimes(1);
    expect(revoked).toEqual(expect.arrayContaining(['blob:frame-1', 'blob:frame-2', 'blob:frame-3']));
  });

  it('reads the acknowledgement number a frame carries', () => {
    const header = Buffer.from(JSON.stringify({ type: 'frame', requestId: 'r', url: 'https://example.com/', width: 390, height: 720, seq: 7 }));
    const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
    const bytes = Buffer.concat([length, header, Buffer.from([0xff, 0xd8, 0xff, 0xd9])]);
    const frame = readBinaryFrame(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(frame?.header.seq).toBe(7);
    expect(frame?.image.size).toBe(4);
  });
});
