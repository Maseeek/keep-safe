import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { chooseBrowser, launchChrome, sweepStaleProfiles } from '../src/chrome';
import { openBrowser } from '../src/browser';
import { startGestureFixture } from '../../../tests/fixtures/gesture-site';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close().catch(() => {}); });
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Chrome profiles that sessions in this test process have open. Other test files may be running their own. */
async function ownProfiles() {
  const found: string[] = [];
  for (const name of (await readdir(tmpdir())).filter(item => item.startsWith('keep-safe-chrome-'))) {
    const owner = await readFile(join(tmpdir(), name, 'keep-safe-owner.json'), 'utf8').then(text => JSON.parse(text) as { bridge?: number }, () => undefined);
    if (owner?.bridge === process.pid) found.push(join(tmpdir(), name));
  }
  return found;
}
const exists = (path: string) => stat(path).then(() => true, () => false);

/** A program that behaves like Chrome's start-up as far as the launcher can
 * tell: it records its arguments, writes the debugging port file and waits. */
async function standIn() {
  const directory = await mkdtemp(join(tmpdir(), 'keep-safe-standin-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const program = join(directory, 'chrome');
  await writeFile(program, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const profile = process.argv.find(arg => arg.startsWith('--user-data-dir=')).slice(16);
fs.writeFileSync(${JSON.stringify(join(directory, 'started.json'))}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));
if (!process.argv.includes('--never-ready')) fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '45123\\n/devtools/browser/00000000-0000-4000-8000-000000000000\\n');
setInterval(() => {}, 1000);
`);
  await chmod(program, 0o755);
  return { program, started: async () => JSON.parse(await readFile(join(directory, 'started.json'), 'utf8')) as { pid: number; args: string[] } };
}

describe('choosing the managed browser', () => {
  it('opens a window only when asked, and Chrome only where it is known to work', async () => {
    const chrome = (await standIn()).program;
    const env = (values: Record<string, string>) => ({ KEEP_SAFE_CHROME_PATH: chrome, ...values });
    // Importing the bridge, or running its tests, never opens a window.
    expect(await chooseBrowser(env({ DISPLAY: ':1' }), 'linux')).toEqual({ kind: 'bundled' });
    expect(await chooseBrowser(env({ KEEP_SAFE_BROWSER: 'bundled', DISPLAY: ':1' }), 'linux')).toEqual({ kind: 'bundled' });
    expect(await chooseBrowser(env({ KEEP_SAFE_BROWSER: 'nonsense', DISPLAY: ':1' }), 'linux')).toEqual({ kind: 'bundled' });
    // The keep-safe command asks for `auto`.
    expect(await chooseBrowser(env({ KEEP_SAFE_BROWSER: 'auto', DISPLAY: ':1' }), 'linux')).toEqual({ kind: 'chrome', executable: chrome });
    // No display to show a window on: a server, or a service started outside the desktop session.
    expect(await chooseBrowser(env({ KEEP_SAFE_BROWSER: 'auto' }), 'linux')).toEqual({ kind: 'bundled' });
    expect(await chooseBrowser(env({ KEEP_SAFE_BROWSER: 'chrome' }), 'linux')).toEqual({ kind: 'bundled' });
    expect(await chooseBrowser(env({ KEEP_SAFE_BROWSER: 'auto', WAYLAND_DISPLAY: 'wayland-1' }), 'linux')).toEqual({ kind: 'bundled' });
    // Unverified systems keep the hidden browser unless the owner chooses Chrome.
    expect(await chooseBrowser(env({ KEEP_SAFE_BROWSER: 'auto' }), 'darwin')).toEqual({ kind: 'bundled' });
    expect(await chooseBrowser(env({ KEEP_SAFE_BROWSER: 'auto' }), 'win32')).toEqual({ kind: 'bundled' });
    expect(await chooseBrowser(env({ KEEP_SAFE_BROWSER: 'chrome' }), 'darwin')).toEqual({ kind: 'chrome', executable: chrome });
    // A path that is not a program falls back instead of failing the sign-in.
    expect(await chooseBrowser({ KEEP_SAFE_BROWSER: 'auto', DISPLAY: ':1', KEEP_SAFE_CHROME_PATH: join(tmpdir(), 'no-such-chrome') }, 'linux')).toEqual({ kind: 'bundled' });
    expect(await chooseBrowser({ KEEP_SAFE_BROWSER: 'auto', DISPLAY: ':1', PATH: '' }, 'linux')).toMatchObject({ kind: expect.stringMatching(/^(bundled|chrome)$/) });
  });
});

describe('starting Chrome', () => {
  it('uses a private throwaway profile, the checked proxy and no automation switches, then removes everything', async () => {
    const fake = await standIn();
    const chrome = await launchChrome({ executable: fake.program, proxyUrl: 'http://127.0.0.1:45000', scale: 2, width: 390, height: 720, platform: 'linux' });
    const { pid, args } = await fake.started();
    expect(chrome).toMatchObject({ port: 45123, endpoint: 'ws://127.0.0.1:45123/devtools/browser/00000000-0000-4000-8000-000000000000' });
    const profile = args.find(arg => arg.startsWith('--user-data-dir='))!.slice(16);
    expect(profile.startsWith(join(tmpdir(), 'keep-safe-chrome-'))).toBe(true);
    // Readable by the owner only.
    expect((await stat(profile)).mode & 0o077).toBe(0);
    expect((await stat(join(profile, 'Default', 'Preferences'))).mode & 0o077).toBe(0);
    // Chrome never offers to keep a password, a card or an address from a sign-in.
    expect(JSON.parse(await readFile(join(profile, 'Default', 'Preferences'), 'utf8'))).toMatchObject({ credentials_enable_service: false, profile: { password_manager_enabled: false }, autofill: { profile_enabled: false, credit_card_enabled: false } });
    expect(JSON.parse(await readFile(join(profile, 'keep-safe-owner.json'), 'utf8'))).toEqual({ bridge: process.pid, chrome: pid });
    // Chrome chooses its own loopback port, and all traffic leaves through the checked proxy.
    expect(args).toContain('--remote-debugging-port=0');
    expect(args.some(arg => arg.startsWith('--remote-debugging-address'))).toBe(false);
    expect(args).toEqual(expect.arrayContaining(['--proxy-server=http://127.0.0.1:45000', '--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']));
    // Keeps painting while its window is hidden or the screen is locked.
    expect(args).toEqual(expect.arrayContaining(['--ozone-platform=x11', '--disable-gpu-vsync', '--disable-backgrounding-occluded-windows', '--force-device-scale-factor=2']));
    // An ordinary Chrome: nothing that marks it as automated, hides that it is controlled, or hides its window.
    for (const marker of ['--enable-automation', '--headless', '--disable-blink-features', '--user-agent', '--incognito', '--no-sandbox']) expect(args.some(arg => arg.startsWith(marker))).toBe(false);
    expect(running(pid)).toBe(true);
    await chrome.close();
    expect(running(pid)).toBe(false);
    await expect(stat(profile)).rejects.toMatchObject({ code: 'ENOENT' });
    // Other systems are not forced onto X11.
    const mac = await launchChrome({ executable: fake.program, proxyUrl: 'http://127.0.0.1:45000', scale: 1, width: 1280, height: 800, platform: 'darwin' });
    const second = await fake.started();
    expect(second.args.some(arg => arg.startsWith('--ozone-platform'))).toBe(false);
    expect(second.args).toContain('--window-size=1280,940');
    await mac.close();
  });

  it('gives up cleanly on a Chrome that never becomes ready, or is not there', async () => {
    await expect(launchChrome({ executable: join(tmpdir(), 'no-such-chrome'), proxyUrl: 'http://127.0.0.1:45000', scale: 1, width: 390, height: 720 })).rejects.toThrow('Google Chrome did not start.');
    // Nothing is left behind.
    expect(await ownProfiles()).toEqual([]);
  });

  it('closes and removes what a killed bridge left behind, and nothing else', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'keep-safe-sweep-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
    // A bridge that no longer exists. Its Chrome is still running with a profile full of cookies.
    const gone = spawn(process.execPath, ['-e', '0']); await new Promise(resolve => gone.once('exit', resolve));
    const orphanProfile = join(directory, 'keep-safe-chrome-orphan'); await mkdir(orphanProfile);
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', `--user-data-dir=${orphanProfile}`], { stdio: 'ignore' }); cleanup.push(async () => { orphan.kill('SIGKILL'); });
    await writeFile(join(orphanProfile, 'keep-safe-owner.json'), JSON.stringify({ bridge: gone.pid, chrome: orphan.pid }));
    await writeFile(join(orphanProfile, 'Cookies'), 'synthetic');
    // A profile whose bridge is alive (this process) is in use.
    const live = join(directory, 'keep-safe-chrome-live'); await mkdir(live);
    await writeFile(join(live, 'keep-safe-owner.json'), JSON.stringify({ bridge: process.pid, chrome: process.pid }));
    // A dead bridge whose recorded Chrome number now belongs to an unrelated program: remove the folder, leave the program.
    const reusedProfile = join(directory, 'keep-safe-chrome-reused'); await mkdir(reusedProfile);
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); cleanup.push(async () => { unrelated.kill('SIGKILL'); });
    await writeFile(join(reusedProfile, 'keep-safe-owner.json'), JSON.stringify({ bridge: gone.pid, chrome: unrelated.pid }));
    // Folders this program did not write are never touched.
    const foreign = join(directory, 'keep-safe-chrome-foreign'); await mkdir(foreign); await writeFile(join(foreign, 'notes.txt'), 'keep');
    const other = join(directory, 'someone-else'); await mkdir(other);
    await pause(200);
    await sweepStaleProfiles(directory);
    await expect.poll(() => running(orphan.pid!)).toBe(false);
    expect((await readdir(directory)).sort()).toEqual(['keep-safe-chrome-foreign', 'keep-safe-chrome-live', 'someone-else']);
    expect(running(unrelated.pid!)).toBe(true);
  });
});

// Opens real windows, so it runs only on request: KEEP_SAFE_BROWSER=chrome npx vitest run packages/bridge/test/chrome.test.ts
describe.skipIf(process.env.KEEP_SAFE_BROWSER !== 'chrome')('the installed Google Chrome', () => {
  // The Chrome that the agent drives, with debugging on. desktop.test.ts covers the owner's sign-in without it.
  beforeAll(() => { process.env.KEEP_SAFE_SIGN_IN = 'debugging'; });
  afterAll(() => { delete process.env.KEEP_SAFE_SIGN_IN; });
  it('looks like an ordinary browser, stays live and leaves nothing behind', async () => {
    const site = await startGestureFixture(); cleanup.push(site.close);
    const session = await openBrowser({ url: site.url, allowLocalUrls: true, viewport: { width: 390, height: 720, scale: 2, touch: true } }); cleanup.push(() => session.close());
    const [profile] = await ownProfiles();
    expect(profile).toBeDefined();
    const frames: Array<{ width: number; height: number; data: string }> = [];
    const stop = await session.stream!(frame => { frames.push(frame); });
    await expect.poll(() => frames.length).toBeGreaterThan(0);
    expect(frames[0]).toMatchObject({ width: 390, height: 720, gestures: true, navigationAvailable: true });
    const jpeg = Buffer.from(frames[0].data, 'base64'); expect(jpeg.readUInt16BE(jpeg.indexOf(Buffer.from([0xff, 0xc0])) + 7)).toBe(780);
    // A real finger drag, as the website sees it.
    await session.input({ type: 'touch', phase: 'start', x: 48, y: 138 });
    for (let step = 1; step <= 20; step++) { await session.input({ type: 'touch', phase: 'move', x: 48 + step * 13, y: 138 }); await pause(16); }
    await pause(120); await session.input({ type: 'touch', phase: 'end', x: 308, y: 138 });
    await expect.poll(() => site.count('puzzle-solved')).toBe(1);
    await stop();
    await session.prepareHandoff!();
    const agent = await chromium.connectOverCDP(session.cdpUrl!); cleanup.push(() => agent.close());
    const page = agent.contexts().flatMap(context => context.pages()).find(item => item.url() === site.url)!;
    const seen = await page.evaluate(() => ({ agent: navigator.userAgent, plugins: navigator.plugins.length, chrome: typeof (window as unknown as { chrome?: unknown }).chrome, width: innerWidth, height: innerHeight, ratio: devicePixelRatio, screen: screen.width, focused: document.hasFocus(), visible: document.visibilityState }));
    expect(seen.agent).toMatch(/ Chrome\/\d+/); expect(seen.agent).not.toContain('Headless');
    expect(seen).toMatchObject({ chrome: 'object', width: 390, height: 720, ratio: 2, visible: 'visible' });
    expect(seen.plugins).toBeGreaterThan(0);
    // The screen is the computer's own, not a phone-sized one.
    expect(seen.screen).toBeGreaterThan(390);
    await agent.close(); await session.close();
    // Gone, and still gone after Chrome's helper processes have had time to write anything back.
    expect(await exists(profile)).toBe(false);
    await pause(1500);
    expect(await exists(profile)).toBe(false);
  }, 60000);

  it('ends Chrome and removes its profile when the page cannot be opened', async () => {
    expect(await ownProfiles()).toEqual([]);
    let opened: string[] = [];
    const watching = setInterval(() => { void ownProfiles().then(found => { if (found.length) opened = found; }); }, 20);
    await expect(openBrowser({ url: 'http://127.0.0.1:9/unreachable', allowLocalUrls: true })).rejects.toThrow();
    clearInterval(watching);
    // Chrome did start for this attempt, and all of it is gone again.
    expect(opened.length).toBe(1);
    expect(await exists(opened[0])).toBe(false);
    await pause(1500);
    expect(await exists(opened[0])).toBe(false);
  }, 60000);
});
