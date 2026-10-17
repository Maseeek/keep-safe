import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium, type BrowserServer } from 'playwright';
import { browserAvailable, openBrowser, validateTargetUrl } from '../src/browser';
import { openRehearsalBrowser } from '../src/rehearsal-browser';
import { runRehearsal } from '../src/rehearsal';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const installed = await browserAvailable();

async function rehearsal() {
  const session = await openRehearsalBrowser();
  cleanup.push(() => session.close());
  const agent = await chromium.connectOverCDP(session.cdpUrl);
  cleanup.push(() => agent.close());
  const page = agent.contexts().flatMap(context => context.pages()).find(page => page.url() === session.url)!;
  return { session, agent, page, context: page.context() };
}

async function portClosed(raw: string) {
  const url = new URL(raw);
  return new Promise<boolean>(resolve => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    socket.on('connect', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(true));
  });
}

it.skipIf(!installed)('uses only a labeled fixed phrase and resumes the same authenticated session after reload', async () => {
  const { session, page, context } = await rehearsal();
  expect(session.url).toBe('https://practice.keep-safe.invalid/login');
  expect(session.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(await page.locator('input[type=password],input[name]').count()).toBe(0);
  expect(await page.getByText('Do not enter a real username, password or verification code.', { exact: false }).count()).toBe(1);
  await page.getByLabel('Practice phrase').fill('PRACTICE');
  const posted = page.waitForRequest(request => request.url() === session.url && request.method() === 'POST');
  await page.getByRole('button', { name: 'Practice sign-in', exact: true }).click();
  expect((await posted).postData()).toBeNull();
  await session.verify();
  expect(await page.locator('[data-practice-authenticated=true]').count()).toBe(1);
  expect(await page.evaluate(() => document.cookie)).toBe('');
  const cdp = await context.newCDPSession(page);
  const stored = await cdp.send('Network.getCookies', { urls: [session.url] });
  expect(stored.cookies.some(cookie => cookie.name === 'keep_safe_practice' && cookie.httpOnly && cookie.secure && cookie.session)).toBe(true);
  await session.verify();
  expect(await page.locator('[data-practice-authenticated=true]').count()).toBe(1);
  await cdp.send('Network.deleteCookies', { name: 'keep_safe_practice', url: session.url });
  await expect(session.verify()).rejects.toThrow('did not resume an authenticated practice session');
});

it.skipIf(!installed)('rejects the wrong phrase without submitting or setting an authenticated cookie', async () => {
  const { session, page, context } = await rehearsal();
  let posts = 0;
  page.on('request', request => { if (request.method() === 'POST') posts++; });
  await page.getByLabel('Practice phrase').fill('not the practice phrase');
  await page.getByRole('button', { name: 'Practice sign-in', exact: true }).click();
  expect(await page.getByRole('status').textContent()).toContain('Type the fixed phrase PRACTICE');
  expect(page.url()).toBe(session.url);
  expect(posts).toBe(0);
  expect((await context.cookies()).length).toBe(0);
  await expect(session.verify()).rejects.toThrow('did not resume an authenticated practice session');
});

it.skipIf(!installed)('blocks off-origin, local, unexpected-path, unexpected-method and WebSocket traffic', async () => {
  let received = 0;
  const sink = createServer((_request, response) => { received++; response.end(); });
  sink.on('upgrade', (_request, socket) => { received++; socket.destroy(); });
  await new Promise<void>(resolve => sink.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => sink.close(() => resolve())));
  const port = (sink.address() as { port: number }).port;
  const { context, page: practicePage } = await rehearsal();
  for (const target of [`http://127.0.0.1:${port}/private`, 'https://outside.invalid/', 'https://practice.keep-safe.invalid/not-a-practice-path', 'https://practice.keep-safe.invalid/login?unexpected=1']) {
    const page = await context.newPage();
    const response = await page.goto(target, { timeout: 3000 }).catch(() => null);
    if (response) expect(response.status()).toBe(403);
    await page.close();
  }
  // Bypass the fixture's CSP only in this assertion connection to exercise
  // its underlying HTTP/WebSocket interception rather than CSP alone.
  const cdp = await context.newCDPSession(practicePage);
  await cdp.send('Page.setBypassCSP', { enabled: true });
  expect(await practicePage.evaluate(async () => {
    try { await fetch('https://practice.keep-safe.invalid/login', { method: 'PUT' }); return false; }
    catch { return true; }
  })).toBe(true);
  expect(await practicePage.evaluate(target => new Promise<number>(resolve => {
    const socket = new WebSocket(target);
    socket.onclose = event => resolve(event.code);
    socket.onerror = () => resolve(-1);
    setTimeout(() => { socket.close(); resolve(-2); }, 2000);
  }), `ws://127.0.0.1:${port}/socket`)).toBe(1008);
  expect(received).toBe(0);
});

it.skipIf(!installed)('uses an always-deny proxy for HTTP, CONNECT and upgrades without contacting an upstream', async () => {
  let proxy = '';
  const launch = chromium.launchServer.bind(chromium);
  const capture = vi.spyOn(chromium, 'launchServer').mockImplementation(async options => {
    proxy = options!.proxy!.server;
    expect(options!.host).toBe('127.0.0.1');
    expect(options!.args).toContain('--proxy-bypass-list=<-loopback>');
    return launch(options);
  });
  cleanup.push(async () => { capture.mockRestore(); });
  await rehearsal();
  capture.mockRestore();
  const endpoint = new URL(proxy);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest({ host: endpoint.hostname, port: endpoint.port, path: 'http://unresolvable.invalid/private', method: 'GET', agent: false }, response => { response.resume(); resolve(response.statusCode); });
    request.once('error', reject); request.end();
  });
  expect(status).toBe(403);
  for (const request of ['CONNECT unresolvable.invalid:443 HTTP/1.1\r\nHost: unresolvable.invalid\r\n\r\n', 'GET http://unresolvable.invalid/socket HTTP/1.1\r\nHost: unresolvable.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n']) {
    const result = await new Promise<string>((resolve, reject) => {
      let response = '';
      const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) }, () => socket.write(request));
      socket.on('data', chunk => { response += String(chunk); });
      socket.on('end', () => resolve(response)); socket.on('error', reject);
    });
    expect(result).toContain('HTTP/1.1 403 Forbidden');
  }
});

it('preserves the normal managed browser private-network boundary', async () => {
  expect(() => validateTargetUrl('https://127.0.0.1/private')).toThrow('Private network');
  expect(() => validateTargetUrl('http://127.0.0.1/private')).toThrow('Only HTTPS');
  await expect(openBrowser({ url: 'https://127.0.0.1/private', allowLocalUrls: false })).rejects.toThrow('Private network');
});

it('closes its deny proxy and returns a generic error when Chromium startup fails', async () => {
  let proxy = '';
  const failure = vi.spyOn(chromium, 'launchServer').mockImplementation(async options => { proxy = options!.proxy!.server; throw new Error('Private executable path must not appear.'); });
  cleanup.push(async () => { failure.mockRestore(); });
  await expect(openRehearsalBrowser()).rejects.toThrow('The practice browser could not start. Check Chromium availability and try again.');
  expect(proxy).not.toBe('');
  expect(await portClosed(proxy)).toBe(true);
});

it.skipIf(!installed)('closes an already launched browser and its proxy if connection setup fails', async () => {
  let server: BrowserServer | undefined; let proxy = ''; let cdp = '';
  const launch = chromium.launchServer.bind(chromium);
  const capture = vi.spyOn(chromium, 'launchServer').mockImplementation(async options => {
    proxy = options!.proxy!.server;
    cdp = `http://127.0.0.1:${options!.args!.find(argument => argument.startsWith('--remote-debugging-port='))!.split('=')[1]}`;
    server = await launch(options); return server;
  });
  const fail = vi.spyOn(chromium, 'connect').mockRejectedValueOnce(new Error('Private browser endpoint must not appear.'));
  cleanup.push(async () => { capture.mockRestore(); fail.mockRestore(); });
  await expect(openRehearsalBrowser()).rejects.toThrow('The practice browser could not start. Check Chromium availability and try again.');
  expect(server!.process().exitCode !== null || server!.process().signalCode !== null).toBe(true);
  expect(await portClosed(proxy)).toBe(true);
  expect(await portClosed(cdp)).toBe(true);
});

it.skipIf(!installed)('closes its browser and proxy once, with forceful fallback for a stuck graceful close', async () => {
  let server: BrowserServer | undefined; let proxy = '';
  const launch = chromium.launchServer.bind(chromium);
  const capture = vi.spyOn(chromium, 'launchServer').mockImplementation(async options => { proxy = options!.proxy!.server; server = await launch(options); return server; });
  cleanup.push(async () => { capture.mockRestore(); });
  const { session, agent } = await rehearsal();
  capture.mockRestore();
  const hang = vi.spyOn(server!, 'close').mockImplementation(() => new Promise(() => {}));
  const kill = vi.spyOn(server!, 'kill');
  cleanup.push(async () => { hang.mockRestore(); kill.mockRestore(); });
  await Promise.all([session.close(), session.close()]);
  expect(hang).toHaveBeenCalledTimes(1); expect(kill).toHaveBeenCalledTimes(1);
  expect(agent.isConnected()).toBe(false);
  expect(await portClosed(proxy)).toBe(true);
  expect(await portClosed(session.cdpUrl)).toBe(true);
  await expect(session.verify()).rejects.toThrow('did not resume an authenticated practice session');
});

it.skipIf(!installed)('reports unconfirmed startup cleanup instead of inviting an unsafe retry or claiming closure', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'keep-safe-rehearsal-cleanup-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(resolve(directory, 'config.json'), JSON.stringify({ ownerToken: 'c'.repeat(64), agentToken: 'd'.repeat(64), vapid: { publicKey: 'public-fixture', privateKey: 'private-fixture' } }));
  const launch = chromium.launchServer.bind(chromium);
  let actualKill: (() => Promise<void>) | undefined; let proxy = '';
  const restore: Array<() => void> = [];
  cleanup.push(async () => { for (const undo of restore.reverse()) undo(); await actualKill?.(); });
  const capture = vi.spyOn(chromium, 'launchServer').mockImplementation(async options => {
    proxy = options!.proxy!.server;
    const server = await launch(options);
    actualKill = server.kill.bind(server);
    const close = vi.spyOn(server, 'close').mockRejectedValue(new Error('Synthetic close failure.'));
    const kill = vi.spyOn(server, 'kill').mockRejectedValue(new Error('Synthetic kill failure.'));
    const processKill = vi.spyOn(server.process(), 'kill').mockReturnValue(false);
    restore.push(() => close.mockRestore(), () => kill.mockRestore(), () => processKill.mockRestore());
    return server;
  });
  const connect = vi.spyOn(chromium, 'connect').mockRejectedValue(new Error('Synthetic private startup details must not appear.'));
  restore.push(() => capture.mockRestore(), () => connect.mockRestore());
  const logs: string[] = [];
  await expect(runRehearsal({ configDirectory: directory, port: 4318, log: message => logs.push(message) })).rejects.toThrow('Practice browser cleanup could not be confirmed. Stop its Chromium process before retrying.');
  expect(logs.join('\n')).not.toContain('browser is closed');
  expect(logs.join('\n')).not.toContain('Synthetic private');
  expect(await portClosed(proxy)).toBe(true);
});

it.skipIf(!installed)('runs the real Chromium practice flow under the production tsx loader', async () => {
  const source = `
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openRehearsalBrowser } from './packages/bridge/src/rehearsal-browser.ts';
const session = await openRehearsalBrowser();
let agent;
try {
  agent = await chromium.connectOverCDP(session.cdpUrl);
  const page = agent.contexts().flatMap(context => context.pages()).find(page => page.url() === session.url);
  assert(page);
  await page.getByLabel('Practice phrase').fill('PRACTICE');
  await page.getByRole('button', { name: 'Practice sign-in', exact: true }).click();
  await session.verify();
  console.log('practice-runtime-ok');
} finally { await agent?.close(); await session.close(); }
`;
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), '--input-type=module'], { cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  child.stdin.end(source);
  try {
    expect(await exited, stderr.slice(-1000)).toBe(0);
    expect(stdout.trim()).toBe('practice-runtime-ok');
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
