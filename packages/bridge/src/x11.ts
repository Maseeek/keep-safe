import { connect, type Socket } from 'node:net';

/** Just enough of the X11 protocol to send input to a private display through
 * the XTEST extension. The browser receives this input exactly as it would
 * from a keyboard and mouse, because the display server generates it. */
export interface X11Input {
  readonly width: number;
  readonly height: number;
  move(x: number, y: number): Promise<void>;
  button(button: number, down: boolean): Promise<void>;
  /** Presses and releases one named key, such as `Return` or `Tab`, with modifiers held. */
  key(keysym: number, modifiers?: number[]): Promise<void>;
  /** Types text character by character as real key presses. Optional `paceMs` adds slight human-like jitter. */
  type(text: string, options?: { paceMs?: number }): Promise<void>;
  /** Waits until the display server has handled everything sent so far. */
  sync(): Promise<void>;
  close(): void;
}

export const keysyms = {
  BackSpace: 0xff08, Tab: 0xff09, Return: 0xff0d, Escape: 0xff1b, Delete: 0xffff,
  Home: 0xff50, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, PageUp: 0xff55, PageDown: 0xff56, End: 0xff57,
  ShiftL: 0xffe1, ControlL: 0xffe3, AltL: 0xffe9, F5: 0xffc2, space: 0x20, a: 0x61, w: 0x77,
} as const;

/** The keysym X uses for a character: Latin-1 directly, anything else by its Unicode code point. */
export function keysymFor(character: string): number {
  if (character === '\n' || character === '\r') return keysyms.Return;
  if (character === '\t') return keysyms.Tab;
  const point = character.codePointAt(0)!;
  return (point >= 0x20 && point <= 0x7e) || (point >= 0xa0 && point <= 0xff) ? point : 0x01000000 + point;
}

const pad = (length: number) => (4 - (length % 4)) % 4;

/** The single entry an Xauthority file needs for a private display: any
 * address, any display number, one MIT-MAGIC-COOKIE-1. */
export function xauthority(cookie: Buffer): Buffer {
  const field = (value: Buffer) => { const length = Buffer.alloc(2); length.writeUInt16BE(value.length); return Buffer.concat([length, value]); };
  const family = Buffer.alloc(2); family.writeUInt16BE(0xffff);
  return Buffer.concat([family, field(Buffer.alloc(0)), field(Buffer.alloc(0)), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)]);
}

export async function connectX11(display: number, cookie: Buffer, timeoutMs = 5000): Promise<X11Input> {
  const socket: Socket = connect(`/tmp/.X11-unix/X${display}`);
  let buffer = Buffer.alloc(0);
  let failure: Error | undefined;
  let setup: ((data: Buffer) => void) | undefined;
  const pending = new Map<number, { resolve: (reply: Buffer) => void; reject: (error: Error) => void }>();
  let sequence = 0;
  const fail = (error: Error) => {
    failure ??= error;
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
  };
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('The private display closed.')));
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (setup) {
      if (buffer.length < 8) return;
      const total = 8 + buffer.readUInt16LE(6) * 4;
      if (buffer.length < total) return;
      const data = buffer.subarray(0, total); buffer = buffer.subarray(total);
      const done = setup; setup = undefined; done(data);
    }
    while (buffer.length >= 32) {
      const kind = buffer[0];
      const total = kind === 1 ? 32 + buffer.readUInt32LE(4) * 4 : 32;
      if (buffer.length < total) return;
      const message = buffer.subarray(0, total); buffer = buffer.subarray(total);
      // Events (anything above 1) are not asked for, apart from mapping changes everyone receives.
      if (kind > 1) continue;
      const number = message.readUInt16LE(2);
      const waiter = pending.get(number);
      if (!waiter) continue;
      pending.delete(number);
      if (kind === 1) waiter.resolve(message);
      else waiter.reject(new Error(`The private display refused a request (error ${message[1]}).`));
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The private display did not answer.')), timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const name = Buffer.from('MIT-MAGIC-COOKIE-1');
  const hello = Buffer.alloc(12 + name.length + pad(name.length) + cookie.length + pad(cookie.length));
  hello.write('l', 0); hello.writeUInt16LE(11, 2); hello.writeUInt16LE(0, 4);
  hello.writeUInt16LE(name.length, 6); hello.writeUInt16LE(cookie.length, 8);
  name.copy(hello, 12); cookie.copy(hello, 12 + name.length + pad(name.length));
  const reply = await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The private display did not answer.')), timeoutMs);
    setup = data => { clearTimeout(timer); resolve(data); };
    socket.write(hello);
  });
  if (reply[0] !== 1) { socket.destroy(); throw new Error('The private display refused the connection.'); }
  const vendorLength = reply.readUInt16LE(24);
  const formats = reply[29];
  const minKeycode = reply[34]; const maxKeycode = reply[35];
  const screen = 40 + vendorLength + pad(vendorLength) + formats * 8;
  const root = reply.readUInt32LE(screen);
  const width = reply.readUInt16LE(screen + 20); const height = reply.readUInt16LE(screen + 22);

  const send = (request: Buffer) => { if (failure) throw failure; sequence = (sequence + 1) & 0xffff; socket.write(request); return sequence; };
  const ask = (request: Buffer) => new Promise<Buffer>((resolve, reject) => {
    try { const number = send(request); pending.set(number, { resolve, reject }); } catch (error) { reject(error as Error); }
  });
  const sync = async () => { const request = Buffer.alloc(4); request[0] = 43; request.writeUInt16LE(1, 2); await ask(request); };

  const extensionName = Buffer.from('XTEST');
  const query = Buffer.alloc(8 + extensionName.length + pad(extensionName.length));
  query[0] = 98; query.writeUInt16LE(query.length / 4, 2); query.writeUInt16LE(extensionName.length, 4); extensionName.copy(query, 8);
  const extension = await ask(query);
  if (!extension[8]) { socket.destroy(); throw new Error('The private display cannot take simulated input.'); }
  const xtest = extension[9];

  const count = maxKeycode - minKeycode + 1;
  const mappingRequest = Buffer.alloc(8); mappingRequest[0] = 101; mappingRequest.writeUInt16LE(2, 2); mappingRequest[4] = minKeycode; mappingRequest[5] = count;
  const mapping = await ask(mappingRequest);
  const perKeycode = mapping[1];
  const table: number[][] = [];
  for (let index = 0; index < count; index++) {
    const row: number[] = [];
    for (let level = 0; level < perKeycode; level++) row.push(mapping.readUInt32LE(32 + (index * perKeycode + level) * 4));
    table.push(row);
  }
  const keycodeOf = (keysym: number) => {
    for (let index = 0; index < count; index++) {
      const level = table[index].slice(0, 2).indexOf(keysym);
      if (level >= 0) return { keycode: minKeycode + index, shift: level === 1 };
    }
    return undefined;
  };
  // Keycodes with nothing on them borrow a character the layout lacks, such as
  // an accented letter, the way xdotool types them.
  const spare = table.map((row, index) => row.every(value => value === 0) ? minKeycode + index : 0).filter(Boolean).slice(-8);
  const borrowed = new Map<number, number>();
  let nextSpare = 0;
  const shiftKey = keycodeOf(keysyms.ShiftL)?.keycode;

  const fake = (type: number, detail: number, x = 0, y = 0) => {
    const request = Buffer.alloc(36);
    request[0] = xtest; request[1] = 2; request.writeUInt16LE(9, 2);
    request[4] = type; request[5] = detail; request.writeUInt32LE(type === 6 ? root : 0, 12);
    request.writeInt16LE(x, 24); request.writeInt16LE(y, 26);
    send(request);
  };
  const keycodeFor = async (keysym: number) => {
    const found = keycodeOf(keysym);
    if (found) return found;
    const known = borrowed.get(keysym);
    if (known) return { keycode: known, shift: false };
    if (!spare.length) return undefined;
    const keycode = spare[nextSpare++ % spare.length];
    for (const [symbol, code] of borrowed) if (code === keycode) borrowed.delete(symbol);
    const change = Buffer.alloc(8 + perKeycode * 4);
    change[0] = 100; change[1] = 1; change.writeUInt16LE(2 + perKeycode, 2); change[4] = keycode; change[5] = perKeycode;
    for (let level = 0; level < perKeycode; level++) change.writeUInt32LE(level < 2 ? keysym : 0, 8 + level * 4);
    send(change);
    await sync();
    // The browser re-reads the layout when told it changed. Give it a moment.
    await new Promise<void>(resolve => { setTimeout(resolve, 40); });
    borrowed.set(keysym, keycode);
    return { keycode, shift: false };
  };
  const press = async (keysym: number, modifiers: number[] = []) => {
    const target = await keycodeFor(keysym);
    if (!target) return;
    const held = [...modifiers.map(modifier => keycodeOf(modifier)?.keycode).filter((code): code is number => !!code), ...(target.shift && shiftKey ? [shiftKey] : [])];
    for (const code of held) fake(2, code);
    fake(2, target.keycode); fake(3, target.keycode);
    for (const code of held.reverse()) fake(3, code);
  };
  return {
    width, height,
    async move(x, y) { fake(6, 0, Math.round(x), Math.round(y)); },
    async button(button, down) { fake(down ? 4 : 5, button); },
    async key(keysym, modifiers) { await press(keysym, modifiers); await sync(); },
    async type(text, options) {
      const chars = [...text];
      const maxDelay = options?.paceMs && chars.length > 0 ? Math.min(options.paceMs, Math.max(4, Math.floor(600 / chars.length))) : 0;
      const minDelay = maxDelay > 0 ? Math.max(2, Math.floor(maxDelay * 0.45)) : 0;
      for (const character of chars) {
        await press(keysymFor(character));
        if (maxDelay > 0) {
          await sync();
          const wait = minDelay + Math.floor(Math.random() * Math.max(1, maxDelay - minDelay + 1));
          await new Promise<void>(resolve => { setTimeout(resolve, wait); });
        }
      }
      await sync();
    },
    sync,
    close() { socket.destroy(); },
  };
}
