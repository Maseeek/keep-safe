import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { delimiter, join } from 'node:path';
import type { Readable } from 'node:stream';
import type { EditableKind } from '../../shared/src/protocol';
import type { FocusState } from './browser';

/** Programs that let the bridge learn which kind of field has focus in a
 * Chrome that has no remote debugging: a message bus and the accessibility
 * registry that Chrome reports to. */
export interface AccessibilityTools { bus: string; registry: string }

const runnable = async (path: string) => { try { await access(path, constants.X_OK); return true; } catch { return false; } };

/** Where distributions install the registry. It is part of at-spi2-core,
 * which desktop Linux installs for screen readers. */
const registryPaths = ['/usr/libexec/at-spi2-registryd', '/usr/lib/at-spi2-core/at-spi2-registryd', '/usr/lib/at-spi2/at-spi2-registryd', '/usr/lib/x86_64-linux-gnu/at-spi2-core/at-spi2-registryd', '/usr/lib/aarch64-linux-gnu/at-spi2-core/at-spi2-registryd'];

export async function findAccessibilityTools(env: NodeJS.ProcessEnv): Promise<AccessibilityTools | undefined> {
  let bus: string | undefined;
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) if (await runnable(join(directory, 'dbus-daemon'))) { bus = join(directory, 'dbus-daemon'); break; }
  if (!bus) return undefined;
  for (const path of env.KEEP_SAFE_ATSPI_REGISTRY ? [env.KEEP_SAFE_ATSPI_REGISTRY] : registryPaths) if (await runnable(path)) return { bus, registry: path };
  return undefined;
}

// ---- Just enough of the D-Bus wire protocol for the accessibility bus. ----

interface Type { code: string; children?: Type[] }

function parseSignature(signature: string): Type[] {
  let index = 0;
  const one = (): Type => {
    const code = signature[index++];
    if (code === 'a') return { code, children: [one()] };
    if (code === '(' || code === '{') {
      const end = code === '(' ? ')' : '}';
      const children: Type[] = [];
      while (signature[index] !== end) { if (index >= signature.length) throw new Error('Bad D-Bus signature.'); children.push(one()); }
      index++;
      return { code, children };
    }
    if (!code || !'ybnqiuxtdsogvh'.includes(code)) throw new Error('Bad D-Bus signature.');
    return { code };
  };
  const types: Type[] = [];
  while (index < signature.length) types.push(one());
  return types;
}

const alignment: Record<string, number> = { y: 1, g: 1, v: 1, b: 4, n: 2, q: 2, i: 4, u: 4, h: 4, s: 4, o: 4, a: 4, x: 8, t: 8, d: 8, '(': 8, '{': 8 };

class Reader {
  constructor(private readonly buffer: Buffer, public offset: number, private readonly little: boolean) {}
  private align(size: number) { this.offset = Math.ceil(this.offset / size) * size; }
  private u32() { const value = this.little ? this.buffer.readUInt32LE(this.offset) : this.buffer.readUInt32BE(this.offset); this.offset += 4; return value; }
  read(type: Type): unknown {
    this.align(alignment[type.code]);
    const { buffer, little } = this;
    switch (type.code) {
      case 'y': return buffer[this.offset++];
      case 'b': return this.u32() !== 0;
      case 'n': { const value = little ? buffer.readInt16LE(this.offset) : buffer.readInt16BE(this.offset); this.offset += 2; return value; }
      case 'q': { const value = little ? buffer.readUInt16LE(this.offset) : buffer.readUInt16BE(this.offset); this.offset += 2; return value; }
      case 'i': { const value = little ? buffer.readInt32LE(this.offset) : buffer.readInt32BE(this.offset); this.offset += 4; return value; }
      case 'u': case 'h': return this.u32();
      case 'x': { const value = little ? buffer.readBigInt64LE(this.offset) : buffer.readBigInt64BE(this.offset); this.offset += 8; return value; }
      case 't': { const value = little ? buffer.readBigUInt64LE(this.offset) : buffer.readBigUInt64BE(this.offset); this.offset += 8; return value; }
      case 'd': { const value = little ? buffer.readDoubleLE(this.offset) : buffer.readDoubleBE(this.offset); this.offset += 8; return value; }
      case 's': case 'o': { const length = this.u32(); const value = buffer.toString('utf8', this.offset, this.offset + length); this.offset += length + 1; return value; }
      case 'g': { const length = buffer[this.offset++]; const value = buffer.toString('utf8', this.offset, this.offset + length); this.offset += length + 1; return value; }
      case 'v': { const [inner] = parseSignature(this.read({ code: 'g' }) as string); return this.read(inner); }
      case 'a': {
        const length = this.u32();
        this.align(alignment[type.children![0].code]);
        const end = this.offset + length;
        const items: unknown[] = [];
        while (this.offset < end) items.push(this.read(type.children![0]));
        return items;
      }
      default: return type.children!.map(child => this.read(child));
    }
  }
}

/** Writes little-endian values for the few signatures this client sends. */
class Writer {
  private parts: Buffer[] = [];
  length = 0;
  private push(part: Buffer) { this.parts.push(part); this.length += part.length; }
  align(size: number) { const padding = (size - (this.length % size)) % size; if (padding) this.push(Buffer.alloc(padding)); }
  write(type: Type, value: unknown) {
    this.align(alignment[type.code]);
    switch (type.code) {
      case 'y': this.push(Buffer.from([value as number])); return;
      case 'u': case 'i': case 'b': { const part = Buffer.alloc(4); if (type.code === 'i') part.writeInt32LE(value as number); else part.writeUInt32LE(type.code === 'b' ? (value ? 1 : 0) : value as number); this.push(part); return; }
      case 's': case 'o': { const text = Buffer.from(value as string); const size = Buffer.alloc(4); size.writeUInt32LE(text.length); this.push(Buffer.concat([size, text, Buffer.alloc(1)])); return; }
      case 'g': { const text = Buffer.from(value as string); this.push(Buffer.concat([Buffer.from([text.length]), text, Buffer.alloc(1)])); return; }
      case 'v': { const [signature, inner] = value as [string, unknown]; this.write({ code: 'g' }, signature); this.write(parseSignature(signature)[0], inner); return; }
      case 'a': {
        const size = Buffer.alloc(4); this.push(size);
        this.align(alignment[type.children![0].code]);
        const start = this.length;
        for (const item of value as unknown[]) this.write(type.children![0], item);
        size.writeUInt32LE(this.length - start);
        return;
      }
      case '(': case '{': type.children!.forEach((child, index) => this.write(child, (value as unknown[])[index])); return;
      default: throw new Error(`Cannot send D-Bus type ${type.code}.`);
    }
  }
  bytes() { return Buffer.concat(this.parts); }
}

interface Message { type: number; serial: number; path?: string; iface?: string; member?: string; error?: string; replyTo?: number; sender?: string; body: unknown[] }

function encode(message: { type: number; serial: number; path?: string; iface?: string; member?: string; destination?: string; signature?: string; body?: unknown[] }) {
  const body = new Writer();
  if (message.signature) parseSignature(message.signature).forEach((type, index) => body.write(type, message.body![index]));
  const fields: Array<[number, [string, unknown]]> = [];
  if (message.path) fields.push([1, ['o', message.path]]);
  if (message.iface) fields.push([2, ['s', message.iface]]);
  if (message.member) fields.push([3, ['s', message.member]]);
  if (message.destination) fields.push([6, ['s', message.destination]]);
  if (message.signature) fields.push([8, ['g', message.signature]]);
  const header = new Writer();
  for (const [code, value] of [[0x6c, 'y'], [message.type, 'y'], [0, 'y'], [1, 'y']] as const) header.write({ code: value }, code);
  header.write({ code: 'u' }, body.length);
  header.write({ code: 'u' }, message.serial);
  header.write(parseSignature('a(yv)')[0], fields);
  header.align(8);
  return Buffer.concat([header.bytes(), body.bytes()]);
}

/** Splits one whole message off the front of the buffer, if it has arrived. */
function decode(buffer: Buffer): { message: Message; size: number } | undefined {
  if (buffer.length < 16) return;
  const little = buffer[0] === 0x6c;
  const read32 = (offset: number) => little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const bodyLength = read32(4);
  const fieldsLength = read32(12);
  const bodyStart = Math.ceil((16 + fieldsLength) / 8) * 8;
  if (buffer.length < bodyStart + bodyLength) return;
  const fields = new Reader(buffer, 12, little).read(parseSignature('a(yv)')[0]) as Array<[number, unknown]>;
  const field = (code: number) => fields.find(([key]) => key === code)?.[1];
  const signature = (field(8) as string | undefined) ?? '';
  const reader = new Reader(buffer.subarray(0, bodyStart + bodyLength), bodyStart, little);
  const body = parseSignature(signature).map(type => reader.read(type));
  return {
    size: bodyStart + bodyLength,
    message: { type: buffer[1], serial: read32(8), path: field(1) as string, iface: field(2) as string, member: field(3) as string, error: field(4) as string, replyTo: field(5) as number, sender: field(7) as string, body },
  };
}

export interface DBusConnection {
  call(destination: string, path: string, iface: string, member: string, signature?: string, body?: unknown[]): Promise<unknown[]>;
  onSignal(listener: (message: Message) => void): void;
  close(): void;
}

export async function connectDBus(socketPath: string, timeoutMs = 3000): Promise<DBusConnection> {
  const socket: Socket = connect(socketPath);
  let buffer = Buffer.alloc(0);
  let authenticated = false;
  let serial = 0;
  let failure: Error | undefined;
  const pending = new Map<number, { resolve: (body: unknown[]) => void; reject: (error: Error) => void }>();
  const listeners = new Set<(message: Message) => void>();
  const fail = (error: Error) => { failure ??= error; for (const waiter of pending.values()) waiter.reject(failure); pending.clear(); };
  let authDone: ((error?: Error) => void) | undefined;
  socket.on('error', error => { fail(error); authDone?.(error); });
  socket.on('close', () => { fail(new Error('The accessibility bus closed.')); authDone?.(new Error('The accessibility bus closed.')); });
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!authenticated) {
      const end = buffer.indexOf('\r\n');
      if (end < 0) return;
      const line = buffer.toString('latin1', 0, end);
      buffer = buffer.subarray(end + 2);
      if (!line.startsWith('OK ')) { authDone?.(new Error('The accessibility bus refused this connection.')); return; }
      authenticated = true;
      socket.write('BEGIN\r\n');
      authDone?.();
    }
    for (;;) {
      let decoded;
      try { decoded = decode(buffer); } catch (error) { fail(error as Error); socket.destroy(); return; }
      if (!decoded) return;
      buffer = buffer.subarray(decoded.size);
      const { message } = decoded;
      if ((message.type === 2 || message.type === 3) && message.replyTo !== undefined) {
        const waiter = pending.get(message.replyTo);
        pending.delete(message.replyTo);
        if (message.type === 2) waiter?.resolve(message.body);
        else waiter?.reject(new Error(message.error ?? 'D-Bus error.'));
      } else if (message.type === 4) for (const listener of listeners) { try { listener(message); } catch { /* A listener's failure stays its own. */ } }
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('The accessibility bus did not answer.')); socket.destroy(); }, timeoutMs);
    authDone = error => { clearTimeout(timer); authDone = undefined; if (error) { reject(error); socket.destroy(); } else resolve(); };
    socket.once('connect', () => {
      // EXTERNAL: the bus checks this process's user from the socket itself.
      const uid = Buffer.from(String(process.getuid?.() ?? 0)).toString('hex');
      socket.write(`\0AUTH EXTERNAL ${uid}\r\n`);
    });
  });
  const connection: DBusConnection = {
    call(destination, path, iface, member, signature, body) {
      if (failure) return Promise.reject(failure);
      const id = ++serial;
      return new Promise<unknown[]>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('The accessibility bus did not answer.')); }, timeoutMs);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        socket.write(encode({ type: 1, serial: id, destination, path, iface, member, signature, body }));
      });
    },
    onSignal(listener) { listeners.add(listener); },
    close() { listeners.clear(); socket.destroy(); },
  };
  await connection.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'Hello');
  return connection;
}

// ---- Focus from Chrome's accessibility tree. ----

/** AT-SPI's EDITABLE state, bit 7 of the first state word. */
const editableBit = 1 << 7;
/** A Collection rule that matches objects in the FOCUSED state (bit 12):
 * states, match all; no attributes, roles or interfaces; not inverted. */
const focusedRule = [[1 << 12, 0], 1, [], 1, [], 1, [], 1, false];
const kinds: Record<string, EditableKind> = { password: 'password', email: 'email', tel: 'tel', url: 'url', search: 'search', number: 'numeric' };

/** What a focused accessible object means for the phone keyboard. Reads the
 * field's role, type and state, never its text. */
export function focusFrom(role: string, attributes: Record<string, string>, states: number[]): FocusState {
  if (!((states[0] ?? 0) & editableBit)) return { editable: false };
  if (role === 'password text') return { editable: true, kind: 'password' };
  return { editable: true, kind: kinds[attributes['text-input-type'] ?? ''] ?? 'text' };
}

export interface FocusWatch {
  /** The bus address the sign-in Chrome reports to. */
  address: string;
  /** The bus process, recorded so a later bridge can end it if this one is killed. */
  pid: number;
  /** The registry process, recorded for the same reason. */
  registryPid: number;
  /** Resolves with the focus after an action: once focus moves, or after
   * `settleMs` with focus unchanged, Chrome is asked which object has focus. */
  after<T>(action: () => Promise<T>, settleMs?: number): Promise<FocusState | undefined>;
  /** Returns the currently focused control's editable kind without performing an action. */
  current(): Promise<FocusState | undefined>;
  /** Subscribes to focus changes as Chrome reports them (e.g. autofocus after page load). */
  onChange(listener: (state: FocusState) => void): () => void;
  close(): Promise<void>;
}

/** Starts a private accessibility bus inside the profile folder. Only this
 * computer user can connect to it, it starts no other programs, and the
 * bridge subscribes to one event: which object has focus. Chrome sends
 * other accessibility events on it too, including text changes, which nothing
 * subscribes to, reads or keeps. */
export async function startFocusWatch(tools: AccessibilityTools, folder: string, env: NodeJS.ProcessEnv): Promise<FocusWatch | undefined> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const socketPath = join(folder, 'bus');
  // Unix socket paths are limited to about a hundred bytes.
  if (Buffer.byteLength(socketPath) > 100) return undefined;
  const config = join(folder, 'bus.conf');
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // No service directories: nothing on this bus can start a program. The bus
  // accepts only the user that started it, the default for EXTERNAL.
  await writeFile(config, `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>keep-safe-accessibility</type><listen>unix:path=${escape(socketPath)}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>
`, { mode: 0o600 });
  const children: ChildProcess[] = [];
  let connection: DBusConnection | undefined;
  const close = async () => {
    connection?.close(); connection = undefined;
    for (const child of children.splice(0).reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const gone = new Promise<void>(resolve => { child.once('exit', () => resolve()); });
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* Already gone. */ }
      await Promise.race([gone, new Promise<void>(resolve => { setTimeout(resolve, 1000).unref(); })]);
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already gone. */ }
    }
  };
  try {
    const quiet = { ...env, DBUS_SESSION_BUS_ADDRESS: 'disabled:' };
    const bus = spawn(tools.bus, ['--config-file', config, '--nofork', '--nopidfile', '--print-address=1'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true, env: quiet });
    children.push(bus);
    const address = await new Promise<string>((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error('The accessibility bus did not start.')), 5000);
      (bus.stdout as Readable).on('data', (chunk: Buffer) => {
        text += chunk.toString();
        const line = text.split('\n')[0];
        if (text.includes('\n') && line.startsWith('unix:')) { clearTimeout(timer); resolve(line.trim()); }
      });
      bus.once('exit', () => { clearTimeout(timer); reject(new Error('The accessibility bus did not start.')); });
      bus.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const registry = spawn(tools.registry, [], { stdio: 'ignore', detached: true, env: { ...quiet, AT_SPI_BUS_ADDRESS: address } });
    children.push(registry);
    registry.once('error', () => {});
    connection = await connectDBus(socketPath);
    const bridge = connection;
    const deadline = Date.now() + 5000;
    while (!(await bridge.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', 's', ['org.a11y.atspi.Registry']))[0]) {
      if (Date.now() > deadline || registry.exitCode !== null) throw new Error('The accessibility registry did not start.');
      await new Promise<void>(resolve => { setTimeout(resolve, 50); });
    }
    await bridge.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'AddMatch', 's', ["type='signal',interface='org.a11y.atspi.Event.Object',member='StateChanged',arg0='focused'"]);
    // Newer registries take the event, its properties and the app; older ones only the event.
    await bridge.call('org.a11y.atspi.Registry', '/org/a11y/atspi/registry', 'org.a11y.atspi.Registry', 'RegisterEvent', 'sass', ['object:state-changed:focused', [], ''])
      .catch(() => bridge.call('org.a11y.atspi.Registry', '/org/a11y/atspi/registry', 'org.a11y.atspi.Registry', 'RegisterEvent', 's', ['object:state-changed:focused']));

    let current: FocusState | undefined;
    /** Counts focus moves, so a slow answer about an older object never wins. */
    let moves = 0;
    const waiters = new Set<() => void>();
    const changeListeners = new Set<(state: FocusState) => void>();
    const describe = async (sender: string, path: string) => {
      const object = (member: string) => bridge.call(sender, path, 'org.a11y.atspi.Accessible', member);
      const [[role], [attributes], [states]] = await Promise.all([object('GetRoleName'), object('GetAttributes'), object('GetState')]);
      return focusFrom(role as string, Object.fromEntries(attributes as Array<[string, string]>), states as number[]);
    };
    /** Asks Chrome which object has focus now. Events alone miss a field that
     * took focus before Chrome's accessibility was ready, such as Google's
     * email box, which has focus as the page loads, and a tap on a field that
     * already has focus sends no event at all. */
    const ask = async (): Promise<FocusState | undefined> => {
      const [apps] = await bridge.call('org.a11y.atspi.Registry', '/org/a11y/atspi/accessible/root', 'org.a11y.atspi.Accessible', 'GetChildren') as [Array<[string, string]>];
      let found: [string, string] | undefined;
      for (const [app, path] of apps) {
        const [matches] = await bridge.call(app, path, 'org.a11y.atspi.Collection', 'GetMatches', '(aiia{ss}iaiiasib)uib', [focusedRule, 1, 8, true]) as [Array<[string, string]>];
        // In tree order, so the last is the innermost: the field, not its window.
        if (matches.length) found = matches[matches.length - 1];
      }
      return found ? describe(...found) : undefined;
    };
    /** One question to Chrome at a time: a slow walk of a huge page is
     * shared by the taps that wait on it instead of stacking up. */
    let asking: Promise<FocusState | undefined> | undefined;
    const askOnce = () => asking ??= ask().catch(() => undefined).finally(() => { asking = undefined; });
    /** Only the newest focus event is looked up, one lookup at a time, so a
     * page that moves focus in a tight loop cannot pile up calls. */
    let latest: { sender: string; path: string; move: number } | undefined;
    let describing = false;
    const lookUp = async () => {
      if (describing) return;
      describing = true;
      try {
        while (latest) {
          const target = latest; latest = undefined;
          const state = await describe(target.sender, target.path).catch(() => undefined);
          if (state && target.move === moves) {
            current = state;
            for (const waiter of waiters) waiter();
            for (const listener of [...changeListeners]) { try { listener(state); } catch { /* Ignore listener errors. */ } }
          }
        }
      } finally { describing = false; }
    };
    bridge.onSignal(message => {
      if (message.member !== 'StateChanged' || message.body[0] !== 'focused' || message.body[1] !== 1 || !message.sender || !message.path) return;
      latest = { sender: message.sender, path: message.path, move: ++moves };
      void lookUp();
    });
    return {
      address,
      pid: bus.pid!,
      registryPid: registry.pid!,
      async after(action, settleMs = 200) {
        const before = moves;
        let waiter: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let heard = false;
        const moved = new Promise<void>(resolve => {
          waiter = () => { if (moves !== before) { heard = true; resolve(); } };
          waiters.add(waiter);
        });
        try {
          await action();
          await Promise.race([moved, new Promise<void>(resolve => { timer = setTimeout(resolve, settleMs); timer.unref(); })]);
        } finally { waiters.delete(waiter!); clearTimeout(timer); }
        // Focus moved and was looked up: that is the answer.
        if (heard) return current;
        // No event: ask Chrome, but never hold the phone's input for long. On
        // a page with tens of thousands of elements the walk can take seconds.
        const start = moves;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const now = await Promise.race([askOnce(), new Promise<undefined>(resolve => { deadline = setTimeout(() => resolve(undefined), 250); deadline.unref(); })]);
        clearTimeout(deadline);
        if (!now) return current;
        if (moves === start) current = now;
        return now;
      },
      async current() {
        const start = moves;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const now = await Promise.race([askOnce(), new Promise<undefined>(resolve => { deadline = setTimeout(() => resolve(undefined), 250); deadline.unref(); })]);
        clearTimeout(deadline);
        if (!now) return current;
        if (moves === start) current = now;
        return now;
      },
      onChange(listener) { changeListeners.add(listener); return () => { changeListeners.delete(listener); }; },
      close,
    };
  } catch { await close(); return undefined; }
}
