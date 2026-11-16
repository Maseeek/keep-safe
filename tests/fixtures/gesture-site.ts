import { createServer } from 'node:http';

export const gestureFixtureValues = { user: 'manager-fixture@example.invalid', secret: 'synthetic-secret-from-manager', pasted: 'pasted-fixture@example.invalid' } as const;

/** Synthetic local page for gesture checks: a drag puzzle, a long page, a
 * hover target, selectable text and one text field. It holds no credentials.
 * The page reports what happened to it through counters, never typed text. */
export async function startGestureFixture() {
  const counts: Record<string, number> = {};
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const path = new URL(request.url || '/', 'http://fixture.invalid').pathname;
    if (request.method === 'POST') { request.resume(); request.on('end', () => { counts[path.slice(1)] = (counts[path.slice(1)] ?? 0) + 1; response.writeHead(204); response.end(); }); return; }
    if (path === '/window') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic second window</title>
        <body style="margin:0;background:#22313a"><button id="inner" type="button" style="position:absolute;top:100px;left:40px;width:240px;height:80px;font:17px system-ui">Inside the window</button>
        <script>document.querySelector('#inner').addEventListener('click',()=>{fetch('/window-tapped',{method:'POST'}).then(()=>window.close());});fetch('/window-ready',{method:'POST'});</script>`);
      return;
    }
    if (path !== '/gestures') { response.writeHead(404); response.end('<h1>Fixture page not found</h1>'); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic gesture practice</title>
      <style>body{font:17px system-ui;margin:0;height:5200px;background:linear-gradient(#f5f4ee,#9db7c9)}
      #field{position:absolute;top:24px;left:20px;width:300px;height:48px;font:inherit;box-sizing:border-box}
      #track{position:absolute;top:110px;left:20px;width:300px;height:56px;background:#d8ddd6;border-radius:28px;touch-action:none;user-select:none}
      #knob{position:absolute;left:0;top:0;width:56px;height:56px;border-radius:28px;background:#173d32;touch-action:none}
      #hover{position:absolute;top:200px;left:20px;width:300px;height:56px;background:#e9e2c8}
      #words{position:absolute;top:290px;left:20px;width:340px;margin:0;font:20px/30px monospace}
      #corner{position:absolute;top:380px;left:250px;width:100px;height:60px}
      #opener{position:absolute;top:380px;left:20px;width:200px;height:60px}
      #secret{position:absolute;top:470px;left:20px;width:300px;height:48px;font:inherit;box-sizing:border-box}</style></head>
      <body><input id="field" type="email" aria-label="Practice email" autocomplete="off">
      <div id="track" aria-label="Drag puzzle"><div id="knob"></div></div><div id="hover">Hover target</div>
      <p id="words">alpha bravo charlie delta</p><button id="corner" type="button">Corner</button><button id="opener" type="button">Open a window</button><input id="secret" type="password" aria-label="Practice secret" autocomplete="off">
      <script>const notify=name=>fetch('/'+name,{method:'POST'});const knob=document.querySelector('#knob');let drag=null;let solved=false;
      window.gesture={events:[],pointerTypes:[]};
      knob.addEventListener('pointerdown',event=>{drag={x:event.clientX,left:knob.offsetLeft};knob.setPointerCapture(event.pointerId);gesture.events.push('down');gesture.pointerTypes.push(event.pointerType);});
      knob.addEventListener('pointermove',event=>{if(!drag)return;knob.style.left=Math.max(0,Math.min(244,drag.left+event.clientX-drag.x))+'px';});
      knob.addEventListener('pointerup',()=>{if(!drag)return;drag=null;gesture.events.push('up');if(knob.offsetLeft>=240&&!solved){solved=true;void notify('puzzle-solved');}else if(!solved)knob.style.left='0px';});
      knob.addEventListener('pointercancel',()=>{drag=null;gesture.events.push('cancel');if(!solved)knob.style.left='0px';});
      document.querySelector('#hover').addEventListener('mouseenter',()=>{void notify('hovered');});
      document.querySelector('#corner').addEventListener('click',()=>{void notify('corner-tapped');});
      document.querySelector('#opener').addEventListener('click',()=>{window.open('/window','_blank');});
      document.querySelector('#field').addEventListener('focus',()=>{void notify('field-focused');});
      // Only whether the synthetic values arrived is reported, never what was typed.
      document.querySelector('#field').addEventListener('input',event=>{if(event.target.value===${JSON.stringify(gestureFixtureValues.user)})void notify('user-arrived');if(event.target.value===${JSON.stringify(gestureFixtureValues.pasted)})void notify('paste-arrived');});
      document.querySelector('#secret').addEventListener('input',event=>{if(event.target.value===${JSON.stringify(gestureFixtureValues.secret)})void notify('secret-arrived');});
      let far=false;window.addEventListener('scroll',()=>{if(!far&&window.scrollY>500){far=true;void notify('scrolled-far');}});
      void notify('ready');</script></body></html>`);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { origin, url: origin + '/gestures', count: (name: string) => counts[name] ?? 0,
      close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
  } catch (error) { server.closeAllConnections(); server.close(); throw error; }
}
