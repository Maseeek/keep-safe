import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('focuses cross-origin embedded controls and verifies handback through the production tsx loader', async () => {
  const source = `
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openBrowser } from './packages/bridge/src/browser.ts';
import { startFrameLoginFixture } from './tests/fixtures/frame-login-site.ts';
const site = await startFrameLoginFixture({ crossOrigin: true }); let session; let agent;
async function inspect(options, required) {
  const deadline = Date.now() + 3000; let lastError;
  while (Date.now() < deadline) {
    try {
      const snapshot = await session.inspectControls(options);
      if (snapshot.controls.some(control => control.name === required)) return snapshot;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw lastError || new Error('The expected embedded controls did not become available.');
}
try {
  session = await openBrowser({ url: site.origin + '/workspace', allowLocalUrls: true });
  const formDeadline = Date.now() + 3000;
  while (!site.formReadyCount && Date.now() < formDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(site.formReadyCount, 1);
  // Initial iframe navigation can invalidate an inspection before the form is
  // ready. Retry a fresh snapshot, as the owner can, without forcing focus.
  const legacy = await inspect(undefined, 'Top page help');
  assert(!legacy.controls.some(control => control.embedded || control.name === 'Embedded email'));
  let controls = await inspect({ includeFrames: true }, 'Embedded email');
  assert.equal(controls.origin, site.origin);
  for (const [name, text] of [['Embedded email', 'runtime-frame@example.invalid'], ['Synthetic embedded password', 'synthetic-runtime-frame-password']]) {
    const target = controls.controls.find(control => control.name === name);
    assert(target && target.embedded && target.frameOrigin === site.frameOrigin);
    await session.input({ type: 'focus', snapshotId: controls.snapshotId, controlId: target.id });
    await session.input({ type: 'text', text });
    controls = await inspect({ includeFrames: true }, 'Embedded email');
  }
  for (const excluded of ['runtime-frame@example.invalid', 'synthetic-runtime-frame-password', '/private-embedded-form', 'synthetic-query-only', 'synthetic-fragment-only', 'synthetic-link-only']) assert(!JSON.stringify(controls).includes(excluded));
  const submit = controls.controls.find(control => control.name === 'Sign in embedded page');
  assert(submit && submit.embedded);
  await session.input({ type: 'focus', snapshotId: controls.snapshotId, controlId: submit.id });
  assert.equal(site.loginCount, 0);
  await session.input({ type: 'key', key: 'Enter' });
  const readyDeadline = Date.now() + 3000;
  while (!site.readyCount && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(site.loginCount, 1); assert.equal(site.readyCount, 1);
  await session.prepareHandoff();
  agent = await chromium.connectOverCDP(session.cdpUrl);
  const page = agent.contexts().flatMap(context => context.pages()).find(page => page.url() === site.origin + '/workspace');
  assert(page);
  const frame = page.frames().find(frame => frame.url() === site.frameUrl);
  assert(frame);
  assert(await frame.locator('#password').evaluate(input => input.value === ''));
  assert.equal((await frame.goto(site.frameOrigin + '/frame-account')).status(), 200);
  await frame.goto(site.frameOrigin + '/frame-account');
  assert.equal(await frame.getByRole('heading').innerText(), 'Embedded session authenticated');
  console.log('frame-runtime-controls-ok');
} finally { await agent?.close(); await session?.close(); await site.close(); }
`;
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), '--input-type=module'], { cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000); child.stdin.end(source);
  try { expect(await exited, stderr.slice(-1500)).toBe(0); expect(stdout.trim()).toBe('frame-runtime-controls-ok'); }
  finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
