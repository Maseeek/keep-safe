import { createServer } from 'node:http';

export const backgroundFixtureCredentials = { email: 'background-fixture@example.invalid', password: 'synthetic-background-password' } as const;
const cookie = 'keep_safe_background_fixture=authenticated';

/** Public synthetic inputs only. Node drains POST bodies without reading them. */
export async function startBackgroundLoginFixture() {
  let formReadyCount = 0; let loginCount = 0; let readyCount = 0;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
    const path = new URL(request.url || '/', 'http://fixture.invalid').pathname;
    if (request.method === 'POST') {
      request.resume(); request.on('end', () => {
        if (path === '/authenticate') {
          loginCount++; response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `${cookie}; HttpOnly; SameSite=Lax; Path=/` }); response.end('{"signedIn":true}'); return;
        }
        if (path === '/form-ready') formReadyCount++;
        else if (path === '/account-ready') { if (request.headers.cookie?.includes(cookie)) readyCount++; }
        else { response.writeHead(404); response.end(); return; }
        response.writeHead(204); response.end();
      }); return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (path === '/account') {
      if (!request.headers.cookie?.includes(cookie)) { response.writeHead(401); response.end('<h1>Background sign-in required</h1>'); return; }
      response.end('<h1>Background session authenticated</h1>'); return;
    }
    if (path !== '/login') { response.writeHead(404); response.end(); return; }
    response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic background sign-in</title>
      <style>body{font:18px system-ui;background:#f5f4ee;color:#15231e;margin:0;padding:24px}h1{font-size:24px}label,input,button{display:block;box-sizing:border-box;margin:12px 0;width:100%}input,button{font:inherit;padding:12px}button{background:#173d32;color:white;border:0;border-radius:8px}[hidden]{display:none!important}</style>
      <h1>Background pause practice</h1><p>Synthetic local test only. Never enter real credentials.</p>
      <form id="login" novalidate><label for="email">Background email</label><input id="email" type="email" autocomplete="off"><label for="password">Synthetic background password</label><input id="password" type="password" autocomplete="off"><button type="submit">Sign in background fixture</button></form><p id="result" hidden>Synthetic sign-in complete</p>
      <script>const notify=path=>fetch(path,{method:'POST',credentials:'same-origin'});const form=document.querySelector('#login');
      form.addEventListener('submit',async event=>{event.preventDefault();if(document.querySelector('#email').value!==${JSON.stringify(backgroundFixtureCredentials.email)}||document.querySelector('#password').value!==${JSON.stringify(backgroundFixtureCredentials.password)})return;
      const response=await notify('/authenticate');if(!response.ok)return;form.hidden=true;document.querySelector('#result').hidden=false;await notify('/account-ready');});void notify('/form-ready');</script>`);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { origin, loginUrl: origin + '/login', get formReadyCount() { return formReadyCount; }, get loginCount() { return loginCount; }, get readyCount() { return readyCount; },
      close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
  } catch (error) { server.closeAllConnections(); server.close(); throw error; }
}
