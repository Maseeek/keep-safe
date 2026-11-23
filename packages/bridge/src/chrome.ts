import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Which browser a managed session opens. The owner's installed Google Chrome
 * is an ordinary browser to websites. The bundled Chromium runs hidden and
 * says so in its name, which makes some websites ask for a captcha. */
export type BrowserChoice = { kind: 'chrome'; executable: string } | { kind: 'bundled' };

const profilePrefix = 'keep-safe-chrome-';
const executable = async (path: string | undefined) => { if (!path) return false; try { await access(path, constants.X_OK); return true; } catch { return false; } };

async function findChrome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string | undefined> {
  if (env.KEEP_SAFE_CHROME_PATH) return await executable(env.KEEP_SAFE_CHROME_PATH) ? env.KEEP_SAFE_CHROME_PATH : undefined;
  const candidates = platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : platform === 'win32' ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((root): root is string => !!root).map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    : [...(env.PATH ?? '').split(delimiter).filter(Boolean).flatMap(directory => ['google-chrome-stable', 'google-chrome'].map(name => join(directory, name))), '/opt/google/chrome/chrome'];
  for (const candidate of candidates) if (await executable(candidate)) return candidate;
  return undefined;
}

/** `KEEP_SAFE_BROWSER` is `chrome`, `bundled` or `auto`. Unset means bundled,
 * so nothing that merely imports the bridge opens a window. The `keep-safe`
 * command sets `auto`, which picks Chrome only where that has been verified:
 * Linux with an X11 or XWayland display. */
export async function chooseBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<BrowserChoice> {
  const mode = env.KEEP_SAFE_BROWSER;
  if (mode !== 'chrome' && mode !== 'auto') return { kind: 'bundled' };
  if (mode === 'auto' && (platform !== 'linux' || !env.DISPLAY)) return { kind: 'bundled' };
  if (platform === 'linux' && !env.DISPLAY) return { kind: 'bundled' };
  const found = await findChrome(env, platform);
  return found ? { kind: 'chrome', executable: found } : { kind: 'bundled' };
}

const alive = (pid: unknown) => { if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };

/** A bridge that was killed leaves its Chrome and that Chrome's temporary
 * profile behind. The next bridge closes and removes them. */
export async function sweepStaleProfiles(directory = tmpdir()): Promise<void> {
  {
    let names: string[] = [];
    try { names = await readdir(directory); } catch { return; }
    for (const name of names.filter(item => item.startsWith(profilePrefix))) {
      const path = join(directory, name);
      try {
        const owner = JSON.parse(await readFile(join(path, 'keep-safe-owner.json'), 'utf8')) as { bridge?: unknown; chrome?: unknown; display?: unknown; bus?: unknown };
        if (alive(owner.bridge)) continue;
        // Chrome, then the private display it was shown on and its accessibility bus.
        for (const pid of [owner.chrome, owner.display, owner.bus]) {
          if (!alive(pid)) continue;
          // Only a process that is still that Chrome or display: a reused process number is left alone.
          const command = await readFile(`/proc/${pid as number}/cmdline`, 'utf8').catch(() => '');
          if (command.includes(path)) { try { process.kill(pid as number, 'SIGKILL'); } catch { /* Already gone. */ } await new Promise<void>(resolve => { setTimeout(resolve, 300); }); }
        }
        await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch { /* Not a profile this program wrote, or still starting. */ }
    }
  }
}
/** Once per bridge process is enough: later leftovers belong to this process. */
let swept: Promise<void> | undefined;

export interface ChromeProcess {
  /** Loopback debugging address of this Chrome, read from the file Chrome writes. */
  port: number;
  endpoint: string;
  /** Ends Chrome. Deletes its temporary profile, cookies included, unless the caller supplied the profile. */
  close(): Promise<void>;
}

type Wait = (milliseconds: number) => Promise<void>;
const wait: Wait = milliseconds => new Promise<void>(resolve => { setTimeout(resolve, milliseconds).unref(); });

/** A fresh profile in a private temporary folder. A throwaway profile never
 * offers to save a password, a card or an address, and its downloads stay
 * inside it, so they are deleted with it. */
export async function createProfile(): Promise<string> {
  await (swept ??= sweepStaleProfiles());
  const profile = await mkdtemp(join(tmpdir(), profilePrefix));
  try {
    await mkdir(join(profile, 'Default'), { recursive: true, mode: 0o700 });
    await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({
      credentials_enable_service: false, credentials_enable_autosignin: false,
      profile: { password_manager_enabled: false, password_manager_leak_detection: false },
      autofill: { profile_enabled: false, credit_card_enabled: false },
      download: { default_directory: join(profile, 'Downloads'), prompt_for_download: false },
      // Continue where it left off. Chrome then also keeps cookies that last
      // only for the browsing session, which many sign-ins use, when the
      // owner's Chrome is reopened for the agent.
      session: { restore_on_startup: 1 },
      // The owner signs in to a browser whose own address bar and menus are
      // in reach of the phone. Nothing in it may open the computer's files:
      // no file addresses or browser settings pages, no downloads, printing
      // or extensions. These are the preferences Chrome's policies set.
      // Chrome's own interface, such as the address bar's suggestion popup, is
      // made of pages under top-chrome, which stay allowed.
      policy: { url_blocklist: ['file://*', 'chrome://*', 'chrome-untrusted://*'], url_allowlist: ['chrome://top-chrome'] },
      download_restrictions: 3,
      printing: { enabled: false },
      extensions: { install: { denylist: ['*'] } },
    }), { mode: 0o600 });
    // No file picker, so an upload button cannot reach the computer's files.
    await writeFile(join(profile, 'Local State'), JSON.stringify({ select_file_dialogs: { allowed: false } }), { mode: 0o600 });
    // Chrome opens mail links, folders and other apps with xdg-open. This one opens nothing.
    await mkdir(join(profile, 'bin'), { mode: 0o700 });
    await writeFile(join(profile, 'bin', 'xdg-open'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  } catch (error) { await removeProfile(profile); throw error; }
  return profile;
}

/** A Chrome helper that is still shutting down can write a cache folder back
 * after the profile was deleted, so deletion is repeated until it holds. */
export async function removeProfile(profile: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    await wait(150);
    if (!await access(profile).then(() => true, () => false)) return;
  }
}

/** Records which processes belong to a profile, so a later bridge can end
 * them if this one is killed. */
export async function recordOwner(profile: string, processes: { chrome?: number; display?: number; bus?: number }): Promise<void> {
  const path = join(profile, 'keep-safe-owner.json');
  const previous = await readFile(path, 'utf8').then(text => JSON.parse(text) as Record<string, unknown>, () => ({}));
  await writeFile(path, JSON.stringify({ ...previous, bridge: process.pid, ...processes }), { mode: 0o600 });
}

interface ChromeOptions {
  executable: string; proxyUrl: string; scale: number; width: number; height: number; platform?: NodeJS.Platform;
  /** An existing profile from `createProfile`, kept on close. Without one a new profile is made and deleted on close. */
  profile?: string;
  /** Environment for Chrome, such as a private `DISPLAY`. */
  env?: NodeJS.ProcessEnv;
}

function chromeArgs(options: ChromeOptions, profile: string, platform: NodeJS.Platform) {
  return [
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen',
    '--password-store=basic', '--disable-sync', '--noerrdialogs', '--hide-crash-restore-bubble',
    // The same network boundary as the bundled browser: everything leaves through the checked proxy.
    `--proxy-server=${options.proxyUrl}`, '--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    // Back, Forward and Reload must load documents again so a form is never resent unseen.
    '--disable-features=BackForwardCache',
    // The owner is usually away, with the screen locked or the window covered.
    // The page has to keep painting for the live view. On Linux a hidden
    // window is otherwise held to one frame a second by the display server:
    // Chrome waits for a screen refresh that never comes.
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    ...(platform === 'linux' ? ['--ozone-platform=x11', '--disable-gpu-vsync'] : []),
    // The live view is captured at the window's real pixel density.
    `--force-device-scale-factor=${options.scale}`,
  ];
}

interface Started { child: ChildProcess; exited: () => boolean; waitForExit(milliseconds: number): Promise<boolean>; stop(): Promise<void> }

function spawnChrome(executable: string, args: string[], env: NodeJS.ProcessEnv | undefined, platform: NodeJS.Platform): Started {
  // Its own process group, so every helper process can be ended with it.
  const child = spawn(executable, args, { stdio: 'ignore', windowsHide: false, detached: platform !== 'win32', ...(env ? { env } : {}) });
  let exited = false;
  const gone = new Promise<void>(resolve => { child.once('exit', () => { exited = true; resolve(); }); child.once('error', () => { exited = true; resolve(); }); });
  const signal = (name: NodeJS.Signals) => {
    try { if (platform !== 'win32' && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch { /* Already gone. */ }
  };
  return {
    child, exited: () => exited,
    async waitForExit(milliseconds) { await Promise.race([gone, wait(milliseconds)]); return exited; },
    // To the main process only, so its helper processes can still write.
    // Chrome takes SIGTERM as the computer logging out and skips writing
    // recent changes; a sign-in Chrome closes its windows from the keyboard first.
    async stop() {
      if (!exited) { try { child.kill('SIGTERM'); } catch { /* Already gone. */ } await Promise.race([gone, wait(8000)]); }
      // Chrome's helpers outlive its main process for a moment. Nothing of this session may keep running.
      signal('SIGKILL');
      if (!exited) await Promise.race([gone, wait(2000)]);
    },
  };
}

/** Starts Chrome as a person would, with a fresh profile in a private
 * temporary folder. No automation switches are passed: the only thing a
 * website can tell is that remote debugging is on (`navigator.webdriver`),
 * which is true and is left alone. */
export async function launchChrome(options: ChromeOptions & { restore?: boolean }): Promise<ChromeProcess> {
  const platform = options.platform ?? process.platform;
  const profile = options.profile ?? await createProfile();
  const chrome = spawnChrome(options.executable, [
    ...chromeArgs(options, profile, platform), '--remote-debugging-port=0',
    `--window-size=${Math.max(500, options.width)},${options.height + 140}`,
    // A profile handed over from the owner's sign-in reopens the pages it had.
    ...(options.restore ? ['--restore-last-session'] : ['about:blank']),
  ], options.env, platform);
  // A profile someone else made is theirs to delete.
  const close = async () => { await chrome.stop(); if (!options.profile) await removeProfile(profile); };
  try {
    await rm(join(profile, 'DevToolsActivePort'), { force: true });
    await recordOwner(profile, { chrome: chrome.child.pid });
    // Chrome picks a free port itself and writes it here, so no other program can take it first.
    const deadline = Date.now() + 20_000;
    while (!chrome.exited() && Date.now() < deadline) {
      const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n');
      if (/^\d{2,5}$/.test(port ?? '') && path?.startsWith('/devtools/browser/')) return { port: Number(port), endpoint: `ws://127.0.0.1:${port}${path.trim()}`, close };
      await new Promise<void>(resolve => { setTimeout(resolve, 50); });
    }
    throw new Error('Google Chrome did not start.');
  } catch (error) { await close(); throw error; }
}

/** Chrome for the owner's sign-in: no remote debugging at all, so it is an
 * ordinary browser in every respect, shown on a private display. It keeps the
 * profile when it stops, for `launchChrome` to reopen with debugging on after
 * the owner hands the browser back. */
export async function launchSignInChrome(options: ChromeOptions & { profile: string; url: string; env: NodeJS.ProcessEnv; restore?: boolean; accessibilityBus?: string }): Promise<Pick<Started, 'stop' | 'exited' | 'waitForExit'>> {
  const platform = options.platform ?? process.platform;
  // No other program starts from this Chrome: not through xdg-open, and not
  // through the desktop's message bus, which file managers and portals use.
  const env: NodeJS.ProcessEnv = { ...options.env, PATH: [join(options.profile, 'bin'), options.env.PATH].filter(Boolean).join(delimiter), DBUS_SESSION_BUS_ADDRESS: 'disabled:' };
  delete env.AT_SPI_BUS_ADDRESS;
  // A private accessibility bus tells the bridge when a text field takes
  // focus, so the phone can raise its keyboard. It can start no programs.
  if (options.accessibilityBus) env.AT_SPI_BUS_ADDRESS = options.accessibilityBus;
  const chrome = spawnChrome(options.executable, [
    ...chromeArgs(options, options.profile, platform),
    ...(options.accessibilityBus ? ['--force-renderer-accessibility'] : []),
    // Fills the private screen. Chrome's own toolbar stays, so the owner sees
    // the real address of the page and its tabs.
    '--window-position=0,0', `--window-size=${options.width},${options.height}`,
    options.restore ? '--restore-last-session' : options.url,
  ], env, platform);
  try { await recordOwner(options.profile, { chrome: chrome.child.pid }); }
  catch (error) { await chrome.stop(); throw error; }
  return { stop: chrome.stop, exited: chrome.exited, waitForExit: chrome.waitForExit };
}
