import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('inspects, focuses and clears nested open-root controls through the production tsx loader', async () => {
  const source = `
import assert from 'node:assert/strict';
import { openBrowser } from './packages/bridge/src/browser.ts';
import { chromium } from 'playwright';
import { startShadowLoginFixture } from './tests/fixtures/shadow-login-site.ts';
const site = await startShadowLoginFixture();
let session;
try {
  session = await openBrowser({ url: site.origin + '/login', allowLocalUrls: true });
  let controls = await session.inspectControls();
  const email = controls.controls.find(control => control.name === 'Component email');
  assert(email);
  await session.input({ type: 'focus', snapshotId: controls.snapshotId, controlId: email.id });
  await session.input({ type: 'text', text: 'runtime@example.invalid' });
  controls = await session.inspectControls();
  const password = controls.controls.find(control => control.name === 'Synthetic component password');
  assert(password && password.protected);
  await session.input({ type: 'focus', snapshotId: controls.snapshotId, controlId: password.id });
  await session.input({ type: 'text', text: 'synthetic-runtime-password' });
  controls = await session.inspectControls();
  assert(!JSON.stringify(controls).includes('runtime@example.invalid'));
  assert(!JSON.stringify(controls).includes('synthetic-runtime-password'));
  const submit = controls.controls.find(control => control.name === 'Sign in component');
  assert(submit);
  await session.input({ type: 'focus', snapshotId: controls.snapshotId, controlId: submit.id });
  assert.equal(site.loginCount, 0);
  await session.input({ type: 'key', key: 'Enter' });
  const deadline = Date.now() + 3000;
  while (!site.readyCount && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(site.loginCount, 1);
  assert.equal(site.readyCount, 1);
  await session.prepareHandoff();
  const assertion = await chromium.connectOverCDP(session.cdpUrl);
  try {
    const page = assertion.contexts().flatMap(context => context.pages()).find(page => page.url() === site.origin + '/login');
    assert(page);
    assert(await page.locator('input[type=password]').evaluate(input => input.value === ''));
  } finally { await assertion.close(); }
  console.log('runtime-controls-ok');
} finally { await session?.close(); await site.close(); }
`;
  const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), '--input-type=module'], { cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  child.stdin.end(source);
  try {
    const code = await exited;
    expect(code, code === 0 ? '' : stderr.slice(-1500)).toBe(0);
    expect(stdout.trim()).toBe('runtime-controls-ok');
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
