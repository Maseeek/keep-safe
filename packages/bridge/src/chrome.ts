import { spawn } from 'node:child_process';
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
        const owner = JSON.parse(await readFile(join(path, 'keep-safe-owner.json'), 'utf8')) as { bridge?: unknown; chrome?: unknown };
        if (alive(owner.bridge)) continue;
        if (alive(owner.chrome)) {
          // Only a process that is still that Chrome: a reused process number is left alone.
          const command = await readFile(`/proc/${owner.chrome as number}/cmdline`, 'utf8').catch(() => '');
          if (command.includes(path)) { try { process.kill(owner.chrome as number, 'SIGKILL'); } catch { /* Already gone. */ } await new Promise<void>(resolve => { setTimeout(resolve, 300); }); }
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
  /** Ends Chrome and deletes its temporary profile, cookies included. */
  close(): Promise<void>;
}

/** Starts Chrome as a person would, with a fresh profile in a private
 * temporary folder. No automation switches are passed: the only thing a
 * website can tell is that remote debugging is on (`navigator.webdriver`),
 * which is true and is left alone. */
export async function launchChrome(options: { executable: string; proxyUrl: string; scale: number; width: number; height: number; platform?: NodeJS.Platform }): Promise<ChromeProcess> {
  await (swept ??= sweepStaleProfiles());
  const platform = options.platform ?? process.platform;
  const profile = await mkdtemp(join(tmpdir(), profilePrefix));
  const wait = (milliseconds: number) => new Promise<void>(resolve => { setTimeout(resolve, milliseconds).unref(); });
  // A Chrome helper that is still shutting down can write a cache folder back
  // after the profile was deleted, so deletion is repeated until it holds.
  const remove = async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
      await wait(150);
      if (!await access(profile).then(() => true, () => false)) return;
    }
  };
  try {
    // A throwaway profile never offers to save a password, a card or an address.
    await mkdir(join(profile, 'Default'), { recursive: true, mode: 0o700 });
    await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({
      credentials_enable_service: false, credentials_enable_autosignin: false,
      profile: { password_manager_enabled: false, password_manager_leak_detection: false },
      autofill: { profile_enabled: false, credit_card_enabled: false },
    }), { mode: 0o600 });
  } catch (error) { await remove(); throw error; }
  const child = spawn(options.executable, [
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen',
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
    `--window-size=${Math.max(500, options.width)},${options.height + 140}`,
    'about:blank',
    // Its own process group, so every helper process can be ended with it.
  ], { stdio: 'ignore', windowsHide: false, detached: platform !== 'win32' });
  let exited = false;
  const gone = new Promise<void>(resolve => { child.once('exit', () => { exited = true; resolve(); }); child.once('error', () => { exited = true; resolve(); }); });
  const signal = (name: NodeJS.Signals) => {
    try { if (platform !== 'win32' && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch { /* Already gone. */ }
  };
  const close = async () => {
    if (!exited) {
      signal('SIGTERM');
      await Promise.race([gone, wait(4000)]);
    }
    // Chrome's helpers outlive its main process for a moment. Nothing of this session may keep running.
    signal('SIGKILL');
    if (!exited) await Promise.race([gone, wait(2000)]);
    await remove();
  };
  try {
    await writeFile(join(profile, 'keep-safe-owner.json'), JSON.stringify({ bridge: process.pid, chrome: child.pid }), { mode: 0o600 });
    // Chrome picks a free port itself and writes it here, so no other program can take it first.
    const deadline = Date.now() + 20_000;
    while (!exited && Date.now() < deadline) {
      const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n');
      if (/^\d{2,5}$/.test(port ?? '') && path?.startsWith('/devtools/browser/')) return { port: Number(port), endpoint: `ws://127.0.0.1:${port}${path.trim()}`, close };
      await new Promise<void>(resolve => { setTimeout(resolve, 50); });
    }
    throw new Error('Google Chrome did not start.');
  } catch (error) { await close(); throw error; }
}
