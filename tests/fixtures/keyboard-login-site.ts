import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export const keyboardFixtureCredentials = { email: 'keyboard-fixture@example.invalid', password: 'synthetic-keyboard-password' } as const;
const cookie = 'keep_safe_keyboard_fixture=authenticated';

/** Synthetic local page. Only browser JavaScript checks the fixed public test
 * credentials and native control state. POST bodies are drained, never read,
 * parsed or logged; the successful browser request deliberately has no body.
 */
export async function startKeyboardLoginFixture() {
  let loginCount = 0; let readyCount = 0; let formReadyCount = 0; let rejectedCount = 0;
  let selectionCount = 0; let helpOpenedCount = 0; let helpClosedCount = 0;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
    const path = new URL(request.url || '/', 'http://fixture.invalid').pathname;
    if (request.method === 'POST') {
      request.resume();
      request.on('end', () => {
        if (path === '/authenticate-keyboard') {
          loginCount++;
          response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `${cookie}; HttpOnly; SameSite=Lax; Path=/` });
          response.end('{"signedIn":true}'); return;
        }
        if (path === '/form-ready') formReadyCount++;
        else if (path === '/account-ready') { if (request.headers.cookie?.includes(cookie)) readyCount++; }
        else if (path === '/validation-rejected') rejectedCount++;
        else if (path === '/selection-ready') selectionCount++;
        else if (path === '/help-opened') helpOpenedCount++;
        else if (path === '/help-closed') helpClosedCount++;
        else { response.writeHead(404); response.end(); return; }
        response.writeHead(204); response.end();
      });
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (path === '/account') {
      if (!request.headers.cookie?.includes(cookie)) { response.writeHead(401); response.end('<h1>Keyboard sign-in required</h1>'); return; }
      response.end('<h1>Keyboard session authenticated</h1><p>Synthetic cookie continuity verified.</p>'); return;
    }
    if (path !== '/login') { response.writeHead(404); response.end('<h1>Fixture page not found</h1>'); return; }
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic keyboard sign-in</title>
      <style>body{font:17px system-ui;background:#f5f4ee;color:#15231e;margin:0;padding:14px}h1{font-size:23px}label,input,select,button{box-sizing:border-box}label{display:block;margin-top:12px}input:not([type=checkbox]):not([type=radio]),select,button{display:block;width:100%;min-height:44px;padding:10px;font:inherit;margin-top:6px}.choice{display:flex;align-items:center;gap:10px;min-height:44px}.choice input{width:24px;height:24px}fieldset{margin:12px 0;padding:10px;border:1px solid #80998b}button{background:#173d32;color:#fff;border:0;border-radius:8px}dialog{width:calc(100% - 54px);max-width:350px;box-sizing:border-box;border:1px solid #80998b;border-radius:12px}dialog::backdrop{background:#17251b99}[hidden]{display:none!important}</style></head>
      <body><h1>Keyboard login practice</h1><p>Synthetic local test only. Never enter real credentials.</p>
      <form id="login" method="post" action="/authenticate-keyboard" novalidate>
      <label for="email">Keyboard email</label><input id="email" type="email" autocomplete="off">
      <label for="password">Synthetic keyboard password</label><input id="password" type="password" autocomplete="off">
      <label class="choice"><input id="remember" type="checkbox">Remember this browser</label>
      <fieldset><legend>Workspace</legend><label class="choice"><input type="radio" name="workspace" id="personal" checked>Personal workspace</label><label class="choice"><input type="radio" name="workspace" id="team">Team workspace</label></fieldset>
      <label for="method">Sign-in method</label><select id="method"><option value="">Choose a sign-in method</option><option value="hardware">Hardware key</option><option value="backup">Backup code</option></select>
      <button id="show-help" type="button">Show keyboard help</button><button type="submit">Sign in with keyboard controls</button>
      <p id="validation" hidden>Complete every synthetic field and native control first.</p></form>
      <p id="result" hidden>Keyboard sign-in complete</p>
      <dialog id="help" aria-labelledby="help-title"><h2 id="help-title">Keyboard help</h2><p>Press Escape in the remote browser to close this synthetic dialog.</p><button id="close-help" type="button">Close keyboard help</button></dialog>
      <script>
      const form=document.querySelector('#login');const help=document.querySelector('#help');
      const notify=path=>fetch(path,{method:'POST',credentials:'same-origin'});
      document.querySelector('#show-help').addEventListener('click',()=>{help.showModal();void notify('/help-opened');});
      document.querySelector('#close-help').addEventListener('click',()=>help.close());
      help.addEventListener('close',()=>{void notify('/help-closed');});
      document.querySelector('#method').addEventListener('change',()=>{if(document.querySelector('#method').value==='hardware')void notify('/selection-ready');});
      form.addEventListener('submit',async event=>{
        event.preventDefault();
        if(document.querySelector('#email').value!==${JSON.stringify(keyboardFixtureCredentials.email)}||document.querySelector('#password').value!==${JSON.stringify(keyboardFixtureCredentials.password)}||!document.querySelector('#remember').checked||!document.querySelector('#team').checked||document.querySelector('#method').value!=='hardware'){
          document.querySelector('#validation').hidden=false;await notify('/validation-rejected');return;
        }
        const response=await notify('/authenticate-keyboard');if(!response.ok)return;
        form.hidden=true;document.querySelector('#result').hidden=false;await notify('/account-ready');
      });void notify('/form-ready');
      </script></body></html>`);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      origin, loginUrl: origin + '/login',
      get loginCount() { return loginCount; }, get readyCount() { return readyCount; }, get formReadyCount() { return formReadyCount; },
      get rejectedCount() { return rejectedCount; }, get selectionCount() { return selectionCount; },
      get helpOpenedCount() { return helpOpenedCount; }, get helpClosedCount() { return helpClosedCount; },
      close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }),
    };
  } catch (error) { server.closeAllConnections(); server.close(); throw error; }
}
