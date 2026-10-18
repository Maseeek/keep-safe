import { createServer } from 'node:http';

export const navigationFixtureCredentials = { email: 'navigation-fixture@example.invalid', password: 'synthetic-navigation-password' } as const;
const cookie = 'keep_safe_navigation_fixture=authenticated';

/** Public synthetic inputs only. Node drains POST bodies without reading them. */
export async function startNavigationLoginFixture() {
  let loginViews = 0; let loginCount = 0; let readyCount = 0;
  const style = '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:18px system-ui;background:#f5f4ee;color:#15231e;margin:0;padding:24px}h1{font-size:24px}label,input,button,a{display:block;box-sizing:border-box;margin:12px 0;width:100%}input,button,a{font:inherit;padding:12px}button{background:#173d32;color:white;border:0;border-radius:8px}[hidden]{display:none!important}</style>';
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
    const path = new URL(request.url || '/', 'http://fixture.invalid').pathname;
    if (request.method === 'POST') {
      request.resume(); request.on('end', () => {
        if (path === '/authenticate') { loginCount++; response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `${cookie}; HttpOnly; SameSite=Lax; Path=/` }); response.end('{"signedIn":true}'); return; }
        if (path === '/account-ready' && request.headers.cookie?.includes(cookie)) { readyCount++; response.writeHead(204); response.end(); return; }
        response.writeHead(404); response.end();
      }); return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (path === '/account') {
      if (!request.headers.cookie?.includes(cookie)) { response.writeHead(401); response.end('<h1>Navigation sign-in required</h1>'); return; }
      response.end('<h1>Navigation session authenticated</h1>'); return;
    }
    if (path === '/start') { response.end(`<!doctype html>${style}<h1>Navigation practice</h1><p>Synthetic local test only. Never enter real credentials.</p><a href="/wrong">Wrong sign-in route</a><a href="/login">Practice login</a>`); return; }
    if (path === '/wrong') { response.end(`<!doctype html>${style}<h1>Wrong sign-in route</h1><p>Use Back in the website to return to the login choices.</p>`); return; }
    if (path !== '/login') { response.writeHead(404); response.end(); return; }
    loginViews++;
    if (loginViews === 1) { response.end(`<!doctype html>${style}<h1>Practice login paused</h1><p>Use Reload website to retry this synthetic page.</p>`); return; }
    response.end(`<!doctype html>${style}<title>Synthetic navigation sign-in</title><h1>Navigation login practice</h1><p>Synthetic inputs only.</p>
      <form id="login" novalidate><label for="email">Navigation email</label><input id="email" type="email" autocomplete="off"><label for="password">Synthetic navigation password</label><input id="password" type="password" autocomplete="off"><button type="submit">Sign in navigation fixture</button></form><p id="result" hidden>Synthetic sign-in complete</p>
      <script>const form=document.querySelector('#login');form.addEventListener('submit',async event=>{event.preventDefault();if(document.querySelector('#email').value!==${JSON.stringify(navigationFixtureCredentials.email)}||document.querySelector('#password').value!==${JSON.stringify(navigationFixtureCredentials.password)})return;
      const response=await fetch('/authenticate',{method:'POST',credentials:'same-origin'});if(!response.ok)return;form.hidden=true;document.querySelector('#result').hidden=false;await fetch('/account-ready',{method:'POST',credentials:'same-origin'});});</script>`);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { origin, startUrl: origin + '/start', loginUrl: origin + '/login', get loginViews() { return loginViews; }, get loginCount() { return loginCount; }, get readyCount() { return readyCount; },
      close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
  } catch (error) { server.closeAllConnections(); server.close(); throw error; }
}
