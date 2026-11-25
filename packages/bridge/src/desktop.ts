import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { delimiter, join } from 'node:path';
import type { Readable } from 'node:stream';
import { createProfile, launchSignInChrome, recordOwner, removeProfile } from './chrome';
import { connectX11, keysyms, xauthority, type X11Input } from './x11';
import { findAccessibilityTools, startFocusWatch, type AccessibilityTools, type FocusWatch } from './atspi';
import type { BrowserFrame, BrowserSession, FocusState } from './browser';
import type { FormState, FormSubmitValue, NavigationDirection, ViewportRequest } from '../../shared/src/protocol';

/** The programs a desktop sign-in needs. Xvfb keeps the display hidden;
 * Xephyr shows it as a window on the computer's own screen. */
export interface DesktopTools {
  server: { kind: 'xvfb' | 'xephyr'; path: string }; ffmpeg: string;
  /** Lets the phone raise its keyboard when a text field takes focus. Optional. */
  accessibility?: AccessibilityTools;
}

const runnable = async (path: string) => { try { await access(path, constants.X_OK); return true; } catch { return false; } };
async function which(name: string, env: NodeJS.ProcessEnv) {
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) if (await runnable(join(directory, name))) return join(directory, name);
  return undefined;
}

/** Desktop sign-in runs where it has been verified: Linux, with the tools
 * installed. `KEEP_SAFE_SIGN_IN=debugging` turns it off. Xephyr needs the
 * computer's own display to put its window on. */
export async function findDesktopTools(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<DesktopTools | undefined> {
  if (platform !== 'linux' || env.KEEP_SAFE_SIGN_IN === 'debugging') return undefined;
  const ffmpeg = await which('ffmpeg', env);
  if (!ffmpeg) return undefined;
  const accessibility = await findAccessibilityTools(env);
  const extra = accessibility ? { accessibility } : {};
  const xvfb = await which('Xvfb', env);
  if (xvfb) return { server: { kind: 'xvfb', path: xvfb }, ffmpeg, ...extra };
  const xephyr = env.DISPLAY ? await which('Xephyr', env) : undefined;
  return xephyr ? { server: { kind: 'xephyr', path: xephyr }, ffmpeg, ...extra } : undefined;
}

/** Chrome's tabbed window is never narrower than this many pixels. */
const minimumWidth = 500;

interface PrivateDisplay { number: number; cookie: Buffer; env: NodeJS.ProcessEnv; process: ChildProcess; stop(): Promise<void> }

async function startDisplay(tools: DesktopTools, profile: string, width: number, height: number): Promise<PrivateDisplay> {
  const cookie = randomBytes(16);
  const authority = join(profile, 'keep-safe-display-auth');
  await writeFile(authority, xauthority(cookie), { mode: 0o600 });
  const screen = `${width}x${height}`;
  // Only this bridge, holding the cookie, can connect. No network listener.
  const common = ['-displayfd', '3', '-auth', authority, '-nolisten', 'tcp', '-noreset'];
  const args = tools.server.kind === 'xvfb'
    ? [...common, '-screen', '0', `${screen}x24`]
    : [...common, '-screen', screen, '-title', 'Keep Safe sign-in', '-no-host-grab'];
  const child = spawn(tools.server.path, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe'], detached: true });
  let exited = false;
  const gone = new Promise<void>(resolve => { child.once('exit', () => { exited = true; resolve(); }); child.once('error', () => { exited = true; resolve(); }); });
  const stop = async () => {
    if (!exited) { try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* Already gone. */ } }
    await Promise.race([gone, new Promise<void>(resolve => { setTimeout(resolve, 2000).unref(); })]);
    if (!exited) { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already gone. */ } }
  };
  try {
    await recordOwner(profile, { display: child.pid });
    const number = await new Promise<number>((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error('The private display did not start.')), 10_000);
      (child.stdio[3] as Readable).on('data', (chunk: Buffer) => {
        text += chunk.toString();
        const match = /^(\d+)\n/.exec(text);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      void gone.then(() => { clearTimeout(timer); reject(new Error('The private display did not start.')); });
    });
    const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: `:${number}`, XAUTHORITY: authority };
    delete env.WAYLAND_DISPLAY;
    return { number, cookie, env, process: child, stop };
  } catch (error) { await stop(); throw error; }
}

/** Splits ffmpeg's MJPEG output into whole JPEG images. Each search for the
 * end of an image resumes where the last one stopped, instead of rescanning
 * the whole image every time another chunk arrives. */
export function jpegFrames(stream: Readable, onFrame: (image: Buffer) => void) {
  const start = Buffer.from([0xff, 0xd8]); const end = Buffer.from([0xff, 0xd9]);
  let buffer: Buffer = Buffer.alloc(0);
  /** Where the current image starts in `buffer`, once found. */
  let begin = -1;
  /** Bytes already searched for the end marker. */
  let searched = 0;
  stream.on('data', (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (begin < 0) {
        begin = buffer.indexOf(start);
        if (begin < 0) { buffer = buffer.subarray(Math.max(0, buffer.length - 1)); searched = 0; return; }
        searched = begin + 2;
      }
      // Back up one byte: a marker can straddle two chunks.
      const stop = buffer.indexOf(end, Math.max(begin + 2, searched - 1));
      if (stop < 0) {
        if (begin > 0) { buffer = buffer.subarray(begin); searched -= begin; begin = 0; }
        searched = buffer.length;
        return;
      }
      onFrame(Buffer.from(buffer.subarray(begin, stop + 2)));
      buffer = buffer.subarray(stop + 2); begin = -1; searched = 0;
    }
  });
}

export interface DesktopHandoff {
  /** Starts Chrome again on the same profile with debugging on, and returns the
   * ordinary managed session for it, with password fields already cleared. */
  (input: { env: NodeJS.ProcessEnv; profile: string; size: { width: number; height: number; scale: number } }): Promise<BrowserSession>;
}

/** The owner's sign-in runs in a Chrome that has no remote debugging, so
 * websites see an ordinary browser and nothing reports automation. The phone
 * sees it through screen capture of a private display and controls it with
 * real keyboard and mouse input from that display. Handing back closes this
 * Chrome, which writes its cookies to the profile, and opens the same profile
 * again with debugging on for the agent. */
export async function openDesktopSession(input: {
  url: string; viewport?: ViewportRequest; executable: string; proxyUrl: string; tools: DesktopTools; handoff: DesktopHandoff;
}): Promise<BrowserSession> {
  // The phone's density, at most 2: the image stays sharp and a visible
  // Xephyr window stays a reasonable size.
  const scale = Math.min(2, Math.max(1, input.viewport?.scale ?? 1));
  const width = Math.max(minimumWidth, input.viewport?.width ?? 390);
  const height = input.viewport?.height ?? 720;
  const pixels = { width: Math.round(width * scale), height: Math.round(height * scale) };
  const profile = await createProfile();
  let display: PrivateDisplay | undefined;
  let chrome: Awaited<ReturnType<typeof launchSignInChrome>> | undefined;
  let x11: X11Input | undefined;
  let capture: ChildProcess | undefined;
  let focus: FocusWatch | undefined;
  /** Set once the browser has been handed back. */
  let managed: BrowserSession | undefined;
  let closing: Promise<void> | undefined;
  let latest: Buffer | undefined;
  let latestAt = 0;
  const watchers = new Set<(image: Buffer) => void>();
  const stopSignIn = async () => {
    capture?.kill('SIGKILL'); capture = undefined;
    // Close its windows as a person would, with Ctrl+Shift+W, so Chrome exits
    // normally and writes every cookie and the open pages to the profile.
    // A website cannot catch this shortcut. A page that asks before leaving
    // keeps its window open, and Chrome is then stopped below.
    for (let attempt = 0; attempt < 6 && x11 && chrome && !chrome.exited(); attempt++) {
      try { await x11.key(keysyms.w, [keysyms.ControlL, keysyms.ShiftL]); } catch { break; }
      await chrome.waitForExit(1500);
    }
    x11?.close(); x11 = undefined;
    await chrome?.stop(); chrome = undefined;
  };
  const close = () => closing ??= (async () => {
    await stopSignIn();
    await focus?.close(); focus = undefined;
    await managed?.close();
    await display?.stop();
    await removeProfile(profile);
  })();
  const startSignIn = async (restore: boolean) => {
    const screen = display!;
    chrome = await launchSignInChrome({ executable: input.executable, proxyUrl: input.proxyUrl, scale, width, height, profile, env: screen.env, url: input.url, restore, accessibilityBus: focus?.address });
    x11 = await connectX11(screen.number, screen.cookie);
    capture = spawn(input.tools.ffmpeg, [
      // Thirty images a second, each written out the moment it is encoded
      // rather than held in ffmpeg's output buffer until the next one.
      '-loglevel', 'error', '-nostdin', '-fflags', 'nobuffer', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', '30', '-video_size', `${pixels.width}x${pixels.height}`, '-i', screen.env.DISPLAY!,
      '-f', 'image2pipe', '-flush_packets', '1', '-c:v', 'mjpeg', '-pix_fmt', 'yuvj420p', '-q:v', '5', '-',
    ], { stdio: ['ignore', 'pipe', 'ignore'], env: screen.env });
    jpegFrames(capture.stdout!, image => {
      // The screen did not change: nothing new to send.
      if (latest?.equals(image)) return;
      latest = image; latestAt = Date.now();
      for (const watcher of watchers) watcher(image);
    });
  };
  try {
    display = await startDisplay(input.tools, profile, pixels.width, pixels.height);
    // Without it the sign-in still works; the phone shows its Keyboard button instead.
    if (input.tools.accessibility) {
      focus = await startFocusWatch(input.tools.accessibility, join(profile, 'keep-safe-a11y'), display.env);
      if (focus) await recordOwner(profile, { bus: focus.pid, registry: focus.registryPid });
    }
    await startSignIn(false);
  } catch (error) { await close(); throw error; }

  const frameOf = (image: Buffer): BrowserFrame => ({ data: image.toString('base64'), width, height, url: input.url, addressInView: true, navigationAvailable: true });
  const nextImage = (timeoutMs: number) => new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => { watchers.delete(take); if (latest) resolve(latest); else reject(new Error('The browser did not produce an image.')); }, timeoutMs);
    const take = (image: Buffer) => { clearTimeout(timer); watchers.delete(take); resolve(image); };
    watchers.add(take);
  });
  const signIn = () => { if (closing || managed || !x11) throw new Error('This browser page is closed.'); return x11; };
  let held = false;
  const release = async () => { if (held && x11) { held = false; await x11.button(1, false); await x11.sync(); } };
  // One wheel step scrolls Chrome 157 on X by 120 CSS pixels, at any window
  // size or density. Measured on the private display.
  const wheelStep = 120;
  /** Scrolling the phone asked for that has not yet made a whole wheel step.
   * Kept between messages, so a slow swipe scrolls as far as the finger
   * moved instead of a full step for every few pixels. */
  const carry = { x: 0, y: 0, at: 0, direction: { x: 0, y: 0 }, moved: { x: false, y: false } };
  const restart = () => { carry.x = carry.y = 0; carry.moved.x = carry.moved.y = false; };
  /** Set once the owner submits credentials in guided form mode. */
  let formSubmitted = false;
  /** Clicks and keys that can move focus report it, so the phone raises its keyboard for a text field. */
  const focusAfter = async (action: () => Promise<void>, settleMs?: number): Promise<FocusState | undefined> => {
    if (!focus) { await action(); return undefined; }
    return focus.after(action, settleMs);
  };
  const initialCredentialsState = (): FormState => ({
    stage: 'credentials',
    origin: '',
    fields: [{ kind: 'email', label: 'Email or username' }, { kind: 'password', label: 'Password' }],
    canSubmit: true,
  });
  const formFromFocus = (state: FocusState | undefined): FormState => {
    if (!state?.editable) return formSubmitted ? { stage: 'browser', origin: '', fields: [] } : initialCredentialsState();
    if (state.kind === 'password') return { stage: 'credentials', origin: '', fields: [{ kind: 'password', label: 'Password' }], canSubmit: true };
    if (state.kind === 'numeric') return { stage: 'otp', origin: '', fields: [{ kind: 'otp', label: 'Verification code' }], hint: 'Enter the verification code sent to you.', canSubmit: true };
    if (state.kind === 'email' || state.kind === 'text') return initialCredentialsState();
    return formSubmitted ? { stage: 'browser', origin: '', fields: [] } : initialCredentialsState();
  };

  const session: BrowserSession = {
    get cdpUrl() { return managed?.cdpUrl; },
    get pageUrl() { return managed?.pageUrl; },
    async frame() {
      if (managed) return managed.frame();
      signIn();
      // A still screen yields no new image, so a recent one is current.
      const image = latest && Date.now() - latestAt < 5000 ? latest : await nextImage(5000);
      return frameOf(image);
    },
    async still() { return managed?.still ? managed.still() : undefined; },
    async stream(listener) {
      if (managed?.stream) return managed.stream(listener);
      signIn();
      let busy = false; let waiting: Buffer | undefined; let stopped = false;
      const deliver = async (image: Buffer) => {
        if (busy) { waiting = image; return; }
        busy = true;
        try {
          let next: Buffer | undefined = image;
          while (next && !stopped) { waiting = undefined; await Promise.resolve(listener(frameOf(next))).catch(() => {}); next = waiting; }
        } finally { busy = false; }
      };
      const watcher = (image: Buffer) => { void deliver(image); };
      watchers.add(watcher);
      if (latest) void deliver(latest);
      return async () => { stopped = true; watchers.delete(watcher); };
    },
    async input(message) {
      if (managed) return managed.input(message);
      const display = signIn();
      const point = () => [Math.max(0, Math.min(pixels.width - 1, (message.x as number) * scale)), Math.max(0, Math.min(pixels.height - 1, (message.y as number) * scale))] as const;
      if (message.type === 'click') {
        restart();
        return focusAfter(async () => {
          await release();
          await display.move(...point());
          await display.button(1, true); await display.button(1, false);
          await display.sync();
        });
      } else if (message.type === 'scroll') {
        if (typeof message.x === 'number' && typeof message.y === 'number') await display.move(...point());
        // A pause between swipes, or a change of direction, starts afresh.
        const now = Date.now();
        if (now - carry.at > 400) restart();
        carry.at = now;
        // Wheel buttons: 4 up, 5 down, 6 left, 7 right. The first step of a
        // swipe goes once the finger has moved a quarter of a step, so the
        // page answers at once; after that, half a step or more rounds to a
        // whole one. The carry keeps the total as far as the finger moved.
        const steps = (axis: 'x' | 'y', delta: number, less: number, more: number) => {
          const direction = Math.sign(delta);
          if (direction && direction !== carry.direction[axis]) { carry[axis] = 0; carry.moved[axis] = false; carry.direction[axis] = direction; }
          carry[axis] += delta;
          const lead = carry.moved[axis] ? wheelStep / 2 : wheelStep / 4;
          const count = Math.min(40, Math.floor((Math.abs(carry[axis]) + wheelStep - lead) / wheelStep));
          if (count) carry.moved[axis] = true;
          const button = carry[axis] < 0 ? less : more;
          carry[axis] -= Math.sign(carry[axis]) * count * wheelStep;
          // Past the cap, the rest is dropped: a fling never keeps scrolling after the finger stops.
          if (Math.abs(carry[axis]) > wheelStep) carry[axis] = Math.sign(carry[axis]) * wheelStep;
          return Array.from({ length: count }, () => button);
        };
        for (const button of [...steps('y', message.deltaY as number, 4, 5), ...steps('x', message.deltaX as number, 6, 7)]) { await display.button(button, true); await display.button(button, false); }
        await display.sync();
      } else if (message.type === 'text') {
        await display.type(message.text as string);
      } else if (message.type === 'key') {
        const named: Record<string, [number, number[]?]> = {
          Enter: [keysyms.Return], Tab: [keysyms.Tab], 'Shift+Tab': [keysyms.Tab, [keysyms.ShiftL]], Backspace: [keysyms.BackSpace],
          Delete: [keysyms.Delete], Escape: [keysyms.Escape], ArrowUp: [keysyms.Up], ArrowDown: [keysyms.Down], ArrowLeft: [keysyms.Left],
          ArrowRight: [keysyms.Right], Home: [keysyms.Home], End: [keysyms.End], PageUp: [keysyms.PageUp], PageDown: [keysyms.PageDown],
          Space: [keysyms.space], 'ControlOrMeta+A': [keysyms.a, [keysyms.ControlL]],
        };
        const key = named[message.key as string];
        if (!key) throw new Error('Unsupported key.');
        if (['Tab', 'Shift+Tab', 'Enter'].includes(message.key as string)) return focusAfter(() => display.key(key[0], key[1]));
        await display.key(key[0], key[1]);
      } else if (message.type === 'mouse') {
        await display.move(...point());
        if (message.phase === 'down') { held = true; await display.button(1, true); }
        else if (message.phase === 'up' || message.phase === 'cancel') await release();
        await display.sync();
      } else throw new Error('This browser takes taps, scrolling and typing.');
    },
    releasePointers() { if (managed) return managed.releasePointers?.(); return release(); },
    async inspectForm() {
      if (managed?.inspectForm) return managed.inspectForm();
      signIn();
      if (!focus) return formSubmitted ? { stage: 'browser', origin: '', fields: [] } : initialCredentialsState();
      return formFromFocus(await focus.current());
    },
    onFormState(listener) {
      if (managed?.onFormState) return managed.onFormState(listener);
      if (!focus) return () => {};
      return focus.onChange(state => listener(formFromFocus(state)));
    },
    async submitForm(values: FormSubmitValue[]) {
      if (managed?.submitForm) return managed.submitForm(values);
      const display = signIn();
      const watch = focus;
      if (!watch) return { ok: false, message: 'Switch to the live browser to sign in here.', state: { stage: 'browser', origin: '', fields: [] } };
      await release();
      // Give Chrome a moment to finish loading & autofocusing; if still unfocused, click into the page and Tab to the first field.
      let first = await watch.current();
      const waitDeadline = Date.now() + 2000;
      while (!first?.editable && Date.now() < waitDeadline && !closing && !managed) {
        await new Promise<void>(resolve => { setTimeout(resolve, 200); });
        first = await watch.current();
      }
      if (!first?.editable) {
        for (let step = 0; step < 6 && !first?.editable && !closing && !managed; step++) {
          first = await focusAfter(() => display.key(keysyms.Tab), 250);
        }
      }
      if (!first?.editable) {
        formSubmitted = true;
        return { ok: false, message: 'Tap the first field in the live browser, then try again or type there.', state: { stage: 'browser', origin: '', fields: [] } };
      }
      const pick = (...kinds: FormSubmitValue['kind'][]) => values.find(item => kinds.includes(item.kind) && item.value.length > 0)?.value;
      const typeValue = async (value: string) => {
        await display.key(keysyms.a, [keysyms.ControlL]);
        await display.key(keysyms.BackSpace);
        await display.type(value, { paceMs: 24 });
      };
      const typeAndEnter = async (value: string) => {
        await typeValue(value);
        return focusAfter(() => display.key(keysyms.Return), 350);
      };
      const settleAfterSubmit = async (latest: FocusState | undefined) => {
        formSubmitted = true;
        await new Promise<void>(resolve => { setTimeout(resolve, 900); });
        const after = (await watch.current()) ?? latest;
        if (after?.editable && after.kind === 'numeric') return { stage: 'otp' as const, origin: '', fields: [{ kind: 'otp' as const, label: 'Verification code' }], hint: 'Enter the verification code sent to you.', canSubmit: true };
        if (after?.editable && after.kind === 'password') return { stage: 'credentials' as const, origin: '', fields: [{ kind: 'password' as const, label: 'Password' }], canSubmit: true };
        return { stage: 'browser' as const, origin: '', fields: [] };
      };
      if (first.kind === 'password') {
        const password = pick('password');
        if (!password) return { ok: false, message: 'Enter your password first.', state: formFromFocus(first) };
        const next = await typeAndEnter(password);
        return { ok: true, state: await settleAfterSubmit(next) };
      }
      if (first.kind === 'numeric') {
        const code = pick('otp', 'text');
        if (!code) return { ok: false, message: 'Enter the verification code first.', state: formFromFocus(first) };
        const next = await typeAndEnter(code);
        return { ok: true, state: await settleAfterSubmit(next) };
      }
      const user = pick('email', 'username', 'text');
      const password = pick('password');
      if (!user) return { ok: false, message: 'Enter your email or username first.', state: formFromFocus(first) };
      if (!password) {
        const next = await typeAndEnter(user);
        return { ok: true, state: await settleAfterSubmit(next) };
      }
      // Handle both single-step (Username + Tab -> Password, e.g. GitHub) and
      // two-step (Email + Enter -> wait for Password, e.g. Google) sign-ins.
      await typeValue(user);
      let next = await focusAfter(() => display.key(keysyms.Tab));
      if (next?.editable && next.kind === 'password') {
        next = await typeAndEnter(password);
        return { ok: true, state: await settleAfterSubmit(next) };
      }
      // Not a password field on Tab: step back to the username field and submit Step 1.
      await focusAfter(() => display.key(keysyms.Tab, [keysyms.ShiftL]));
      next = await focusAfter(() => display.key(keysyms.Return), 350);
      const deadline = Date.now() + 3500;
      while ((!next?.editable || next.kind !== 'password') && Date.now() < deadline && !closing && !managed) {
        await new Promise<void>(resolve => { setTimeout(resolve, 250); });
        next = await watch.current();
      }
      if (next?.editable && next.kind === 'password') next = await typeAndEnter(password);
      return { ok: true, state: await settleAfterSubmit(next) };
    },
    async navigate(direction: NavigationDirection) {
      if (managed) {
        if (!managed.navigate) throw new Error('Navigation is unavailable.');
        return managed.navigate(direction);
      }
      const display = signIn();
      await release();
      // Chrome's own shortcuts, pressed on the private display's keyboard, so
      // the browser goes back exactly as it would for a person at the computer.
      // Chrome asks before sending a form again, in a dialog the owner sees.
      const shortcut: Record<NavigationDirection, [number, number[]]> = {
        back: [keysyms.Left, [keysyms.AltL]], forward: [keysyms.Right, [keysyms.AltL]], reload: [keysyms.F5, []],
      };
      await display.key(...shortcut[direction]);
      // The next image shows the result; a page that does not move keeps the last one.
      await nextImage(1500).catch(() => {});
    },
    async prepareHandoff() {
      if (managed) return managed.prepareHandoff?.();
      signIn();
      await release();
      // Chrome writes its cookies and open pages to the profile as it closes.
      await stopSignIn();
      if (closing) throw new Error('This browser page is closed.');
      try {
        managed = await input.handoff({ env: display!.env, profile, size: { width, height, scale } });
        if (closing) throw new Error('This browser page is closed.');
        await managed.prepareHandoff?.();
        // The sign-in is over: nothing reports focus any more.
        await focus?.close(); focus = undefined;
      } catch (error) {
        // The owner gets the sign-in browser back, on the pages it had, to try again.
        const failed = managed; managed = undefined;
        await failed?.close().catch(() => {});
        if (!closing) await startSignIn(true).catch(() => close());
        throw error;
      }
    },
    close,
  };
  return session;
}
