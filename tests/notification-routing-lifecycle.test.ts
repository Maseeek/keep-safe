import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import webpush from 'web-push';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { LoginRequest } from '../packages/shared/src/protocol';

const sourceKey = webpush.generateVAPIDKeys().publicKey;
const otherKey = webpush.generateVAPIDKeys().publicKey;
const createRequest = (title: string, status: LoginRequest['status'] = 'pending'): LoginRequest => ({ id: randomUUID(), title, status, agent: 'Routing lifecycle fixture', reason: 'Synthetic only', origin: 'https://example.invalid', url: 'https://example.invalid/login', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() });
const first = createRequest('First synthetic notification'); const second = createRequest('Second synthetic notification');
const active = createRequest('Original active browser', 'active'); const replacement = createRequest('Replacement active browser', 'active');
type Harness = Window & {
  routingHold: boolean;
  routingHeld: Array<() => void>;
  routingWatches: Array<string | null>;
  routingPatch: (value: { otherSource?: boolean; preserveKey?: boolean; requests?: LoginRequest[] }) => void;
};
let browser: Browser;
let server: ReturnType<typeof createServer>;
let origin: string;

beforeAll(async () => {
  const virtual = 'virtual:notification-app-lifecycle'; const workspace = resolve('apps/web/src/workspace.ts');
  const result = await build({ configFile: false, envDir: false, logLevel: 'silent', oxc: { jsx: { development: false } }, define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'notification-app-lifecycle', enforce: 'pre', resolveId: (id, importer) => id === virtual || id.endsWith('/' + virtual) ? '\0' + virtual : id === './workspace' && importer?.endsWith('/App.tsx') ? '\0notification-workspace' : undefined,
      load: id => id === '\0' + virtual ? `import React from'react';import{createRoot}from'react-dom/client';import{App}from${JSON.stringify(resolve('apps/web/src/App.tsx'))};createRoot(document.querySelector('#root')).render(React.createElement(App));`
        : id === '\0notification-workspace' ? `import{useState,useCallback}from'react';export{validateConnection}from${JSON.stringify(workspace)};
          const A={url:'https://synthetic-a.invalid',token:'synthetic-a'};const B={url:'https://synthetic-b.invalid',token:'synthetic-b'};
          const initial=JSON.parse(document.querySelector('#fixture').textContent);let latest;window.routingHold=false;window.routingHeld=[];window.routingWatches=[];
          const watch=id=>{window.routingWatches.push(id);};
          export function useWorkspace(){const[state,setState]=useState({connection:A,info:{name:'Synthetic',version:'test',browserAvailable:true,pushEnabled:false,vapidPublicKey:${JSON.stringify(sourceKey)}},requests:initial});latest=state;
            window.routingPatch=patch=>setState(previous=>({...previous,...(patch.requests?{requests:patch.requests}:{}),...(patch.otherSource?{connection:B,info:{...previous.info,vapidPublicKey:patch.preserveKey?previous.info.vapidPublicKey:${JSON.stringify(otherKey)}}}:{})}));
            const api=useCallback(path=>new Promise(resolve=>{const read=()=>resolve(path==='/api/info'?latest.info:{requests:latest.requests});if(window.routingHold){const captured=path==='/api/info'?latest.info:{requests:latest.requests};window.routingHeld.push(()=>resolve(captured));}else read();}),[]);
            return{...state,status:'connected',frame:{requestId:state.requests[0]?.id,data:'aW1hZ2U=',width:390,height:720,url:'https://example.invalid/login'},browserPaused:false,browserVisible:true,navigationBusy:false,navigationUncertain:false,navigationAvailable:false,navigationError:'',focusBusy:false,focusBlocked:false,controlsBusy:false,pageControls:null,focusedControl:null,controlsError:'',error:'',pairingNotice:'',api,watch,send:()=>true,action:async()=>{},resumeBrowser:()=>true,navigateBrowser:()=>false,inspectControls:()=>{},focusControl:()=>{},dismissPairingNotice:()=>{},connect:async()=>{},disconnect:()=>{},forgetDevice:async()=>true,clearHistory:async()=>({removed:0,protected:0}),resetDemo:()=>{}};}` : undefined }],
    build: { write: false, emptyOutDir: false, copyPublicDir: false, minify: false, sourcemap: false, lib: { entry: virtual, name: 'NotificationLifecycle', formats: ['iife'] } } });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Synthetic App harness failed.');
  const script = output.output.find(chunk => chunk.type === 'chunk'); if (!script || script.type !== 'chunk') throw new Error('Synthetic App harness failed.');
  const css = await readFile('apps/web/src/styles.css', 'utf8');
  server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(script.code); return; }
    if (request.url === '/sw.js') { response.setHeader('Content-Type', 'application/javascript'); response.end('/* Synthetic harness: no push or fetch handlers. */'); return; }
    const desktop = request.url === '/desktop';
    response.setHeader('Content-Type', 'text/html'); response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script id="fixture" type="application/json">${JSON.stringify(desktop ? [active, first, second] : [first, second])}</script><script src="/app.js"></script>`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`; browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); if (server) await new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }); });
async function setup(desktop = false) {
  const context = await browser.newContext({ viewport: { width: desktop ? 1440 : 390, height: 900 }, isMobile: !desktop, hasTouch: !desktop }); const page = await context.newPage();
  await page.addInitScript(() => { delete (window as unknown as { PushManager?: unknown }).PushManager; });
  const failed = page.waitForEvent('pageerror').then(error => { throw new Error(`Synthetic App harness: ${error.message}`); });
  try {
    await Promise.race([(async () => { await page.goto(origin + (desktop ? '/desktop' : '/')); await page.getByText('Bridge connected', { exact: true }).waitFor(); })(), failed]);
  } catch (error) { await context.close(); throw error; }
  return { context, page };
}
async function notify(page: Page, requestId: string) {
  await page.evaluate(({ requestId, sourceKey }) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'notification-request', version: 1, requestId, sourceKey } })), { requestId, sourceKey });
}
async function hold(page: Page) { await page.evaluate(() => { (window as unknown as Harness).routingHold = true; }); }
async function release(page: Page) { await page.evaluate(() => { const target = window as unknown as Harness; target.routingHold = false; target.routingHeld.splice(0).forEach(resolve => resolve()); }); }

it('a newer notification synchronously invalidates an older held read in the same callback', async () => {
  const { context, page } = await setup();
  try {
    await hold(page); await notify(page, first.id); await expect.poll(() => page.evaluate(() => (window as unknown as Harness).routingHeld.length)).toBe(2);
    await page.evaluate(({ requestId, sourceKey }) => {
      const target = window as unknown as Harness;
      navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'notification-request', version: 1, requestId, sourceKey } }));
      target.routingHold = false; target.routingHeld.splice(0).forEach(resolve => resolve());
    }, { requestId: second.id, sourceKey });
    await page.getByRole('heading', { name: second.title, exact: true, level: 2 }).waitFor();
    expect(await page.getByRole('heading', { name: first.title, exact: true, level: 2 }).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Approve & open', exact: true }).count()).toBe(1);
  } finally { await context.close(); }
});

it('manual selection while verification is held cannot be undone by its old result', async () => {
  const { context, page } = await setup();
  try {
    await hold(page); await notify(page, first.id); await expect.poll(() => page.evaluate(() => (window as unknown as Harness).routingHeld.length)).toBe(2);
    await page.getByRole('button', { name: new RegExp(second.title) }).click(); await release(page);
    await page.getByRole('heading', { name: second.title, exact: true, level: 2 }).waitFor();
    await expect.poll(() => page.getByRole('status', { name: 'Notification notice', exact: true }).innerText()).toContain('view or connection changed');
    expect(await page.getByRole('heading', { name: first.title, exact: true, level: 2 }).count()).toBe(0);
  } finally { await context.close(); }
});

it.each([false, true])('a delayed read cannot select after connection replacement (same key: %s)', async preserveKey => {
  const { context, page } = await setup();
  try {
    await hold(page); await notify(page, first.id); await expect.poll(() => page.evaluate(() => (window as unknown as Harness).routingHeld.length)).toBe(2);
    await page.evaluate(({ request, preserveKey }) => (window as unknown as Harness).routingPatch({ otherSource: true, preserveKey, requests: [request] }), { request: replacement, preserveKey });
    await release(page); await page.getByRole('status', { name: 'Notification notice', exact: true }).waitFor();
    expect(await page.getByRole('heading', { name: first.title, exact: true, level: 2 }).count()).toBe(0);
    expect(await page.getByRole('heading', { name: replacement.title, exact: true, level: 2 }).count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as Harness).routingWatches.filter(id => id !== null))).toEqual([]);
  } finally { await context.close(); }
});

it('explicit Open request revalidation detects desktop default browser identity changing under a null selection', async () => {
  const { context, page } = await setup(true);
  try {
    await page.getByRole('heading', { name: active.title, exact: true, level: 2 }).waitFor();
    await notify(page, first.id); await page.getByRole('button', { name: 'Open request', exact: true }).waitFor();
    await hold(page); await page.getByRole('button', { name: 'Open request', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as Harness).routingHeld.length)).toBe(2);
    await page.evaluate(requests => (window as unknown as Harness).routingPatch({ requests }), [replacement, first, second]);
    await page.getByRole('heading', { name: replacement.title, exact: true, level: 2 }).waitFor(); await release(page);
    await expect.poll(() => page.getByRole('status', { name: 'Notification notice', exact: true }).innerText()).toContain('view or connection changed');
    expect(await page.getByRole('heading', { name: first.title, exact: true, level: 2 }).count()).toBe(0);
    expect(await page.evaluate(id => (window as unknown as Harness).routingWatches.includes(id), first.id)).toBe(false);
  } finally { await context.close(); }
});
