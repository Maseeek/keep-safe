import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import { chromium, type BrowserServer } from 'playwright';

const origin = 'https://practice.keep-safe.invalid';
const cookie = 'keep_safe_practice=complete';
const startupError = 'The practice browser could not start. Check Chromium availability and try again.';
const verificationError = 'The practice browser did not resume an authenticated practice session.';

export class RehearsalCleanupError extends Error {
  constructor() { super('Practice browser cleanup could not be confirmed. Stop its Chromium process before retrying.'); }
}

function documentHtml(content: string, nonce: string, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keep Safe practice</title><style>body{font:18px system-ui;line-height:1.5;background:#f4f4ed;color:#183b30;max-width:34rem;margin:0 auto;padding:28px}h1{font-size:28px}label,input,button{display:block;box-sizing:border-box;width:100%}input,button{font:inherit;padding:14px;border-radius:8px;margin:12px 0}button{background:#183b30;color:white;border:0}small{display:block}#status{min-height:3rem}</style></head><body><small>KEEP SAFE · SYNTHETIC PRACTICE</small>${content}${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
}

async function freePort() {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

/** No upstream sockets or DNS lookups exist in this proxy. */
async function denyProxy() {
  const sockets = new Set<Socket>();
  const server = createHttpServer({ requestTimeout: 2000, headersTimeout: 2000 }, (request, response) => {
    request.on('error', () => {});
    response.on('error', () => {});
    request.resume();
    response.writeHead(403, { Connection: 'close', 'Content-Length': '0' });
    response.end();
  });
  server.maxConnections = 32;
  server.maxHeadersCount = 24;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(2000, () => socket.destroy());
  });
  const refuse = (_request: unknown, socket: Socket) => {
    socket.on('error', () => {});
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  };
  server.on('connect', refuse);
  server.on('upgrade', refuse);
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function settlesWithin(operation: Promise<unknown>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true, () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function closeBrowser(server: BrowserServer) {
  const process = server.process();
  const exited = () => process.exitCode !== null || process.signalCode !== null;
  const waitForExit = async (milliseconds: number) => {
    if (exited()) return true;
    let completed: (() => void) | undefined;
    try {
      return await settlesWithin(new Promise<void>(resolve => { completed = resolve; process.once('exit', completed); }), milliseconds);
    } finally { if (completed) process.off('exit', completed); }
  };
  if (await settlesWithin(server.close(), 2000) && await waitForExit(500)) return;
  // A stuck renderer must not leave the rehearsal's debugging endpoint alive.
  await settlesWithin(server.kill(), 2000);
  if (await waitForExit(500)) return;
  try { process.kill('SIGKILL'); } catch {}
  if (!await waitForExit(1000)) throw new RehearsalCleanupError();
}

export async function openRehearsalBrowser(): Promise<{ url: string; cdpUrl: string; verify(): Promise<void>; close(): Promise<void> }> {
  const proxy = await denyProxy().catch(() => { throw new Error(startupError); });
  let server: BrowserServer | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const close = () => {
    if (!closing) {
      closed = true;
      closing = (async () => {
        try { if (server) await closeBrowser(server); }
        finally { await proxy.close(); }
      })();
    }
    return closing;
  };
  try {
    const port = await freePort();
    server = await chromium.launchServer({
      host: '127.0.0.1', headless: true, timeout: 10_000,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      proxy: { server: proxy.url },
      ...(process.env.KEEP_SAFE_CHROMIUM_PATH ? { executablePath: process.env.KEEP_SAFE_CHROMIUM_PATH } : {}),
      args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    });
    const browser = await chromium.connect(server.wsEndpoint(), { timeout: 5000 });
    const context = await browser.newContext({ viewport: { width: 390, height: 720 }, acceptDownloads: false, serviceWorkers: 'block' });
    context.setDefaultTimeout(3000);
    context.setDefaultNavigationTimeout(5000);
    const nonce = randomBytes(16).toString('base64');
    const headers = {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    };
    // This static page alone reads its phrase. There is no input name, so even
    // the fixed synthetic phrase is absent from form POST bodies.
    const login = documentHtml('<h1>Practice a browser handoff</h1><p>This is an isolated practice page. Do not enter a real username, password or verification code.</p><p>Type <strong>PRACTICE</strong> in the Practice phrase box, then choose Practice sign-in. Return control to your agent after the success page appears.</p><form method="post" action="/login"><label for="practice-phrase">Practice phrase</label><input id="practice-phrase" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" required><button type="submit">Practice sign-in</button><p id="status" role="status" aria-live="polite"></p></form>', nonce, `document.querySelector('form').addEventListener('submit', event => { const phrase = document.getElementById('practice-phrase'); if (phrase.value !== 'PRACTICE') { event.preventDefault(); document.getElementById('status').textContent = 'Type the fixed phrase PRACTICE to continue. Never use a real password.'; return; } phrase.value = ''; });`);
    const account = documentHtml('<h1 data-practice-authenticated="true">Practice sign-in complete</h1><p>This synthetic browser session is authenticated. Return control to your agent to verify that it resumes this same session.</p><p>No real account was used.</p>', nonce);
    const unauthenticated = documentHtml('<h1>Practice sign-in is not complete</h1><p>Complete the fixed-phrase practice form before returning control.</p>', nonce);
    const submitted = documentHtml('<h1>Continuing practice sign-in</h1><p>This is still an isolated synthetic practice session.</p>', nonce, "location.replace('/account');");
    await context.route('**/*', async route => {
      const request = route.request();
      const url = request.url();
      const method = request.method();
      if (url === `${origin}/login` && method === 'GET') await route.fulfill({ status: 200, headers, body: login });
      else if (url === `${origin}/login` && method === 'POST') {
        // Do not inspect body, form content or field values. The page validates
        // only a public practice phrase, not a real authentication challenge.
        // Playwright routes do not intercept a redirect's subsequent request.
        // A new document navigation keeps /account inside the virtual routes.
        await route.fulfill({ status: 200, headers: { ...headers, 'Set-Cookie': `${cookie}; Path=/; HttpOnly; Secure; SameSite=Strict` }, body: submitted });
      } else if (url === `${origin}/account` && method === 'GET') {
        const authenticated = (await request.headerValue('cookie'))?.split(';').some(part => part.trim() === cookie) ?? false;
        await route.fulfill({ status: authenticated ? 200 : 401, headers, body: authenticated ? account : unauthenticated });
      } else await route.abort('blockedbyclient');
    });
    // Routed sockets do not connect to a server unless connectToServer is used.
    await context.routeWebSocket('**/*', socket => socket.close({ code: 1008, reason: 'Practice networking is disabled.' }));
    const page = await context.newPage();
    await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
    return {
      url: `${origin}/login`, cdpUrl: `http://127.0.0.1:${port}`,
      async verify() {
        try {
          if (closed || page.isClosed()) throw new Error(verificationError);
          const deadline = Date.now() + 5000;
          const remaining = () => Math.max(1, deadline - Date.now());
          // Done can arrive just after submit, before its redirect commits.
          // Wait for the real practice response instead of interrupting it.
          await page.waitForURL(`${origin}/account`, { waitUntil: 'domcontentloaded', timeout: remaining() });
          await page.locator('[data-practice-authenticated="true"]').waitFor({ state: 'attached', timeout: remaining() });
          await page.reload({ waitUntil: 'domcontentloaded', timeout: remaining() });
          if (await page.locator('[data-practice-authenticated="true"]').count() !== 1) throw new Error(verificationError);
        } catch { throw new Error(verificationError); }
      },
      close,
    };
  } catch {
    await close();
    throw new Error(startupError);
  }
}
