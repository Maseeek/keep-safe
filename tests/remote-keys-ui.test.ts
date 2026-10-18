import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { chromium, type Browser, type Locator } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';
import type { PageControlsSnapshot } from '../packages/shared/src/protocol';
import type { Workspace } from '../apps/web/src/workspace';
import { keyboardFixtureCredentials, startKeyboardLoginFixture } from './fixtures/keyboard-login-site';

const ownerToken = 'synthetic-keys-owner';
const agentToken = 'synthetic-keys-agent';
type HarnessWindow = Window & { workspaceKeysHarness: Workspace; workspaceKeysSocket: WebSocket; workspaceKeysSocketCount: number; workspaceKeysCloseCode?: number };
async function workspaceHarness() {
  const virtual = 'virtual:workspace-keys-harness';
  const result = await build({
    configFile: false, envDir: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'workspace-keys-test-harness', resolveId: id => id === virtual || id.endsWith('/' + virtual) ? '\0' + virtual : undefined,
      load: id => id === '\0' + virtual ? `
        import React from 'react';import{createRoot}from'react-dom/client';
        import{useWorkspace}from${JSON.stringify(resolve('apps/web/src/workspace.ts'))};
        const NativeSocket=window.WebSocket;window.workspaceKeysSocketCount=0;
        window.WebSocket=class extends NativeSocket{constructor(...args){super(...args);window.workspaceKeysSocket=this;window.workspaceKeysSocketCount++;this.addEventListener('close',event=>{window.workspaceKeysCloseCode=event.code;});}};
        function Harness(){const workspace=useWorkspace(()=>{});window.workspaceKeysHarness=workspace;return React.createElement('p',{id:'state'},workspace.status);}
        createRoot(document.querySelector('#root')).render(React.createElement(Harness));
      ` : undefined }],
    build: { write: false, emptyOutDir: false, copyPublicDir: false, minify: false, sourcemap: false,
      lib: { entry: virtual, name: 'WorkspaceKeysHarness', formats: ['iife'] } },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('The test harness did not build.');
  const chunk = output.output.find(chunk => chunk.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The test harness did not build.');
  return chunk.code;
}
async function serveWorkspaceHarness(script: string) {
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/workspace-keys-harness.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(script); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><div id="root"></div><script src="/workspace-keys-harness.js"></script>'); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
async function usableTarget(button: Locator) {
  await button.scrollIntoViewIfNeeded();
  const box = (await button.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await button.evaluate(element => { const box = element.getBoundingClientRect(); const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return hit === element || element.contains(hit); })).toBe(true);
}

describe('native remote browser keys through the phone interface', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each([320, 390])('uses native checkbox, radio, select and Escape before authenticated handback at %ipx', async width => {
    const site = await startKeyboardLoginFixture();
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, allowLocalUrls: true, staticDir: resolve('apps/web/dist') });
    const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const snapshots: PageControlsSnapshot[] = []; const keys: string[] = []; let scrolls = 0;
    const errors: string[] = []; const external: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => { if (new URL(route.request().url()).origin === bridge.url) return route.continue(); external.push(new URL(route.request().url()).origin); return route.abort(); });
    page.on('websocket', socket => {
      socket.on('framereceived', frame => { const message = JSON.parse(String(frame.payload)); if (message.type === 'controls') snapshots.push(message.snapshot); });
      // Record key names only, never the text messages or browser input values.
      socket.on('framesent', frame => { const message = JSON.parse(String(frame.payload)); if (message.type === 'key') keys.push(message.key); if (message.type === 'scroll') scrolls++; });
    });
    const focus = async (name: string) => {
      const button = page.getByRole('button', { name: `Focus ${name}`, exact: true }); await usableTarget(button); await button.click();
      await page.getByText(`Focus confirmed on ${name}.`, { exact: true }).waitFor();
    };
    const press = async (name: string) => { const button = page.getByRole('button', { name: `Press ${name} in browser`, exact: true }); await usableTarget(button); await button.click(); };
    try {
      const request = await client.create({ agent: 'Keyboard login fixture', title: 'Synthetic native keyboard sign-in', url: site.loginUrl, ttlSeconds: 120 });
      await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: ownerToken })}`);
      await page.getByText('Bridge connected', { exact: true }).waitFor();
      await page.getByRole('button', { name: /Keyboard login fixture/ }).click();
      await page.getByRole('button', { name: 'Approve & open', exact: true }).click();
      await page.locator('.remote-screen img').waitFor(); await expect.poll(() => site.formReadyCount).toBe(1);
      const more = page.getByRole('button', { name: 'More keys', exact: true });
      expect(await more.getAttribute('aria-expanded')).toBe('false');
      expect(await page.getByRole('group', { name: 'More browser keys', exact: true }).count()).toBe(0);
      await usableTarget(more); await more.click();
      await page.getByRole('group', { name: 'More browser keys', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Page controls', exact: true }).click();
      await focus('Keyboard email');
      await page.getByRole('button', { name: 'Type text', exact: true }).click();
      const text = page.getByLabel('Tap a field in the browser, then send text');
      await text.fill(keyboardFixtureCredentials.email); await page.getByRole('button', { name: 'Send', exact: true }).click();
      await focus('Synthetic keyboard password');
      await text.fill(keyboardFixtureCredentials.password); await page.getByRole('button', { name: 'Send', exact: true }).click();
      expect(await text.inputValue()).toBe('');
      // Native controls are still unset: focus alone must not activate them.
      await focus('Sign in with keyboard controls'); await press('Enter');
      await expect.poll(() => site.rejectedCount).toBe(1); expect(site.loginCount).toBe(0);
      await focus('Show keyboard help'); await press('Enter');
      await expect.poll(() => site.helpOpenedCount).toBe(1);
      await press('Escape'); await expect.poll(() => site.helpClosedCount).toBe(1);
      expect(await more.getAttribute('aria-expanded')).toBe('true');
      expect(await page.getByRole('group', { name: 'More browser keys', exact: true }).isVisible()).toBe(true);
      await focus('Remember this browser'); await press('Space');
      await focus('Team workspace'); await press('Space');
      const count = snapshots.length;
      await page.getByRole('button', { name: 'Refresh page controls', exact: true }).click();
      await expect.poll(() => snapshots.length).toBeGreaterThan(count);
      expect(snapshots.at(-1)!.controls.find(control => control.name === 'Remember this browser')?.checked).toBe(true);
      expect(snapshots.at(-1)!.controls.find(control => control.name === 'Team workspace')?.checked).toBe(true);
      expect(snapshots.at(-1)!.controls.find(control => control.name === 'Personal workspace')?.checked).toBe(false);
      await focus('Sign-in method'); const beforeScrolls = scrolls;
      await press('ArrowDown'); await expect.poll(() => site.selectionCount).toBe(1);
      expect(scrolls).toBe(beforeScrolls); expect(keys).toContain('ArrowDown');
      for (const value of [keyboardFixtureCredentials.email, keyboardFixtureCredentials.password, 'Hardware key']) {
        expect(JSON.stringify(snapshots)).not.toContain(value);
        expect(await page.locator('.page-control-content').innerText()).not.toContain(value);
      }
      expect((await client.get(request.id)).browser).toBeUndefined();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (process.env.KEEP_SAFE_QA_SCREENSHOTS) { await mkdir('.keep-safe/qa', { recursive: true }); await page.screenshot({ path: `.keep-safe/qa/remote-keys-${width}.png`, fullPage: true }); }
      await focus('Sign in with keyboard controls'); await press('Enter');
      await expect.poll(() => site.loginCount).toBe(1); await expect.poll(() => site.readyCount).toBe(1);
      expect((await client.get(request.id)).browser).toBeUndefined();
      await page.getByRole('button', { name: /Done, hand back/ }).click();
      await expect.poll(async () => (await client.get(request.id)).status).toBe('completed');
      const result = await client.get(request.id); const agent = await chromium.connectOverCDP(result.browser!.cdpUrl);
      try {
        const resumed = agent.contexts().flatMap(context => context.pages()).find(page => page.url() === site.loginUrl)!;
        expect(resumed).toBeDefined();
        expect(await resumed.locator('#password').evaluate(element => (element as HTMLInputElement).value === '')).toBe(true);
        const account = await resumed.goto(site.origin + '/account'); expect(account?.status()).toBe(200);
        await resumed.reload(); await resumed.getByRole('heading', { name: 'Keyboard session authenticated', exact: true }).waitFor();
      } finally { await agent.close(); }
      expect(keys.filter(key => key === 'Space')).toHaveLength(2); expect(keys).toContain('Escape');
      expect(await page.getByRole('group', { name: 'More browser keys', exact: true }).count()).toBe(0);
      expect(errors).toEqual([]); expect(external).toEqual([]);
    } finally { await context.close(); await bridge.close(); await site.close(); }
  }, 45000);

  it.each(['Tab', 'Shift+Tab', 'tap'])('keeps failed-focus Space/Escape blocked until deliberate %s recovery', async recovery => {
    const remote = await browser.newPage({ viewport: { width: 390, height: 720 } });
    await remote.setContent('<style>input{position:absolute;width:32px;height:32px;left:30px}#before{top:10px}#target{top:70px}#after{top:130px}</style><input id="before"><input id="target" type="checkbox"><input id="after"><script>document.body.dataset.escapes="0";document.addEventListener("keydown",event=>{if(event.key==="Escape")document.body.dataset.escapes=String(Number(document.body.dataset.escapes)+1);});</script>');
    await remote.locator('#target').focus();
    const snapshotId = '00000000-0000-4000-8000-000000000001'; const controlId = '00000000-0000-4000-8000-000000000002';
    const keys: string[] = []; let clicks = 0;
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, staticDir: resolve('apps/web/dist'), browserFactory: async () => ({
      frame: async () => ({ data: (await remote.screenshot({ type: 'jpeg' })).toString('base64'), width: 390, height: 720, url: 'https://example.com/keyboard' }),
      inspectControls: async () => ({ snapshotId, origin: 'https://example.com', truncated: false, controls: [{ id: controlId, role: 'checkbox', name: 'Recovery checkbox', protected: false, disabled: false, checked: false }] }),
      input: async message => {
        if (message.type === 'focus') throw new Error('Synthetic focus confirmation failed.');
        if (message.type === 'key') { keys.push(String(message.key)); await remote.keyboard.press(String(message.key)); }
        if (message.type === 'click') { clicks++; await remote.mouse.click(Number(message.x), Number(message.y)); }
      }, close: async () => { if (!remote.isClosed()) await remote.close(); },
    }) });
    const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const context = await browser.newContext({ viewport: { width: 320, height: 900 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
      await client.create({ agent: 'Blocked key fixture', title: 'Synthetic failed-focus recovery', url: 'https://example.com/keyboard', ttlSeconds: 120 });
      await page.goto(`${bridge.url}/#${new URLSearchParams({ bridge: bridge.url, token: ownerToken })}`);
      await page.getByRole('button', { name: /Blocked key fixture/ }).click(); await page.getByRole('button', { name: 'Approve & open', exact: true }).click();
      await page.locator('.remote-screen img').waitFor();
      await page.getByRole('button', { name: 'More keys', exact: true }).click();
      await page.getByRole('button', { name: 'Type text', exact: true }).click();
      await page.getByRole('button', { name: 'Page controls', exact: true }).click();
      await page.getByRole('button', { name: 'Focus Recovery checkbox', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'The requested action was not accepted' }).waitFor();
      const text = page.getByLabel('Tap a field in the browser, then send text');
      const space = page.getByRole('button', { name: 'Press Space in browser', exact: true }); const escape = page.getByRole('button', { name: 'Press Escape in browser', exact: true });
      expect(await text.isDisabled()).toBe(true); expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true);
      expect(await space.isDisabled()).toBe(true); expect(await escape.isDisabled()).toBe(true);
      expect(await remote.locator('#target').isChecked()).toBe(false);
      expect(await remote.evaluate(() => Number(document.body.dataset.escapes))).toBe(0); expect(keys).toEqual([]); expect(clicks).toBe(0);
      if (recovery === 'tap') {
        const image = page.locator('.remote-screen img'); const imageBox = (await image.boundingBox())!; const target = (await remote.locator('#target').boundingBox())!;
        await image.click({ position: { x: (target.x + target.width / 2) * imageBox.width / 390, y: (target.y + target.height / 2) * imageBox.height / 720 } });
        await expect.poll(() => clicks).toBe(1);
      } else {
        await page.getByRole('button', { name: `Press ${recovery} in browser`, exact: true }).click();
        await expect.poll(() => keys.includes(recovery)).toBe(true);
        await page.getByRole('button', { name: `Press ${recovery === 'Tab' ? 'Shift+Tab' : 'Tab'} in browser`, exact: true }).click();
      }
      await expect.poll(() => text.isEnabled()).toBe(true);
      expect(await space.isEnabled()).toBe(true); expect(await escape.isEnabled()).toBe(true);
      await escape.click(); await expect.poll(() => remote.evaluate(() => Number(document.body.dataset.escapes))).toBe(1);
      expect(await page.getByRole('button', { name: 'More keys', exact: true }).getAttribute('aria-expanded')).toBe('true');
      expect(await remote.evaluate(() => document.activeElement?.id)).toBe('target');
      const checked = await remote.locator('#target').isChecked(); await space.click();
      await expect.poll(() => remote.locator('#target').isChecked()).toBe(!checked);
    } finally { await context.close(); await bridge.close(); if (!remote.isClosed()) await remote.close(); }
  });

  it('blocks rapid, failed, refreshed and reconnected focus until a matching acknowledgement', async () => {
    const script = await workspaceHarness();
    const harness = await serveWorkspaceHarness(script);
    const remote = await browser.newPage({ viewport: { width: 390, height: 720 } });
    await remote.setContent('<label><input id="target" type="checkbox">Synthetic recovery target</label>'); await remote.locator('#target').focus();
    let snapshotId = '00000000-0000-4000-8000-000000000011'; const controlId = '00000000-0000-4000-8000-000000000012';
    let releaseFocus!: () => void; let focusMode: 'hold' | 'fail' | 'success' = 'hold'; let focusStarted = 0; let textInputs = 0; let inspections = 0; let acknowledgements = 0;
    const heldFocus = new Promise<void>(resolve => { releaseFocus = resolve; }); const keys: string[] = [];
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, appUrl: harness.origin, staticDir: resolve('apps/web/dist'), browserFactory: async () => ({
      frame: async () => ({ data: (await remote.screenshot({ type: 'jpeg' })).toString('base64'), width: 390, height: 720, url: 'https://example.com/keyboard' }),
      inspectControls: async () => { snapshotId = `00000000-0000-4000-8000-${String(10 + ++inspections).padStart(12, '0')}`; return { snapshotId, origin: 'https://example.com', truncated: false, controls: [{ id: controlId, role: 'checkbox', name: 'Synthetic recovery target', protected: false, disabled: false, checked: false }] }; },
      input: async message => {
        if (message.type === 'focus') {
          focusStarted++;
          if (focusMode === 'hold') await heldFocus;
          else if (focusMode === 'fail') throw new Error('Synthetic focus failure.');
          return;
        }
        if (message.type === 'key') { keys.push(String(message.key)); await remote.keyboard.press(String(message.key)); }
        if (message.type === 'text') textInputs++;
      }, close: async () => { if (!remote.isClosed()) await remote.close(); },
    }) });
    const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const context = await browser.newContext(); const page = await context.newPage();
    page.on('websocket', socket => socket.on('framereceived', frame => { if (JSON.parse(String(frame.payload)).type === 'focused') acknowledgements++; }));
    const blockedKeys = ['Enter', 'Backspace', 'Space', 'Escape', 'ControlOrMeta+A'];
    const tryBlocked = () => page.evaluate(names => {
      const workspace = (window as unknown as HarnessWindow).workspaceKeysHarness;
      return [...names.map(key => workspace.send({ type: 'key', key })), workspace.send({ type: 'text', text: 'synthetic-unconfirmed-input' })];
    }, blockedKeys);
    const waitInspection = async (previous: number) => {
      await expect.poll(() => inspections).toBeGreaterThan(previous);
      await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).workspaceKeysHarness.pageControls?.snapshot.snapshotId)).toBe(snapshotId);
    };
    try {
      const request = await client.create({ agent: 'Workspace keys harness', title: 'Synthetic synchronous focus guard', url: 'https://example.com/keyboard', ttlSeconds: 120 });
      const approved = await fetch(`${bridge.url}/api/requests/${request.id}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, body: '{}' }); expect(approved.ok).toBe(true);
      await page.goto(`${harness.origin}/workspace-keys-harness#${new URLSearchParams({ bridge: bridge.url, token: ownerToken })}`);
      await expect.poll(() => page.evaluate(() => ({ status: (window as unknown as HarnessWindow).workspaceKeysHarness?.status, closed: (window as unknown as HarnessWindow).workspaceKeysCloseCode ?? 0 })), { timeout: 5000 }).toEqual({ status: 'connected', closed: 0 });
      await page.evaluate(id => (window as unknown as HarnessWindow).workspaceKeysHarness.watch(id), request.id);
      await expect.poll(() => page.evaluate(() => !!(window as unknown as HarnessWindow).workspaceKeysHarness.frame)).toBe(true);
      await page.evaluate(() => (window as unknown as HarnessWindow).workspaceKeysHarness.inspectControls());
      await waitInspection(0);
      // Same callback/render: React has not committed focusBusy/focusBlocked yet.
      const rapid = await page.evaluate(({ snapshotId, controlId, names }) => {
        const workspace = (window as unknown as HarnessWindow).workspaceKeysHarness; workspace.focusControl(snapshotId, controlId);
        return [...names.map(key => workspace.send({ type: 'key', key })), workspace.send({ type: 'text', text: 'synthetic-unconfirmed-input' })];
      }, { snapshotId, controlId, names: blockedKeys });
      expect(rapid).toEqual(Array(6).fill(false)); await expect.poll(() => focusStarted).toBe(1);
      expect(await tryBlocked()).toEqual(Array(6).fill(false)); expect(keys).toEqual([]); expect(textInputs).toBe(0);
      // Refresh explicitly abandons this pending focus. Its genuine later
      // acknowledgement must not unlock keys for the new inspection.
      await page.evaluate(() => (window as unknown as HarnessWindow).workspaceKeysHarness.inspectControls());
      expect(await tryBlocked()).toEqual(Array(6).fill(false));
      releaseFocus();
      await expect.poll(() => acknowledgements).toBe(1); await waitInspection(1);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).workspaceKeysHarness.focusBlocked)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).workspaceKeysHarness.focusedControl)).toBeNull();
      expect(await tryBlocked()).toEqual(Array(6).fill(false));
      focusMode = 'fail';
      await page.evaluate(({ snapshotId, controlId }) => (window as unknown as HarnessWindow).workspaceKeysHarness.focusControl(snapshotId, controlId), { snapshotId, controlId });
      await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).workspaceKeysHarness.controlsError)).toContain('The requested action was not accepted');
      expect(await tryBlocked()).toEqual(Array(6).fill(false));
      await page.evaluate(() => (window as unknown as HarnessWindow).workspaceKeysHarness.inspectControls());
      await waitInspection(2);
      expect(await tryBlocked()).toEqual(Array(6).fill(false));
      const socketCount = await page.evaluate(() => (window as unknown as HarnessWindow).workspaceKeysSocketCount);
      await page.evaluate(() => (window as unknown as HarnessWindow).workspaceKeysSocket.close(1000, 'Synthetic reconnect'));
      await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).workspaceKeysSocketCount), { timeout: 5000 }).toBeGreaterThan(socketCount);
      await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).workspaceKeysHarness.status), { timeout: 5000 }).toBe('connected');
      await expect.poll(() => page.evaluate(() => !!(window as unknown as HarnessWindow).workspaceKeysHarness.frame)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).workspaceKeysHarness.focusBlocked)).toBe(true);
      expect(await tryBlocked()).toEqual(Array(6).fill(false)); expect(keys).toEqual([]); expect(textInputs).toBe(0);
      expect(await remote.locator('#target').isChecked()).toBe(false);
      await page.evaluate(() => (window as unknown as HarnessWindow).workspaceKeysHarness.inspectControls());
      await waitInspection(3);
      focusMode = 'success';
      const beforeAcknowledgement = await page.evaluate(({ snapshotId, controlId, names }) => {
        const workspace = (window as unknown as HarnessWindow).workspaceKeysHarness; workspace.focusControl(snapshotId, controlId);
        return [...names.map(key => workspace.send({ type: 'key', key })), workspace.send({ type: 'text', text: 'synthetic-unconfirmed-input' })];
      }, { snapshotId, controlId, names: blockedKeys });
      expect(beforeAcknowledgement).toEqual(Array(6).fill(false));
      await expect.poll(() => acknowledgements).toBe(2);
      await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).workspaceKeysHarness.focusBlocked)).toBe(false);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).workspaceKeysHarness.focusedControl?.controlId)).toBe(controlId);
      expect(await page.evaluate(() => (window as unknown as HarnessWindow).workspaceKeysHarness.send({ type: 'key', key: 'Space' }))).toBe(true);
      await expect.poll(() => remote.locator('#target').isChecked()).toBe(true); expect(keys).toEqual(['Space']); expect(textInputs).toBe(0);
    } finally { releaseFocus(); await context.close(); await bridge.close(); if (!remote.isClosed()) await remote.close(); await harness.close(); }
  });
});
