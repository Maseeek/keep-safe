import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { findDesktopTools } from '../src/desktop';
import { createProfile, launchSignInChrome, removeProfile } from '../src/chrome';
import { keysymFor, xauthority } from '../src/x11';
import { openBrowser } from '../src/browser';
import { findAccessibilityTools, focusFrom } from '../src/atspi';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close().catch(() => {}); });
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const exists = (path: string) => stat(path).then(() => true, () => false);
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function programs(names: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'keep-safe-tools-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  for (const name of names) { await writeFile(join(directory, name), '#!/bin/sh\n'); await chmod(join(directory, name), 0o755); }
  return directory;
}

describe('desktop sign-in', () => {
  it('runs on Linux with ffmpeg and a private display server, preferring the hidden one', async () => {
    const all = await programs(['ffmpeg', 'Xvfb', 'Xephyr']);
    expect(await findDesktopTools({ PATH: all, DISPLAY: ':1' }, 'linux')).toMatchObject({ server: { kind: 'xvfb' }, ffmpeg: join(all, 'ffmpeg') });
    const xephyr = await programs(['ffmpeg', 'Xephyr']);
    expect(await findDesktopTools({ PATH: xephyr, DISPLAY: ':1' }, 'linux')).toMatchObject({ server: { kind: 'xephyr', path: join(xephyr, 'Xephyr') } });
    // Xephyr opens its window on the computer's own display.
    expect(await findDesktopTools({ PATH: xephyr }, 'linux')).toBeUndefined();
    expect(await findDesktopTools({ PATH: await programs(['Xvfb']), DISPLAY: ':1' }, 'linux')).toBeUndefined();
    expect(await findDesktopTools({ PATH: all, DISPLAY: ':1', KEEP_SAFE_SIGN_IN: 'debugging' }, 'linux')).toBeUndefined();
    expect(await findDesktopTools({ PATH: all, DISPLAY: ':1' }, 'darwin')).toBeUndefined();
  });

  it('signs in to a Chrome with no debugging that cannot open the computer\'s files or other programs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'keep-safe-standin-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const program = join(directory, 'chrome');
    await writeFile(program, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(directory, 'started.json'))}, JSON.stringify({ args: process.argv.slice(2), path: process.env.PATH, bus: process.env.DBUS_SESSION_BUS_ADDRESS, display: process.env.DISPLAY, accessibility: process.env.AT_SPI_BUS_ADDRESS }));\nsetInterval(() => {}, 1000);\n`);
    await chmod(program, 0o755);
    const profile = await createProfile(); cleanup.push(() => removeProfile(profile));
    // The preferences Chrome's policies set: no file or settings pages, downloads, printing, extensions or file picker.
    expect(JSON.parse(await readFile(join(profile, 'Default', 'Preferences'), 'utf8'))).toMatchObject({
      policy: { url_blocklist: ['file://*', 'chrome://*', 'chrome-untrusted://*'], url_allowlist: ['chrome://top-chrome'] }, download_restrictions: 3, printing: { enabled: false },
      extensions: { install: { denylist: ['*'] } }, session: { restore_on_startup: 1 },
    });
    expect(JSON.parse(await readFile(join(profile, 'Local State'), 'utf8'))).toEqual({ select_file_dialogs: { allowed: false } });
    const chrome = await launchSignInChrome({ executable: program, proxyUrl: 'http://127.0.0.1:45000', scale: 2, width: 500, height: 720, profile, url: 'https://example.com/', env: { PATH: '/usr/bin:/bin', DISPLAY: ':99', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', AT_SPI_BUS_ADDRESS: 'unix:path=/run/user/1000/at-spi/bus' }, platform: 'linux' });
    await expect.poll(() => exists(join(directory, 'started.json'))).toBe(true);
    const started = JSON.parse(await readFile(join(directory, 'started.json'), 'utf8')) as { args: string[]; path: string; bus: string; display: string; accessibility?: string };
    expect(started.args.some(arg => arg.startsWith('--remote-debugging'))).toBe(false);
    expect(started.args).toEqual(expect.arrayContaining([`--user-data-dir=${profile}`, '--proxy-server=http://127.0.0.1:45000', '--window-position=0,0', '--window-size=500,720', 'https://example.com/']));
    expect(started).toMatchObject({ display: ':99', bus: 'disabled:', path: `${join(profile, 'bin')}:/usr/bin:/bin` });
    // No accessibility bus unless the bridge started its own private one.
    expect(started.args).not.toContain('--force-renderer-accessibility');
    expect(started.accessibility).toBeUndefined();
    // Its xdg-open opens nothing.
    expect(await readFile(join(profile, 'bin', 'xdg-open'), 'utf8')).toBe('#!/bin/sh\nexit 1\n');
    await chrome.stop();
    expect(chrome.exited()).toBe(true);
    // The profile stays for the agent's Chrome.
    expect(await exists(profile)).toBe(true);
  });

  it('finds the accessibility programs that report focus, and reads only a field\'s kind', async () => {
    const directory = await programs(['dbus-daemon', 'registryd']);
    expect(await findAccessibilityTools({ PATH: directory, KEEP_SAFE_ATSPI_REGISTRY: join(directory, 'registryd') })).toEqual({ bus: join(directory, 'dbus-daemon'), registry: join(directory, 'registryd') });
    expect(await findAccessibilityTools({ PATH: await programs(['ffmpeg']), KEEP_SAFE_ATSPI_REGISTRY: join(directory, 'registryd') })).toBeUndefined();
    expect(await findAccessibilityTools({ PATH: directory, KEEP_SAFE_ATSPI_REGISTRY: join(directory, 'missing') })).toBeUndefined();
    // AT-SPI states as Chrome 157 reported them for each element.
    expect(focusFrom('entry', { 'text-input-type': 'email', tag: 'input' }, [1191188864, 80])).toEqual({ editable: true, kind: 'email' });
    expect(focusFrom('password text', { 'text-input-type': 'password' }, [1191184768, 64])).toEqual({ editable: true, kind: 'password' });
    expect(focusFrom('section', { tag: 'div' }, [1124211072, 64])).toEqual({ editable: true, kind: 'text' });
    expect(focusFrom('entry', { 'text-input-type': 'number' }, [1191188864, 0])).toEqual({ editable: true, kind: 'numeric' });
    expect(focusFrom('button', { tag: 'button' }, [1124079872, 0])).toEqual({ editable: false });
    expect(focusFrom('document web', { tag: '#document' }, [1124079872, 0])).toEqual({ editable: false });
  });

  it('types any character and writes a display cookie only it can use', () => {
    expect(keysymFor('a')).toBe(0x61);
    expect(keysymFor('é')).toBe(0xe9);
    expect(keysymFor('ł')).toBe(0x01000142);
    expect(keysymFor('€')).toBe(0x010020ac);
    expect(keysymFor('\n')).toBe(0xff0d);
    const cookie = Buffer.alloc(16, 7);
    const file = xauthority(cookie);
    // Any address and display number, one MIT-MAGIC-COOKIE-1.
    expect(file.readUInt16BE(0)).toBe(0xffff);
    expect(file.subarray(2, 6)).toEqual(Buffer.from([0, 0, 0, 0]));
    expect(file.subarray(8, 26).toString()).toBe('MIT-MAGIC-COOKIE-1');
    expect(file.subarray(28)).toEqual(cookie);
  });
});

/** Records what the website saw in its own storage, which the agent's Chrome
 * reads back from the same profile after the handback. */
async function startRecordingSite() {
  const page = `<!doctype html><meta name=viewport content="width=device-width">
<body style="margin:0;font:20px sans-serif">
<input id=secret type=password style="display:block;box-sizing:border-box;width:100%;height:100px">
<input id=username style="display:block;box-sizing:border-box;width:100%;height:100px">
<div style="height:4000px"></div>
<script>
const log = (key, value) => localStorage.setItem(key, JSON.stringify(value));
// Each browser writes under its own name: the agent's Chrome loads this page again.
const phase = navigator.webdriver ? 'agent' : 'owner';
log(phase, true);
secret.addEventListener('input', event => { if (event.isTrusted) log(phase + 'Secret', true); });
username.addEventListener('input', event => { if (event.isTrusted) log(phase + 'Typed', username.value); });
addEventListener('scroll', () => log(phase + 'Scrolled', scrollY));
</script>`;
  const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(page); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function ownProfiles() {
  const found: string[] = [];
  for (const name of (await readdir(tmpdir())).filter(item => item.startsWith('keep-safe-chrome-'))) {
    const owner = await readFile(join(tmpdir(), name, 'keep-safe-owner.json'), 'utf8').then(text => JSON.parse(text) as { bridge?: number; chrome?: number; display?: number }, () => undefined);
    if (owner?.bridge === process.pid) found.push(join(tmpdir(), name));
  }
  return found;
}

const tools = await findDesktopTools();
// Opens a real Chrome on a private display (a window, with Xephyr), so it runs only on request:
// KEEP_SAFE_BROWSER=chrome npx vitest run packages/bridge/test/desktop.test.ts
describe.skipIf(process.env.KEEP_SAFE_BROWSER !== 'chrome' || !tools)('signing in without remote debugging', () => {
  it('takes real input with no automation, then hands the same profile to the agent and leaves nothing behind', async () => {
    const site = await startRecordingSite(); cleanup.push(site.close);
    const session = await openBrowser({ url: site.url, allowLocalUrls: true, viewport: { width: 390, height: 720, scale: 2, touch: true } }); cleanup.push(() => session.close());
    const [profile] = await ownProfiles();
    const owner = JSON.parse(await readFile(join(profile, 'keep-safe-owner.json'), 'utf8')) as { chrome: number; display: number };
    // Nothing for an agent until the owner hands back. Chrome has no debugging port at all.
    expect(session.cdpUrl).toBeUndefined();
    expect(await readFile(`/proc/${owner.chrome}/cmdline`, 'utf8')).not.toContain('--remote-debugging');
    expect(await exists(join(profile, 'DevToolsActivePort'))).toBe(false);
    const frames: Array<{ width: number; height: number; data: string; addressInView?: boolean; gestures?: boolean }> = [];
    const stop = await session.stream!(frame => { frames.push(frame); });
    await expect.poll(() => frames.length, { timeout: 10_000 }).toBeGreaterThan(0);
    // Chrome's window is at least 500 wide, with its own address bar in the picture.
    expect(frames[0]).toMatchObject({ width: 500, height: 720, addressInView: true });
    expect(frames[0].gestures).toBeUndefined();
    const jpeg = Buffer.from(frames[0].data, 'base64'); expect(jpeg.readUInt16BE(jpeg.indexOf(Buffer.from([0xff, 0xc0])) + 7)).toBe(1000);
    await pause(2500);
    // The page starts below Chrome's tab strip and toolbar.
    await session.input({ type: 'click', x: 250, y: 140 });
    await session.input({ type: 'text', text: 'not-a-real-password' });
    await session.input({ type: 'click', x: 250, y: 240 });
    await session.input({ type: 'text', text: 'Zażółć €é A' });
    await session.input({ type: 'key', key: 'Backspace' });
    await session.input({ type: 'scroll', deltaX: 0, deltaY: 500, x: 250, y: 400 });
    await pause(800);
    await stop();
    await session.prepareHandoff!();
    expect(session.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(session.pageUrl).toBe(site.url);
    const agent = await chromium.connectOverCDP(session.cdpUrl!); cleanup.push(() => agent.close());
    const page = agent.contexts().flatMap(context => context.pages()).find(item => item.url() === site.url)!;
    const seen = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(key => [key, JSON.parse(localStorage.getItem(key)!)])));
    // Written during the sign-in, before the handback: an ordinary browser and trusted keystrokes.
    expect(seen).toMatchObject({ owner: true, ownerSecret: true, ownerTyped: 'Zażółć €é ' });
    expect(seen.ownerScrolled).toBeGreaterThan(200);
    // The agent's Chrome reports automation, as it should.
    expect(seen.agent).toBe(true);
    expect(await page.evaluate(() => navigator.webdriver)).toBe(true);
    expect(await page.locator('#secret').inputValue()).toBe('');
    await agent.close();
    await session.close();
    expect(running(owner.display)).toBe(false);
    expect(await exists(profile)).toBe(false);
    await pause(1500);
    expect(await exists(profile)).toBe(false);
  }, 90_000);

  it.skipIf(!tools?.accessibility)('tells the phone which kind of field took focus, and scrolls as far as the finger moved', async () => {
    const page = `<!doctype html><body style="margin:0;font:20px sans-serif">
<input id=email type=email autofocus style="display:block;box-sizing:border-box;width:100%;height:80px">
<input id=secret type=password style="display:block;box-sizing:border-box;width:100%;height:80px">
<button style="display:block;width:100%;height:80px">Next</button>
<p style="height:80px;margin:0">Plain words</p>
<div style="height:6000px"></div>
<script>if (!navigator.webdriver) addEventListener('scroll', () => localStorage.setItem('scrolled', String(scrollY)));</script>`;
    // Recorded in the sign-in Chrome only: in the agent's, autofocus scrolls back to the email box.
    const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(page); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const session = await openBrowser({ url, allowLocalUrls: true, viewport: { width: 390, height: 720, scale: 2, touch: true } }); cleanup.push(() => session.close());
    const [profile] = await ownProfiles();
    const owner = JSON.parse(await readFile(join(profile, 'keep-safe-owner.json'), 'utf8')) as { chrome: number; bus: number };
    expect(await readFile(`/proc/${owner.chrome}/cmdline`, 'utf8')).toContain('--force-renderer-accessibility');
    expect(await readFile(`/proc/${owner.chrome}/cmdline`, 'utf8')).not.toContain('--remote-debugging');
    expect(running(owner.bus)).toBe(true);
    await expect.poll(async () => (await session.frame()).width, { timeout: 10_000 }).toBe(500);
    // Chrome's tab strip and toolbar take the top of the picture; the page starts below them.
    const top = 87;
    // Chrome's accessibility is ready a few seconds after it starts. The email
    // box, like Google's, took focus as the page loaded, before that, so no
    // event announced it, and tapping it again sends none either.
    await expect.poll(() => session.input({ type: 'click', x: 250, y: top + 40 }), { timeout: 15_000, interval: 500 }).toEqual({ editable: true, kind: 'email' });
    expect(await session.input({ type: 'click', x: 250, y: top + 120 })).toEqual({ editable: true, kind: 'password' });
    expect(await session.input({ type: 'click', x: 250, y: top + 200 })).toEqual({ editable: false });
    // A second tap on a field that already has focus raises the keyboard again.
    expect(await session.input({ type: 'click', x: 250, y: top + 40 })).toEqual({ editable: true, kind: 'email' });
    expect(await session.input({ type: 'key', key: 'Tab' })).toEqual({ editable: true, kind: 'password' });
    expect(await session.input({ type: 'click', x: 250, y: top + 280 })).toEqual({ editable: false });
    // A slow swipe arrives as many small moves. Twenty 12 px moves scroll
    // 240 px, two wheel steps, not a whole step for each move.
    for (let move = 0; move < 20; move++) { await session.input({ type: 'scroll', deltaX: 0, deltaY: 12, x: 250, y: 400 }); await pause(50); }
    await pause(1200);
    // A short swipe of most of a step still moves the page.
    await pause(500);
    await session.input({ type: 'scroll', deltaX: 0, deltaY: 70, x: 250, y: 400 });
    await pause(1200);
    // A swipe starts the page once the finger has moved a quarter of a step:
    // 36 px makes one step, where rounding alone would wait for 60.
    await session.input({ type: 'scroll', deltaX: 0, deltaY: 36, x: 250, y: 400 });
    await pause(1200);
    await session.prepareHandoff!();
    // The agent's Chrome is ordinary: no accessibility bus.
    expect(running(owner.bus)).toBe(false);
    const agent = await chromium.connectOverCDP(session.cdpUrl!); cleanup.push(() => agent.close());
    const shown = agent.contexts().flatMap(context => context.pages()).find(item => item.url().startsWith(url))!;
    // Three steps for the slow swipe and the short one, one for the quarter-step start.
    expect(Number(await shown.evaluate(() => localStorage.getItem('scrolled')))).toBe(480);
  }, 90_000);

  it('goes back, forward and reloads with Chrome\'s own keys during sign-in', async () => {
    // Every time a page is shown, even from the back-forward cache, it is noted in order.
    const page = (path: string, link: string) => `<!doctype html><body style="margin:0;font:20px sans-serif">
<a id=next href="${link}" style="display:block;height:200px;background:#cde">${path}</a>
<script>addEventListener('pageshow', () => { const seen = JSON.parse(localStorage.getItem('shown') || '[]'); seen.push((navigator.webdriver ? 'agent:' : '') + location.pathname); localStorage.setItem('shown', JSON.stringify(seen)); });</script>`;
    const server = createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(request.url === '/two' ? page('/two', '/') : page('/', '/two')); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const session = await openBrowser({ url, allowLocalUrls: true, viewport: { width: 390, height: 720, scale: 2, touch: true } }); cleanup.push(() => session.close());
    expect(session.navigate).toBeTypeOf('function');
    expect(await session.frame()).toMatchObject({ navigationAvailable: true, addressInView: true });
    await pause(2500);
    await session.input({ type: 'click', x: 250, y: 160 });
    await pause(1500);
    await session.navigate!('back');
    await pause(1000);
    await session.navigate!('forward');
    await pause(1000);
    await session.navigate!('reload');
    await pause(1500);
    await session.prepareHandoff!();
    const agent = await chromium.connectOverCDP(session.cdpUrl!); cleanup.push(() => agent.close());
    const shown = agent.contexts().flatMap(context => context.pages()).find(item => item.url().startsWith(url))!;
    expect(shown.url()).toBe(`${url}two`);
    expect(await shown.evaluate(() => JSON.parse(localStorage.getItem('shown')!))).toEqual(['/', '/two', '/', '/two', '/two', 'agent:/two']);
  }, 90_000);
});
