import { createServer } from 'node:http';

export const touchFixtureCredentials = { email: 'touch-fixture@example.invalid', password: 'synthetic-touch-password' } as const;
const cookie = 'keep_safe_touch_fixture=authenticated';

/** Synthetic local page. Fixed public test credentials are checked only in the
 * browser. Node drains POST bodies without reading, parsing or logging them.
 */
export async function startTouchLoginFixture() {
  let formReadyCount = 0; let loginCount = 0; let readyCount = 0; let tapCount = 0; let bodyScrolledCount = 0; let nestedScrolledCount = 0;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
    const path = new URL(request.url || '/', 'http://fixture.invalid').pathname;
    if (request.method === 'POST') {
      request.resume(); request.on('end', () => {
        if (path === '/authenticate-touch') { loginCount++; response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `${cookie}; HttpOnly; SameSite=Lax; Path=/` }); response.end('{"signedIn":true}'); return; }
        if (path === '/form-ready') formReadyCount++;
        else if (path === '/account-ready') { if (request.headers.cookie?.includes(cookie)) readyCount++; }
        else if (path === '/probe-tapped') tapCount++;
        else if (path === '/body-scrolled') bodyScrolledCount++;
        else if (path === '/nested-scrolled') nestedScrolledCount++;
        else { response.writeHead(404); response.end(); return; }
        response.writeHead(204); response.end();
      }); return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (path === '/account') {
      if (!request.headers.cookie?.includes(cookie)) { response.writeHead(401); response.end('<h1>Touch sign-in required</h1>'); return; }
      response.end('<h1>Touch session authenticated</h1><p>Synthetic cookie continuity verified.</p>'); return;
    }
    if (path !== '/login') { response.writeHead(404); response.end('<h1>Fixture page not found</h1>'); return; }
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic touch sign-in</title>
      <style>body{font:17px system-ui;color:#15231e;background:#f5f4ee;margin:0;padding:88px 16px 90px}h1{font-size:22px;margin:0}button,input{box-sizing:border-box;font:inherit;min-height:48px;padding:10px;width:100%}button{background:#173d32;color:white;border:0;border-radius:8px}#probe{position:fixed;top:16px;left:16px;right:16px;width:calc(100% - 32px);z-index:2}#pane{position:absolute;top:100px;left:16px;right:16px;height:220px;overflow:auto;overscroll-behavior:contain;background:#e0eadd;border:1px solid #80998b}#pane>div{height:1600px;padding:16px;box-sizing:border-box;background:linear-gradient(#e0eadd,#c0d2bb)}#intro{height:1320px;padding-top:280px;box-sizing:border-box;background:linear-gradient(#f5f4ee,#e5e9df)}label{display:block;margin:14px 0 6px}#submit{position:fixed;bottom:16px;left:16px;right:16px;width:calc(100% - 32px);z-index:2}[hidden]{display:none!important}</style></head>
      <body><button id="probe" type="button">Synthetic tap target</button><section id="pane" aria-label="Nested practice scroller"><div>Swipe inside this separate panel.<p>Only synthetic content.</p></div></section>
      <div id="intro"><h1>Touch login practice</h1><p>Synthetic local test only. Never enter real credentials.</p><p>Swipe this page to reach the form below.</p></div>
      <form id="login" method="post" action="/authenticate-touch" novalidate><label for="email">Touch email</label><input id="email" type="email" autocomplete="off"><label for="password">Synthetic touch password</label><input id="password" type="password" autocomplete="off"><p id="validation" hidden>Complete the synthetic fields first.</p></form>
      <button id="submit" form="login" type="submit">Sign in using touch</button><p id="result" hidden>Touch sign-in complete</p>
      <script>const notify=path=>fetch(path,{method:'POST',credentials:'same-origin'});let bodyMarked=false;let nestedMarked=false;
      document.querySelector('#probe').addEventListener('click',()=>{void notify('/probe-tapped');});
      window.addEventListener('scroll',()=>{if(!bodyMarked&&window.scrollY>500){bodyMarked=true;void notify('/body-scrolled');}});
      document.querySelector('#pane').addEventListener('scroll',event=>{if(!nestedMarked&&event.currentTarget.scrollTop>80){nestedMarked=true;void notify('/nested-scrolled');}});
      const form=document.querySelector('#login');form.addEventListener('submit',async event=>{event.preventDefault();if(document.querySelector('#email').value!==${JSON.stringify(touchFixtureCredentials.email)}||document.querySelector('#password').value!==${JSON.stringify(touchFixtureCredentials.password)}){document.querySelector('#validation').hidden=false;return;}
      const response=await notify('/authenticate-touch');if(!response.ok)return;form.hidden=true;document.querySelector('#submit').hidden=true;document.querySelector('#result').hidden=false;await notify('/account-ready');});void notify('/form-ready');</script></body></html>`);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { origin, loginUrl: origin + '/login', get formReadyCount() { return formReadyCount; }, get loginCount() { return loginCount; }, get readyCount() { return readyCount; }, get tapCount() { return tapCount; }, get bodyScrolledCount() { return bodyScrolledCount; }, get nestedScrolledCount() { return nestedScrolledCount; },
      close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
  } catch (error) { server.closeAllConnections(); server.close(); throw error; }
}
