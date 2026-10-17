import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const formPath = '/private-embedded-form?frame_hint=synthetic-query-only#synthetic-fragment-only';
const cookie = 'keep_safe_frame_fixture=authenticated';
const close = (server: Server) => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); });
const listen = async (server: Server) => {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

/** Local synthetic site. All submitted bodies are drained, never parsed or logged.
 * Different loopback ports give a real cross-origin, same-site cookie flow.
 */
export async function startFrameLoginFixture({ crossOrigin = false }: { crossOrigin?: boolean } = {}) {
  let loginCount = 0; let readyCount = 0; let formReadyCount = 0; let frameOrigin = '';
  const handler: RequestListener = (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const path = new URL(request.url || '/', 'http://fixture.invalid').pathname;
    if (request.method === 'POST') {
      request.resume();
      request.on('end', () => {
        if (path === '/authenticate-frame') {
          loginCount++;
          response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `${cookie}; HttpOnly; SameSite=Lax; Path=/` });
          response.end('{"signedIn":true}');
        } else if (path === '/form-ready') {
          formReadyCount++;
          response.writeHead(204); response.end();
        } else if (path === '/frame-ready') {
          if (request.headers.cookie?.includes(cookie)) readyCount++;
          response.writeHead(204); response.end();
        } else { response.writeHead(404); response.end(); }
      });
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (path === '/frame-account') {
      if (!request.headers.cookie?.includes(cookie)) { response.writeHead(401); response.end('<h1>Frame sign-in required</h1>'); return; }
      response.end('<h1>Embedded session authenticated</h1><p>Synthetic local cookie continuity verified.</p>'); return;
    }
    if (path === '/private-embedded-form') {
      if (request.headers.cookie?.includes(cookie)) { response.writeHead(303, { Location: '/frame-account' }); response.end(); return; }
      response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic embedded sign-in</title>
        <style>body{font:17px system-ui;background:#fff;color:#15231e;margin:0;padding:16px}label,input,button{display:block;margin:10px 0;width:100%;box-sizing:border-box}input,button{padding:12px;font:inherit}button{background:#173d32;color:#fff;border:0;border-radius:8px}[hidden]{display:none}</style></head>
        <body><h2>Embedded test form</h2><form method="post" action="/authenticate-frame"><label for="email">Embedded email</label><input id="email" name="email" type="email" autocomplete="off" required><label for="password">Synthetic embedded password</label><input id="password" name="password" type="password" autocomplete="off" required><button type="submit">Sign in embedded page</button></form><p id="result" hidden>Embedded sign-in complete</p><a href="/private-help?token=synthetic-link-only">Embedded help</a>
        <script>const form=document.querySelector('form');form.addEventListener('submit',async event=>{event.preventDefault();const response=await fetch('/authenticate-frame',{method:'POST',body:new FormData(form),credentials:'same-origin'});if(!response.ok)return;form.hidden=true;document.querySelector('#result').hidden=false;await fetch('/frame-ready',{method:'POST',credentials:'same-origin'});});void fetch('/form-ready',{method:'POST',credentials:'same-origin'});</script></body></html>`);
      return;
    }
    if (path !== '/workspace') { response.writeHead(404); response.end('<h1>Fixture page not found</h1>'); return; }
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Embedded login workspace</title><style>body{font:17px system-ui;background:#f5f4ee;color:#15231e;margin:0;padding:16px}h1{font-size:24px}iframe{display:block;width:100%;height:420px;border:1px solid #ccd9c5;background:white;box-sizing:border-box}button{padding:12px;font:inherit;margin-top:12px}</style></head><body><h1>Frame test workspace</h1><p>Synthetic local test only. Never enter real credentials.</p><iframe title="Synthetic embedded sign-in" src="${frameOrigin + formPath}"></iframe><button>Top page help</button></body></html>`);
  };
  const top = createServer(handler); let child: Server | undefined;
  try {
    const origin = await listen(top);
    if (crossOrigin) { child = createServer(handler); frameOrigin = await listen(child); }
    else frameOrigin = origin;
    return {
      origin, frameOrigin, frameUrl: frameOrigin + formPath,
      get loginCount() { return loginCount; }, get readyCount() { return readyCount; }, get formReadyCount() { return formReadyCount; },
      close: async () => { if (child) await close(child); await close(top); },
    };
  } catch (error) { if (child?.listening) await close(child); if (top.listening) await close(top); throw error; }
}
