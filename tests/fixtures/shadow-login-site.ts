import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Synthetic local site: request bodies are drained without parsing or logging. */
export async function startShadowLoginFixture() {
  let loginCount = 0;
  let readyCount = 0;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'POST' && request.url === '/ready') {
      request.resume();
      request.on('end', () => {
        if (request.headers.cookie?.includes('keep_safe_shadow_fixture=authenticated')) readyCount++;
        response.writeHead(204); response.end();
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/login') {
      request.resume();
      request.on('end', () => {
        loginCount++;
        response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'keep_safe_shadow_fixture=authenticated; HttpOnly; SameSite=Lax; Path=/' });
        response.end('{"signedIn":true}');
      });
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/account') {
      if (!request.headers.cookie?.includes('keep_safe_shadow_fixture=authenticated')) {
        response.writeHead(401); response.end('<h1>Sign-in required</h1>'); return;
      }
      response.end('<h1>Component session authenticated</h1><p>The agent resumed with the same local browser cookie.</p>'); return;
    }
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic web-component sign-in</title>
      <style>body{font:18px system-ui;background:#f5f4ee;color:#15231e;margin:0;padding:24px}keep-safe-login{display:block} .scope-decoy{position:absolute;left:-10000px}</style></head>
      <body><h1>Component test workspace</h1><p>Synthetic local test only. Never enter real credentials.</p>
      <span class="scope-decoy" id="email-label">Wrong document email label</span><span class="scope-decoy" id="password-label">Wrong document password label</span>
      <keep-safe-login></keep-safe-login><script>
        const outer = document.querySelector('keep-safe-login').attachShadow({mode:'open'});
        outer.innerHTML = '<section><keep-safe-fields><span slot="action">Sign in component</span></keep-safe-fields></section>';
        const inner = outer.querySelector('keep-safe-fields').attachShadow({mode:'open'});
        inner.innerHTML = '<style>label,input,button{display:block;margin:12px 0;width:100%;box-sizing:border-box}input,button{padding:12px;font:inherit}button{background:#173d32;color:white;border:0;border-radius:8px}[hidden]{display:none}</style><form method="post" action="/login"><label id="email-label" for="email">Component email</label><input id="email" name="email" type="email" aria-labelledby="email-label" autocomplete="off" required><label id="password-label" for="password">Synthetic component password</label><input id="password" name="password" type="password" aria-labelledby="password-label" autocomplete="off" required><button type="submit"><slot name="action">Wrong fallback action</slot></button></form><p role="status" hidden>Component sign-in complete</p>';
        const form = inner.querySelector('form');
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const response = await fetch('/login', {method:'POST',body:new FormData(form),credentials:'same-origin'});
          if (!response.ok) return;
          // Keep the now-hidden password input alive so handback clearing is tested.
          form.hidden = true;
          inner.querySelector('[role="status"]').hidden = false;
          await fetch('/ready', {method:'POST',credentials:'same-origin'});
        });
      </script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, get loginCount() { return loginCount; }, get readyCount() { return readyCount; }, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
