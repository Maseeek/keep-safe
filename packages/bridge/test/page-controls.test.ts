import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { browserAvailable, openBrowser } from '../src/browser';
import { createPageControls } from '../src/page-controls';
import type { PageControlsSnapshot } from '../../shared/src/protocol';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const installed = await browserAvailable();
async function fixture(html: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}, routeHeaders: Record<string, Record<string, string>> = {}) {
  const server = createServer((request, response) => { response.setHeader('Content-Type', 'text/html'); for (const [name, value] of Object.entries({ ...headers, ...routeHeaders[request.url ?? ''] })) response.setHeader(name, value); response.end(extra[request.url ?? ''] ?? html); });
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

async function embeddedFixture(crossOrigin = false, isolate = false) {
  const test = await fixture('<input aria-label="Top field" id="outside"><div id="wrapper"><iframe id="embedded" src="/child"></iframe></div>', {
    '/child': '<label>Embedded email<input id="child-email" value="seeded-child-email"></label><label>Embedded password<input type="password" value="seeded-child-password"></label><button>Embedded sign in</button><a href="/seeded-child-path?token=seeded-child-query">Embedded help</a><div id="shadow"></div>',
    '/changed': '<input aria-label="Changed embedded field">',
    '/nested': '<input aria-label="Nested embedded field">',
  });
  if (isolate) {
    const browser = await chromium.launch({ headless: true, args: ['--site-per-process'], ...(process.env.KEEP_SAFE_CHROMIUM_PATH ? { executablePath: process.env.KEEP_SAFE_CHROMIUM_PATH } : {}) });
    cleanup.push(() => browser.close());
    test.page = await browser.newPage(); await test.page.goto(test.origin + '/login');
  }
  if (crossOrigin) await test.page.locator('#embedded').evaluate((element, origin) => { (element as HTMLIFrameElement).src = origin.replace('127.0.0.1', 'localhost') + '/child'; }, test.origin);
  await test.page.frameLocator('#embedded').locator('#child-email').waitFor();
  const frame = test.page.frames().find(frame => frame.parentFrame() === test.page.mainFrame())!;
  await frame.waitForLoadState();
  const controls = createPageControls(() => test.page); cleanup.push(() => controls.clear());
  return { ...test, frame, controls };
}

it.skipIf(!installed).each([false, true])('inspects and focuses bounded embedded controls across origins (cross-origin=%s)', async crossOrigin => {
  const test = await embeddedFixture(crossOrigin, crossOrigin);
  const legacy = await test.controls.inspect();
  expect(legacy.controls.map(control => control.name)).toEqual(['Top field']);
  await test.frame.evaluate(() => { document.querySelector('#shadow')!.attachShadow({ mode: 'open' }).innerHTML = '<input id="nested-shadow" aria-label="Embedded component field" value="seeded-embedded-component">'; });
  const snapshot = await test.controls.inspect({ includeFrames: true });
  expect(snapshot.origin).toBe(test.origin); expect(snapshot.truncated).toBe(false);
  const child = control(snapshot, 'Embedded email');
  expect(child).toMatchObject({ embedded: true, frameOrigin: new URL(test.frame.url()).origin, protected: false });
  expect(control(snapshot, 'Embedded password').protected).toBe(true);
  expect(control(snapshot, 'Top field')).not.toHaveProperty('embedded');
  expect(JSON.stringify(snapshot)).not.toContain('seeded-');
  expect(JSON.stringify(snapshot)).not.toContain('/child');
  if (crossOrigin) {
    // Prove this is an out-of-process target, not just a different port/site.
    const separate = await test.page.context().newCDPSession(test.frame); await separate.detach();
    expect(child.frameOrigin).not.toBe(test.origin);
  }
  await test.controls.focus(snapshot.snapshotId, child.id);
  expect(await test.frame.evaluate(() => document.activeElement?.id)).toBe('child-email');
  expect(await test.page.evaluate(() => document.activeElement?.id)).toBe('embedded');
  await test.controls.focus(snapshot.snapshotId, control(snapshot, 'Embedded component field').id);
  expect(await test.frame.locator('#shadow').evaluate(host => host.shadowRoot!.activeElement?.id)).toBe('nested-shadow');
});

it.skipIf(!installed).each(['iframe hidden', 'ancestor inert', 'ancestor aria-hidden', 'ancestor display', 'ancestor opacity', 'ancestor aria-disabled', 'iframe disabled'])('rejects frame focus and omits controls with %s', async change => {
  const test = await embeddedFixture(); const snapshot = await test.controls.inspect({ includeFrames: true });
  await test.page.evaluate(change => {
    const frame = document.querySelector('#embedded')!; const wrapper = document.querySelector('#wrapper')!;
    if (change === 'iframe hidden') frame.setAttribute('hidden', '');
    else if (change === 'ancestor inert') wrapper.setAttribute('inert', '');
    else if (change === 'ancestor aria-hidden') wrapper.setAttribute('aria-hidden', 'true');
    else if (change === 'ancestor display') (wrapper as HTMLElement).style.display = 'none';
    else if (change === 'ancestor opacity') (wrapper as HTMLElement).style.opacity = '0';
    else if (change === 'ancestor aria-disabled') wrapper.setAttribute('aria-disabled', 'true');
    else frame.setAttribute('disabled', '');
  }, change);
  await expect(test.controls.focus(snapshot.snapshotId, control(snapshot, 'Embedded email').id)).rejects.toThrow('no longer available');
  const hidden = await test.controls.inspect({ includeFrames: true });
  expect(hidden.controls.some(control => control.embedded)).toBe(false); expect(hidden.truncated).toBe(true);
});

it.skipIf(!installed).each(['reload', 'navigation', 'replacement', 'reparent'])('rejects stale iframe targets after %s', async change => {
  const test = await embeddedFixture(); const snapshot = await test.controls.inspect({ includeFrames: true });
  if (change === 'reload') await test.frame.goto(test.frame.url());
  else if (change === 'navigation') await test.frame.goto(test.origin + '/changed');
  else await test.page.locator('#embedded').evaluate((element, change) => {
    if (change === 'replacement') element.replaceWith(element.cloneNode());
    else { const wrapper = document.createElement('div'); document.body.append(wrapper); wrapper.append(element); }
  }, change);
  await expect(test.controls.focus(snapshot.snapshotId, control(snapshot, 'Embedded email').id)).rejects.toThrow();
});

it.skipIf(!installed)('verifies composed iframe ancestry and nested deep focus', async () => {
  const test = await embeddedFixture();
  await test.page.evaluate(() => {
    const host = document.createElement('div'); host.id = 'shadow-frame-host'; document.body.append(host);
    host.attachShadow({ mode: 'open' }).append(document.querySelector('#embedded')!);
  });
  await test.page.frameLocator('#embedded').locator('#child-email').waitFor();
  const frame = test.page.frames().find(frame => frame.parentFrame() === test.page.mainFrame())!;
  await frame.evaluate(() => { const frame = document.createElement('iframe'); frame.id = 'nested'; frame.src = '/nested'; document.body.append(frame); });
  await frame.frameLocator('#nested').getByRole('textbox').waitFor();
  const snapshot = await test.controls.inspect({ includeFrames: true });
  await test.controls.focus(snapshot.snapshotId, control(snapshot, 'Nested embedded field').id);
  expect(await test.page.locator('#shadow-frame-host').evaluate(host => host.shadowRoot!.activeElement?.id)).toBe('embedded');
  expect(await frame.evaluate(() => document.activeElement?.id)).toBe('nested');
  await test.page.locator('#shadow-frame-host').evaluate(host => { const wrapper = document.createElement('div'); document.body.append(wrapper); wrapper.append(host); });
  await expect(test.controls.focus(snapshot.snapshotId, control(snapshot, 'Nested embedded field').id)).rejects.toThrow();
});

it.skipIf(!installed).each([false, true])('rejects cancelled iframe navigation intents even without a URL change (OOPIF=%s)', async isolated => {
  const test = await embeddedFixture(isolated, isolated);
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await test.controls.inspect({ includeFrames: true });
    await test.frame.locator('#child-email').evaluate(element => element.addEventListener('focus', () => { location.href = '/changed'; window.stop(); }, { once: true }));
    await expect(test.controls.focus(snapshot.snapshotId, control(snapshot, 'Embedded email').id)).rejects.toThrow();
    expect(new URL(test.frame.url()).pathname).toBe('/child');
    await test.page.locator('#outside').focus();
  }
});

it.skipIf(!installed)('rejects a local child focus that its handler moves back into the parent page', async () => {
  const test = await embeddedFixture(); const snapshot = await test.controls.inspect({ includeFrames: true });
  await test.frame.locator('#child-email').evaluate(element => element.addEventListener('focus', () => (window.parent.document.querySelector('#outside') as HTMLElement).focus()));
  await expect(test.controls.focus(snapshot.snapshotId, control(snapshot, 'Embedded email').id)).rejects.toThrow('no longer available');
  expect(await test.page.evaluate(() => document.activeElement?.id)).toBe('outside');
});

it.skipIf(!installed).each([false, true])('omits a response-sandboxed opaque frame and its HTTP descendants even if Window.origin is spoofed (%s)', async spoof => {
  const test = await fixture('<input aria-label="Top field"><iframe id="opaque" src="/opaque"></iframe>', {
    '/opaque': '<input aria-label="Opaque child field"><iframe src="/descendant"></iframe>',
    '/descendant': '<input aria-label="Opaque descendant field">',
  }, {}, { '/opaque': { 'Content-Security-Policy': 'sandbox allow-scripts' } });
  await test.page.frameLocator('#opaque').getByRole('textbox').waitFor();
  const frame = test.page.frames().find(frame => new URL(frame.url()).pathname === '/opaque')!;
  expect(await test.page.locator('#opaque').getAttribute('sandbox')).toBeNull();
  expect(await frame.evaluate(expected => globalThis.origin === expected, test.origin)).toBe(false);
  if (spoof) await frame.evaluate(() => Object.defineProperty(globalThis, 'origin', { configurable: true, value: location.origin }));
  const controls = createPageControls(() => test.page); cleanup.push(() => controls.clear());
  const snapshot = await controls.inspect({ includeFrames: true });
  expect(snapshot.controls.map(control => control.name)).toEqual(['Top field']); expect(snapshot.truncated).toBe(true);
});

it.skipIf(!installed)('uses browser-reported origins without reading a page-overridden Window.origin', async () => {
  const test = await embeddedFixture(); const snapshot = await test.controls.inspect({ includeFrames: true });
  await test.frame.evaluate(() => Object.defineProperty(globalThis, 'origin', { configurable: true, get() { throw new Error('seeded-sensitive-overridden-origin'); } }));
  await test.controls.focus(snapshot.snapshotId, control(snapshot, 'Embedded email').id);
  const refreshed = await test.controls.inspect({ includeFrames: true });
  expect(refreshed.controls.some(control => control.embedded)).toBe(true); expect(refreshed.truncated).toBe(false);
  expect(JSON.stringify(refreshed)).not.toContain('seeded-');
});

it.skipIf(!installed)('omits ambiguous duplicate child URLs if any browser security origin is opaque', async () => {
  const test = await fixture('<input aria-label="Top field"><iframe id="normal" src="/same#normal"></iframe><iframe id="opaque" sandbox="allow-scripts" src="/same#opaque"></iframe>', { '/same': '<input aria-label="Ambiguous child field">' });
  await test.page.frameLocator('#normal').getByRole('textbox').waitFor();
  await test.page.frameLocator('#opaque').getByRole('textbox').waitFor();
  const controls = createPageControls(() => test.page); cleanup.push(() => controls.clear());
  const snapshot = await controls.inspect({ includeFrames: true });
  expect(snapshot.controls.map(control => control.name)).toEqual(['Top field']); expect(snapshot.truncated).toBe(true);
});

it.skipIf(!installed)('shares the 50-control cap across the top page and embedded pages', async () => {
  const fields = (name: string) => Array.from({ length: 30 }, (_value, index) => `<input aria-label="${name} ${index}" value="seeded-bounded-value">`).join('');
  const test = await fixture(`${fields('Top')}<iframe src="/child"></iframe><iframe src="/child"></iframe>`, { '/child': fields('Child') });
  for (const frame of test.page.frames()) await frame.waitForLoadState();
  const controls = createPageControls(() => test.page); cleanup.push(() => controls.clear());
  const snapshot = await controls.inspect({ includeFrames: true });
  expect(snapshot.controls).toHaveLength(50); expect(snapshot.truncated).toBe(true);
  expect(snapshot.controls.filter(control => control.embedded)).toHaveLength(20);
  expect(JSON.stringify(snapshot)).not.toContain('seeded-');
});

it.skipIf(!installed)('bounds frame DOM inspection to 12 frames and reports omitted frames', async () => {
  const test = await fixture('<input aria-label="Top field">', { '/child': '<input aria-label="Child field">' });
  await test.page.evaluate(() => { for (let index = 0; index < 14; index++) { const frame = document.createElement('iframe'); frame.src = '/child'; document.body.append(frame); } });
  const children = test.page.frames().filter(frame => frame.parentFrame());
  for (const frame of children) {
    await frame.waitForLoadState();
    await frame.evaluate(() => {
      const original = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')!.get!;
      Object.defineProperty(Element.prototype, 'shadowRoot', { get() { document.documentElement.dataset.inspectionReads = String(Number(document.documentElement.dataset.inspectionReads || 0) + 1); return original.call(this); } });
    });
  }
  const controls = createPageControls(() => test.page); cleanup.push(() => controls.clear());
  const snapshot = await controls.inspect({ includeFrames: true });
  expect(snapshot.controls).toHaveLength(12); expect(snapshot.truncated).toBe(true);
  const inspected = await Promise.all(children.map(frame => frame.evaluate(() => Number(document.documentElement.dataset.inspectionReads || 0) > 0)));
  expect(inspected.filter(Boolean)).toHaveLength(11);
});

it.skipIf(!installed)('bounds nested frame depth and skips unsupported ancestor subtrees', async () => {
  const test = await fixture('<input aria-label="Top field"><iframe id="first" src="/child"></iframe>', { '/child': '<input aria-label="Deep field">', ...Object.fromEntries(Array.from({ length: 5 }, (_value, index) => [`/level-${index}`, '<input aria-label="Deep field">'])) });
  await test.page.frameLocator('#first').getByRole('textbox').waitFor();
  let parent = test.page.frames().find(frame => frame.parentFrame())!;
  for (let index = 0; index < 5; index++) {
    await parent.evaluate(index => { const frame = document.createElement('iframe'); frame.id = 'next'; frame.src = `/level-${index}`; document.body.append(frame); }, index);
    await parent.frameLocator('#next').getByRole('textbox').waitFor();
    parent = parent.childFrames()[0]; await parent.waitForLoadState();
  }
  const controls = createPageControls(() => test.page); cleanup.push(() => controls.clear());
  const snapshot = await controls.inspect({ includeFrames: true });
  expect(snapshot.controls).toHaveLength(5); expect(snapshot.truncated).toBe(true);
  await test.page.locator('#first').evaluate(element => element.setAttribute('sandbox', 'allow-scripts allow-same-origin'));
  const sandboxed = await controls.inspect({ includeFrames: true });
  expect(sandboxed.controls.map(control => control.name)).toEqual(['Top field']); expect(sandboxed.truncated).toBe(true);
});

it.skipIf(!installed)('omits srcdoc pages and their ordinary HTTP descendants', async () => {
  const test = await fixture('<input aria-label="Top field"><iframe id="inline"></iframe>', { '/child': '<input aria-label="HTTP descendant field">' });
  await test.page.locator('#inline').evaluate(element => { (element as HTMLIFrameElement).srcdoc = '<input aria-label="Inline child field"><iframe src="/child"></iframe>'; });
  await test.page.frameLocator('#inline').getByRole('textbox').waitFor();
  await test.page.frameLocator('#inline').frameLocator('iframe').getByRole('textbox').waitFor();
  const controls = createPageControls(() => test.page); cleanup.push(() => controls.clear());
  const snapshot = await controls.inspect({ includeFrames: true });
  expect(snapshot.controls.map(control => control.name)).toEqual(['Top field']); expect(snapshot.truncated).toBe(true);
});

it.skipIf(!installed)('keeps an OOPIF focus barrier pending through timeout and explicit invalidation', async () => {
  const test = await embeddedFixture(true, true); const snapshot = await test.controls.inspect({ includeFrames: true });
  let started!: () => void; const rendererStarted = new Promise<void>(resolve => { started = resolve; });
  test.page.on('console', message => { if (message.text() === 'synthetic-embedded-renderer-busy') started(); });
  const busy = test.frame.evaluate(() => {
    console.debug('synthetic-embedded-renderer-busy');
    const deadline = Date.now() + 3500; while (Date.now() < deadline) { /* Synthetic busy renderer. */ }
  });
  await rendererStarted;
  let settled = false;
  const outcome = test.controls.focus(snapshot.snapshotId, control(snapshot, 'Embedded email').id).then(() => { settled = true; return 'accepted'; }, () => { settled = true; return 'rejected'; });
  await new Promise(resolve => setTimeout(resolve, 2200)); await test.controls.clear();
  expect(settled).toBe(false);
  await busy; expect(await outcome).toBe('rejected');
  expect(await test.frame.evaluate(() => document.activeElement?.id)).not.toBe('child-email');
});

it.skipIf(!installed)('retains retired navigation guards until every concurrent focus operation settles', async () => {
  const test = await fixture(simple); const context = test.page.context();
  const controls = createPageControls(() => test.page); cleanup.push(() => controls.clear());
  const createSession = context.newCDPSession.bind(context); let guard!: import('playwright').CDPSession;
  const sessionSpy = vi.spyOn(context, 'newCDPSession').mockImplementation(async (...args) => { guard = await createSession(...args); return guard; });
  const snapshot = await controls.inspect(); sessionSpy.mockRestore();
  let releaseFirst!: () => void; let releaseSecond!: () => void; let enteredBoth!: () => void; let entered = 0;
  const gates = [new Promise<void>(resolve => { releaseFirst = resolve; }), new Promise<void>(resolve => { releaseSecond = resolve; })];
  const started = new Promise<void>(resolve => { enteredBoth = resolve; });
  const send = guard.send.bind(guard);
  const sendSpy = vi.spyOn(guard, 'send').mockImplementation(async (method, params) => {
    if (method === 'Runtime.evaluate' && entered < 2) { const gate = gates[entered++]; if (entered === 2) enteredBoth(); await gate; }
    return send(method, params);
  });
  const detach = vi.spyOn(guard, 'detach');
  const first = controls.focus(snapshot.snapshotId, control(snapshot, 'Email address').id).then(() => 'accepted', () => 'rejected');
  const second = controls.focus(snapshot.snapshotId, control(snapshot, 'Password').id).then(() => 'accepted', () => 'rejected');
  try {
    await started; await controls.clear(); expect(detach).not.toHaveBeenCalled();
    releaseFirst(); expect(await first).toBe('rejected'); expect(detach).not.toHaveBeenCalled();
    releaseSecond(); expect(await second).toBe('rejected'); expect(detach).toHaveBeenCalledTimes(1);
  } finally {
    releaseFirst(); releaseSecond(); await Promise.allSettled([first, second]);
    sendSpy.mockRestore(); detach.mockRestore(); sessionSpy.mockRestore();
  }
});

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
  for (let attempt = 0; attempt < 10; attempt++) {
    await test.page.goto(test.origin + '/login'); snapshot = await test.session.inspectControls!();
    await test.page.locator('#email').evaluate(element => element.addEventListener('focus', () => { location.href = '/changed'; }));
    await expect(focus(test, snapshot, 'Email address')).rejects.toThrow();
    await test.page.waitForURL(test.origin + '/changed');
  }
});

it.skipIf(!installed)('rejects focus-triggered navigation even when its request is synchronously cancelled', async () => {
  const test = await fixture(simple, { '/changed': '<h1>Changed page</h1>' });
  const controls = createPageControls(() => test.page);
  cleanup.push(() => controls.clear());
  for (let attempt = 0; attempt < 5; attempt++) {
    await test.page.goto(test.origin + '/login');
    const snapshot = await controls.inspect();
    await test.page.locator('#email').evaluate(element => element.addEventListener('focus', () => { location.href = '/changed'; window.stop(); }));
    // Cancelling in the same task preserves the URL and focused element. The
    // browser's earlier navigation intent must still invalidate this snapshot.
    await expect(controls.focus(snapshot.snapshotId, control(snapshot, 'Email address').id)).rejects.toThrow();
    expect(test.page.url()).toBe(test.origin + '/login');
  }
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

it.skipIf(!installed)('caps controls, candidates and names before later iframe and shadow contents', async () => {
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

it.skipIf(!installed)('keeps duplicate label IDs scoped to each open root and verifies nested actual focus under strict CSP', async () => {
  const test = await fixture('<span id="shared">Document field</span><span id="document-only">Wrong cross-root label</span><input aria-labelledby="shared"><div id="root-a"></div><div id="root-b"></div>', {}, { 'Content-Security-Policy': "default-src 'self'; script-src 'none'" });
  await test.page.evaluate(() => {
    const first = document.querySelector('#root-a')!.attachShadow({ mode: 'open' });
    first.innerHTML = '<span id="shared">Shadow A field</span><input aria-labelledby="shared"><label for="native">Native A label</label><input id="native"><input aria-labelledby="document-only" aria-label="Scoped fallback"><div id="nested"></div>';
    first.querySelector('#nested')!.attachShadow({ mode: 'open' }).innerHTML = '<label for="password">Nested password</label><input id="password" type="password" value="seeded-nested-password"><button id="continue">Nested continue</button>';
    document.querySelector('#root-b')!.attachShadow({ mode: 'open' }).innerHTML = '<span id="shared">Shadow B field</span><input aria-labelledby="shared"><label for="native">Native B label</label><input id="native">';
  });
  const snapshot = await test.session.inspectControls!();
  for (const name of ['Document field', 'Shadow A field', 'Shadow B field', 'Native A label', 'Native B label', 'Scoped fallback', 'Nested password', 'Nested continue']) expect(control(snapshot, name)).toBeDefined();
  expect(snapshot.truncated).toBe(false);
  expect(JSON.stringify(snapshot)).not.toContain('Wrong cross-root label');
  expect(JSON.stringify(snapshot)).not.toContain('seeded-');
  expect(control(snapshot, 'Nested password').protected).toBe(true);
  await focus(test, snapshot, 'Nested password');
  expect(await test.page.evaluate(() => {
    const outer = document.querySelector('#root-a')!;
    const nested = outer.shadowRoot!.querySelector('#nested')!;
    return document.activeElement === outer && outer.shadowRoot!.activeElement === nested && nested.shadowRoot!.activeElement?.id === 'password';
  })).toBe(true);
  expect(await test.page.locator('#password').inputValue()).toBe('seeded-nested-password');
  await focus(test, snapshot, 'Native B label');
  expect(await test.page.locator('#root-b').evaluate(host => host.shadowRoot!.activeElement?.id)).toBe('native');
});

it.skipIf(!installed)('excludes hidden or inert shadow host chains and marks disabled hosts without focusing their fields', async () => {
  const test = await fixture('<div id="outer"></div>');
  await test.page.locator('#outer').evaluate(host => { host.attachShadow({ mode: 'open' }).innerHTML = '<div id="inner"></div>'; host.shadowRoot!.querySelector('#inner')!.attachShadow({ mode: 'open' }).innerHTML = '<input aria-label="Nested field">'; });
  for (const change of ['hidden', 'inert', 'aria-hidden', 'display', 'visibility', 'opacity', 'disabled', 'aria-disabled']) {
    await test.page.locator('#outer').evaluate(host => { host.removeAttribute('hidden'); host.removeAttribute('inert'); host.removeAttribute('aria-hidden'); host.removeAttribute('disabled'); host.removeAttribute('aria-disabled'); host.removeAttribute('style'); });
    const before = await test.session.inspectControls!();
    await test.page.locator('#outer').evaluate((host, change) => {
      if (change === 'display') (host as HTMLElement).style.display = 'none';
      else if (change === 'visibility') (host as HTMLElement).style.visibility = 'hidden';
      else if (change === 'opacity') (host as HTMLElement).style.opacity = '0';
      else host.setAttribute(change, change.startsWith('aria-') ? 'true' : '');
    }, change);
    await expect(focus(test, before, 'Nested field')).rejects.toThrow('no longer available');
    const after = await test.session.inspectControls!();
    if (change === 'disabled' || change === 'aria-disabled') expect(control(after, 'Nested field').disabled).toBe(true);
    else expect(after.controls).toEqual([]);
  }
});

it.skipIf(!installed)('checks slotted composed ancestors and rejects a slot moved within its root', async () => {
  const test = await fixture('<div id="host"><input aria-label="Slotted field"></div>');
  await test.page.locator('#host').evaluate(host => { host.attachShadow({ mode: 'open' }).innerHTML = '<div id="first"><slot></slot></div><div id="second"></div>'; });
  let snapshot = await test.session.inspectControls!();
  await focus(test, snapshot, 'Slotted field');
  expect(await test.page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Slotted field');
  await test.page.locator('#first').evaluate(element => element.setAttribute('aria-hidden', 'true'));
  expect((await test.session.inspectControls!()).controls).toEqual([]);
  await test.page.locator('#first').evaluate(element => { element.removeAttribute('aria-hidden'); element.setAttribute('aria-disabled', 'true'); });
  expect(control(await test.session.inspectControls!(), 'Slotted field').disabled).toBe(true);
  await test.page.locator('#first').evaluate(element => element.removeAttribute('aria-disabled'));
  snapshot = await test.session.inspectControls!();
  await test.page.locator('#host').evaluate(host => host.shadowRoot!.querySelector('#second')!.append(host.shadowRoot!.querySelector('slot')!));
  await expect(focus(test, snapshot, 'Slotted field')).rejects.toThrow('no longer available');
});

it.skipIf(!installed)('names controls from assigned visible text and uses slot fallback only without assignments', async () => {
  const test = await fixture('<div id="host"><span slot="action">Continue</span><span slot="label">Slotted field label</span><span>seeded-unassigned-host-text</span></div><div id="open-label">seeded-unassigned-label-text</div><input aria-labelledby="open-label"><div id="closed-label">seeded-unassigned-closed-text</div><input aria-labelledby="closed-label" aria-label="Closed label fallback">');
  await test.page.evaluate(() => {
    document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML = '<button id="continue"><slot name="action">seeded-unused-button-fallback</slot></button><span id="label"><slot name="label">seeded-unused-label-fallback</slot></span><input aria-labelledby="label"><button><slot name="empty">Useful fallback action</slot></button>';
    document.querySelector('#open-label')!.attachShadow({ mode: 'open' }).innerHTML = '<span>Visible component label</span>';
    document.querySelector('#closed-label')!.attachShadow({ mode: 'closed' }).innerHTML = '<span>Closed-only label</span>';
  });
  const snapshot = await test.session.inspectControls!();
  for (const name of ['Continue', 'Slotted field label', 'Useful fallback action', 'Visible component label', 'Closed label fallback']) expect(control(snapshot, name)).toBeDefined();
  expect(snapshot.truncated).toBe(false);
  expect(JSON.stringify(snapshot)).not.toContain('seeded-');
  expect(JSON.stringify(snapshot)).not.toContain('Closed-only label');
  await focus(test, snapshot, 'Continue');
  expect(await test.page.locator('#host').evaluate(host => host.shadowRoot!.activeElement?.id)).toBe('continue');
});

it.skipIf(!installed)('excludes values and editable content across assigned label ancestors', async () => {
  const test = await fixture('<div id="host"><span slot="action">Safe action<textarea>seeded-slotted-textarea</textarea><input value="seeded-slotted-input"><span contenteditable>seeded-slotted-editable</span><span role="textbox">seeded-slotted-aria-value</span><span aria-hidden="true">seeded-slotted-hidden</span></span><span id="private-label" slot="private">seeded-slotted-private-label</span></div><input aria-labelledby="private-label" aria-label="Safe blocked-label fallback">');
  await test.page.locator('#host').evaluate(host => { host.attachShadow({ mode: 'open' }).innerHTML = '<button><slot name="action">seeded-action-fallback</slot></button><div contenteditable><slot name="private">seeded-private-fallback</slot></div>'; });
  const snapshot = await test.session.inspectControls!();
  expect(control(snapshot, 'Safe action').role).toBe('button');
  expect(control(snapshot, 'Safe blocked-label fallback').role).toBe('textbox');
  expect(JSON.stringify(snapshot)).not.toContain('seeded-');
});

it.skipIf(!installed)('bounds slot-assignment discovery without reading fallback after an incomplete scan', async () => {
  const test = await fixture('<div id="host"></div>');
  await test.page.locator('#host').evaluate(host => {
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button><slot name="action">seeded-forbidden-fallback</slot></button>';
    for (let index = 0; index < 1000; index++) { const child = document.createElement('span'); child.slot = 'other'; child.textContent = 'seeded-unassigned-text'; host.append(child); }
    const assigned = document.createElement('span'); assigned.slot = 'action'; assigned.textContent = 'Beyond label budget'; host.append(assigned);
    HTMLSlotElement.prototype.assignedNodes = () => { throw new Error('Unbounded assignment materialization is forbidden in this fixture.'); };
  });
  const snapshot = await test.session.inspectControls!();
  expect(snapshot.controls).toHaveLength(1);
  expect(snapshot.controls[0]).toMatchObject({ role: 'button', name: '' });
  expect(snapshot.truncated).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain('seeded-');
});

it.skipIf(!installed)('rejects moved or replaced shadow targets even when their role and name stay the same', async () => {
  const test = await fixture('<div id="first"></div><div id="second"></div>');
  for (const change of ['another root', 'another container', 'replaced host', 'hidden root']) {
    await test.page.goto(test.origin + '/login');
    await test.page.evaluate(() => {
      document.querySelector('#first')!.attachShadow({ mode: 'open' }).innerHTML = '<div id="a"><input aria-label="Stable field"></div><div id="b"></div>';
      document.querySelector('#second')!.attachShadow({ mode: 'open' }).innerHTML = '<div></div>';
    });
    const snapshot = await test.session.inspectControls!();
    await test.page.evaluate(change => {
      const first = document.querySelector('#first')!; const second = document.querySelector('#second')!;
      const target = first.shadowRoot!.querySelector('input')!;
      if (change === 'another container') first.shadowRoot!.querySelector('#b')!.append(target);
      else if (change === 'replaced host') {
        const replacement = first.cloneNode(false) as Element; first.replaceWith(replacement);
        replacement.attachShadow({ mode: 'open' }).innerHTML = '<input aria-label="Stable field">';
      } else {
        second.shadowRoot!.append(target);
        if (change === 'hidden root') second.setAttribute('aria-hidden', 'true');
      }
    }, change);
    await expect(focus(test, snapshot, 'Stable field')).rejects.toThrow('no longer available');
  }
});

it.skipIf(!installed)('rejects deep focus retargeting and never activates a shadow button', async () => {
  const test = await fixture('<div id="host"></div>');
  await test.page.locator('#host').evaluate(host => {
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<div id="nested"></div><input id="redirected" aria-label="Redirected field">';
    const nested = root.querySelector('#nested')!.attachShadow({ mode: 'open' });
    nested.innerHTML = '<input aria-label="Original field"><button>Shadow action</button>';
    nested.querySelector('input')!.addEventListener('focus', () => (root.querySelector('#redirected') as HTMLElement).focus());
    nested.querySelector('button')!.addEventListener('click', () => host.setAttribute('data-clicked', 'yes'));
  });
  let snapshot = await test.session.inspectControls!();
  await expect(focus(test, snapshot, 'Original field')).rejects.toThrow('no longer available');
  snapshot = await test.session.inspectControls!();
  await focus(test, snapshot, 'Shadow action');
  expect(await test.page.locator('#host').getAttribute('data-clicked')).toBeNull();
  expect(await test.page.locator('#host').evaluate(host => host.shadowRoot!.querySelector('#nested')!.shadowRoot!.activeElement?.tagName)).toBe('BUTTON');
});

it.skipIf(!installed)('does not expose editable or hidden labels, values, link destinations or closed shadow content', async () => {
  const test = await fixture('<div id="host"></div><div id="closed"></div><div id="editable" contenteditable="true"></div>');
  await test.page.evaluate(() => {
    document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML = `<label id="safe">Static shadow label<textarea>seeded-shadow-textarea</textarea><span contenteditable>seeded-shadow-editable</span><span role="textbox">seeded-shadow-aria-value</span><span aria-hidden="true">seeded-shadow-hidden</span></label><input aria-labelledby="safe" value="seeded-shadow-input"><input type="password" aria-label="Shadow password" value="seeded-shadow-password"><select aria-label="Shadow choice"><option selected>seeded-shadow-option</option></select><a href="/seeded-shadow-url?token=seeded-shadow-secret">Shadow help</a>`;
    document.querySelector('#closed')!.attachShadow({ mode: 'closed' }).innerHTML = '<input aria-label="Closed-only control" value="seeded-closed-input">';
    document.querySelector('#editable')!.attachShadow({ mode: 'open' }).innerHTML = '<span id="editable-label">seeded-host-editable-label</span><input aria-labelledby="editable-label" aria-label="Safe editable fallback">';
  });
  const snapshot = await test.session.inspectControls!();
  expect(control(snapshot, 'Static shadow label').role).toBe('textbox');
  expect(control(snapshot, 'Shadow password').protected).toBe(true);
  expect(control(snapshot, 'Safe editable fallback').role).toBe('textbox');
  expect(control(snapshot, 'Shadow help').role).toBe('link');
  const output = JSON.stringify(snapshot);
  for (const secret of ['seeded-', 'Closed-only control', 'token=', '/login']) expect(output).not.toContain(secret);
});

it.skipIf(!installed)('bounds empty open roots and total DOM nodes without materializing the whole document', async () => {
  const test = await fixture('<main></main>');
  for (const mode of ['roots', 'nodes', 'depth', 'root depth']) {
    await test.page.goto(test.origin + '/login');
    await test.page.evaluate(mode => {
      const main = document.querySelector('main')!;
      if (mode === 'root depth') {
        let root: Element | ShadowRoot = main;
        for (let index = 0; index < 30; index++) { const host = document.createElement('div'); root.append(host); root = host.attachShadow({ mode: 'open' }); }
        const tail = document.createElement('input'); tail.setAttribute('aria-label', 'Beyond shadow depth budget'); root.append(tail);
      } else if (mode === 'depth') {
        let parent = main;
        for (let index = 0; index < 90; index++) { const next = document.createElement('div'); parent.append(next); parent = next; }
        parent.innerHTML = '<input aria-label="Beyond depth budget">';
      } else {
        for (let index = 0; index < (mode === 'roots' ? 2000 : 10000); index++) {
          const host = document.createElement('div'); main.append(host);
          if (mode === 'roots') host.attachShadow({ mode: 'open' });
        }
        const tail = document.createElement('input'); tail.setAttribute('aria-label', 'Beyond traversal budget'); main.append(tail);
      }
      const original = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')!.get!;
      Object.defineProperty(Element.prototype, 'shadowRoot', { configurable: true, get() { document.documentElement.dataset.shadowReads = String(Number(document.documentElement.dataset.shadowReads || 0) + 1); return original.call(this); } });
    }, mode);
    const snapshot = await test.session.inspectControls!();
    expect(snapshot.controls).toEqual([]); expect(snapshot.truncated).toBe(true);
    const reads = Number(await test.page.locator('html').getAttribute('data-shadow-reads'));
    expect(reads).toBeLessThanOrEqual(mode === 'roots' ? 110 : mode.includes('depth') ? 70 : 3000);
  }
});

it.skipIf(!installed)('reports deadline truncation during a large DOM walk', async () => {
  const test = await fixture('<main></main>');
  await test.page.evaluate(() => {
    const main = document.querySelector('main')!;
    for (let index = 0; index < 2000; index++) main.append(document.createElement('div'));
    const start = Date.now(); let calls = 0;
    Date.now = () => { document.documentElement.dataset.clockCalls = String(++calls); return start + calls * 50; };
  });
  const snapshot = await test.session.inspectControls!();
  expect(snapshot.controls).toEqual([]); expect(snapshot.truncated).toBe(true);
  expect(Number(await test.page.locator('html').getAttribute('data-clock-calls'))).toBeLessThan(60);
});
