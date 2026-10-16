import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Local-only test fixture. It accepts synthetic input and never stores or logs it. */
export async function startLoginFixture() {
  let loginCount = 0;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'POST' && req.url === '/login') {
      req.resume();
      req.on('end', () => {
        loginCount++;
        res.writeHead(303, { Location: '/account', 'Set-Cookie': 'keep_safe_fixture=authenticated; HttpOnly; SameSite=Lax; Path=/' });
        res.end();
      });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/account' && req.headers.cookie?.includes('keep_safe_fixture=authenticated')) {
      res.end('<!doctype html><html><head><title>Fixture account</title></head><body><h1>Signed in successfully</h1><p data-testid="authenticated">The agent can resume in this browser.</p></body></html>');
      return;
    }
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keep Safe test sign-in</title><style>body{font:18px system-ui;background:#f5f4ee;margin:0;padding:36px;color:#15231e}label,input,button{display:block;margin:16px 0;width:100%;box-sizing:border-box}input,button{padding:14px;font:inherit}button{background:#173d32;color:white;border:0;border-radius:8px}</style></head><body><h1>Test workspace</h1><p>This local test form is not a real service.</p><form method="post" action="/login"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="off" required><label for="password">Synthetic password</label><input id="password" name="password" type="password" autocomplete="off" required><button type="submit">Sign in</button></form></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, get loginCount() { return loginCount; }, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
