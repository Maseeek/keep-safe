import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { browserAvailable, openBrowser } from '../src/browser';
import type { PageControlsSnapshot } from '../../shared/src/protocol';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const installed = await browserAvailable();
async function fixture(html: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const server = createServer((request, response) => { response.setHeader('Content-Type', 'text/html'); for (const [name, value] of Object.entries(headers)) response.setHeader(name, value); response.end(extra[request.url ?? ''] ?? html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const session = await openBrowser({ url: origin + '/login', allowLocalUrls: true });
  cleanup.push(() => session.close());
  // This privileged connection is used only to assert synthetic fixture behavior.
  const assertionBrowser = await chromium.connectOverCDP(session.cdpUrl!); cleanup.push(() => assertionBrowser.close());
  const page = assertionBrowser.contexts().flatMap(context => context.pages()).find(page => page.url() === origin + '/login')!;
  return { origin, page, session };
}
function control(snapshot: PageControlsSnapshot, name: string) { const result = snapshot.controls.find(control => control.name === name); expect(result, `Control ${name}`).toBeDefined(); return result!; }
const focus = (test: Awaited<ReturnType<typeof fixture>>, snapshot: PageControlsSnapshot, name: string) => test.session.input({ type: 'focus', snapshotId: snapshot.snapshotId, controlId: control(snapshot, name).id });
const simple = '<label for="email">Email address</label><input id="email"><label for="password">Password</label><input id="password" type="password"><button id="submit">Sign in</button>';

it.skipIf(!installed)('inspects and focuses under a CSP that forbids page scripts and unsafe eval', async () => {
  const test = await fixture(simple, {}, { 'Content-Security-Policy': "default-src 'self'; script-src 'none'" });
  const snapshot = await test.session.inspectControls!(); await focus(test, snapshot, 'Email address');
  expect(await test.page.evaluate(() => document.activeElement?.id)).toBe('email');
});

it.skipIf(!installed)('extracts bounded named controls without field values, selection text, link addresses or editable descendants', async () => {
  const test = await fixture(`<label>Email address<input id="email" value="seeded-email-value"></label>
    <span id="password-label">Account password</span><input id="password" type="password" aria-labelledby="password-label" value="seeded-password-value">
    <textarea aria-label="Recovery note">seeded-textarea-value</textarea>
    <select aria-label="Workspace"><option selected>seeded-selection-value</option></select>
    <label><input type="checkbox" checked value="seeded-checkbox-value">Remember this browser</label>
    <div role="radio" aria-checked="false" tabindex="0">Personal workspace</div>
    <input placeholder="One-time code"><button disabled>Unavailable</button>
    <a href="/seeded-private-path?token=seeded-query-value#seeded-fragment-value">Help</a>
    <div role="button" tabindex="0">Safe action<textarea>seeded-wrapped-textarea</textarea><span contenteditable="true">seeded-editable-value</span><div role="textbox">seeded-aria-editable</div><span hidden>seeded-hidden-attribute</span><span inert>seeded-inert-text</span><span style="display:none">seeded-css-display</span><span style="visibility:hidden">seeded-css-visibility</span><span style="opacity:0">seeded-css-opacity</span><span aria-hidden="true">seeded-aria-hidden</span></div>
    <span id="unsafe-reference"><textarea>seeded-label-reference-value</textarea><span contenteditable>seeded-label-editable</span>Static label</span><input aria-labelledby="unsafe-reference">
    <span id="hidden-reference" hidden>seeded-hidden-label-reference</span><input aria-labelledby="hidden-reference" aria-label="Safe hidden-label fallback">
    <button style="display:none">Hidden button</button><div style="opacity:0"><button>Transparent button</button></div>`);
  const snapshot = await test.session.inspectControls!();
  expect(snapshot.origin).toBe(test.origin); expect(snapshot.snapshotId).toMatch(/^[a-f0-9-]{36}$/);
  expect(snapshot.controls.every(control => /^[a-f0-9-]{36}$/.test(control.id))).toBe(true);
  expect(control(snapshot, 'Email address')).toMatchObject({ role: 'textbox', protected: false });
  expect(control(snapshot, 'Account password')).toMatchObject({ role: 'textbox', protected: true });
  expect(control(snapshot, 'Remember this browser')).toMatchObject({ role: 'checkbox', checked: true });
  expect(control(snapshot, 'Personal workspace')).toMatchObject({ role: 'radio', checked: false });
  expect(control(snapshot, 'Workspace').role).toBe('combobox');
  expect(control(snapshot, 'Unavailable').disabled).toBe(true);
  expect(control(snapshot, 'Safe action').role).toBe('button');
  expect(control(snapshot, 'Static label').role).toBe('textbox');
  expect(control(snapshot, 'Safe hidden-label fallback').role).toBe('textbox');
  const output = JSON.stringify(snapshot);
  for (const marker of ['seeded-', 'Hidden button', 'Transparent button', '/login', 'token=']) expect(output).not.toContain(marker);
});

it.skipIf(!installed).each(['focus', 'inspection'])('keeps the %s barrier pending until busy Chromium settles and rejects expired work', async operation => {
  const test = await fixture(simple); const snapshot = await test.session.inspectControls!();
  let started!: () => void;
  const rendererStarted = new Promise<void>(resolve => { started = resolve; });
  test.page.on('console', message => { if (message.text() === 'synthetic-renderer-busy') started(); });
  const busy = test.page.evaluate(() => {
    console.debug('synthetic-renderer-busy');
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) { /* Deliberately block the renderer, not the test process. */ }
  });
  await rendererStarted;
  let settled = false;
  const pending = operation === 'focus' ? focus(test, snapshot, 'Email address') : test.session.inspectControls!();
  const outcome = pending.then(() => { settled = true; return 'accepted'; }, () => { settled = true; return 'rejected'; });
  await new Promise(resolve => setTimeout(resolve, 2200));
  expect(settled).toBe(false);
  await busy; expect(await outcome).toBe('rejected');
  expect(await test.page.evaluate(() => document.activeElement?.id)).not.toBe('email');
});

it.skipIf(!installed)('focuses only the selected field and never clicks, submits or types', async () => {
  const test = await fixture(`<form onsubmit="window.submitted=true;return false">${simple}</form><script>window.clicked=0;document.querySelector('#submit').onclick=()=>window.clicked++</script>`);
  const snapshot = await test.session.inspectControls!();
  await focus(test, snapshot, 'Email address');
  expect(await test.page.evaluate(() => document.activeElement?.id)).toBe('email');
  expect(await test.page.locator('#email').inputValue()).toBe('');
  await focus(test, snapshot, 'Sign in');
  expect(await test.page.evaluate(() => document.activeElement?.id)).toBe('submit');
  expect(await test.page.evaluate(() => ({ clicked: (window as unknown as { clicked: number }).clicked, submitted: (window as unknown as { submitted?: boolean }).submitted ?? false }))).toEqual({ clicked: 0, submitted: false });
});

it.skipIf(!installed)('rejects refreshed snapshots, detached or hidden targets and newly disabled controls', async () => {
  const test = await fixture(simple);
  const first = await test.session.inspectControls!(); const second = await test.session.inspectControls!();
  await expect(focus(test, first, 'Email address')).rejects.toThrow('stale');
  await focus(test, second, 'Email address');
  for (const change of ['remove', 'hidden', 'disabled']) {
    await test.page.goto(test.origin + '/login'); const snapshot = await test.session.inspectControls!();
    await test.page.locator('#email').evaluate((element, change) => { if (change === 'remove') element.remove(); else if (change === 'hidden') (element as HTMLElement).style.display = 'none'; else (element as HTMLInputElement).disabled = true; }, change);
    await expect(focus(test, snapshot, 'Email address')).rejects.toThrow('no longer available');
  }
});

it.skipIf(!installed)('rejects reused nodes whose label, role or password type changed before focus', async () => {
  const test = await fixture(simple);
  for (const change of ['name', 'role', 'password']) {
    await test.page.goto(test.origin + '/login'); const snapshot = await test.session.inspectControls!();
    await test.page.locator('#email').evaluate((element, change) => { if (change === 'name') element.setAttribute('aria-label', 'Different field'); else if (change === 'role') element.setAttribute('role', 'button'); else (element as HTMLInputElement).type = 'password'; }, change);
    await expect(focus(test, snapshot, 'Email address')).rejects.toThrow('no longer available');
    expect(await test.page.evaluate(() => document.activeElement?.id)).not.toBe('email');
  }
});

it.skipIf(!installed)('does not acknowledge focus after focus handlers rename the control or navigate', async () => {
  const test = await fixture(simple, { '/changed': '<h1>Changed page</h1>' });
  let snapshot = await test.session.inspectControls!();
  await test.page.locator('#email').evaluate(element => element.addEventListener('focus', () => element.setAttribute('aria-label', 'Changed by focus handler')));
  await expect(focus(test, snapshot, 'Email address')).rejects.toThrow('no longer available');
  await test.page.goto(test.origin + '/login'); snapshot = await test.session.inspectControls!();
  await test.page.locator('#email').evaluate(element => element.addEventListener('focus', () => { location.href = '/changed'; }));
  await expect(focus(test, snapshot, 'Email address')).rejects.toThrow();
  await test.page.waitForURL(test.origin + '/changed');
});

it.skipIf(!installed)('invalidates targets across navigation, popups, popup recovery and explicit handback', async () => {
  const test = await fixture(simple + '<a href="/popup" target="_blank">Open popup</a>', { '/popup': '<label>Popup email<input id="popup-email"></label>', '/other': simple });
  let snapshot = await test.session.inspectControls!();
  await test.page.goto(test.origin + '/other');
  await expect(focus(test, snapshot, 'Email address')).rejects.toThrow('stale');
  await test.page.goto(test.origin + '/login'); snapshot = await test.session.inspectControls!();
  const opened = test.page.waitForEvent('popup'); await test.page.getByRole('link', { name: 'Open popup' }).click(); const popup = await opened; await popup.waitForLoadState();
  await expect(focus(test, snapshot, 'Email address')).rejects.toThrow('stale');
  const popupSnapshot = await test.session.inspectControls!(); expect(control(popupSnapshot, 'Popup email')).toBeDefined();
  await focus(test, popupSnapshot, 'Popup email'); expect(await popup.evaluate(() => document.activeElement?.id)).toBe('popup-email');
  await popup.close();
  await expect(focus(test, popupSnapshot, 'Popup email')).rejects.toThrow('stale');
  const recovered = await test.session.inspectControls!(); await focus(test, recovered, 'Email address');
  await test.session.prepareHandoff!();
  await expect(focus(test, recovered, 'Email address')).rejects.toThrow('stale');
  await test.session.close(); await expect(test.session.inspectControls!()).rejects.toThrow('closed');
});

it.skipIf(!installed)('caps controls, candidates and names and omits iframe and shadow contents', async () => {
  const many = Array.from({ length: 210 }, (_value, index) => `<input aria-label="Field ${index}">`).join('');
  const test = await fixture(`<button aria-label="${'Long name '.repeat(50)}">Action</button>${many}<iframe srcdoc="<input aria-label='Iframe control'>"></iframe><div id="shadow"></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<input aria-label="Shadow control">'</script>`);
  const snapshot = await test.session.inspectControls!();
  expect(snapshot.controls).toHaveLength(50); expect(snapshot.truncated).toBe(true);
  expect(snapshot.controls.every(control => control.name.length <= 160)).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain('Iframe control'); expect(JSON.stringify(snapshot)).not.toContain('Shadow control');
  await test.page.locator('input').evaluateAll(elements => { for (let index = 0; index < 205; index++) (elements[index] as HTMLElement).style.display = 'none'; });
  const candidateBound = await test.session.inspectControls!();
  expect(candidateBound.controls).toHaveLength(1); expect(candidateBound.truncated).toBe(true);
});
