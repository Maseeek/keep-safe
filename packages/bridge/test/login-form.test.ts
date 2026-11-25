import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createBridge } from '../src/server';
import { BridgeClient } from '../../mcp/src/client';
import type { FormState, ServerMessage } from '../../shared/src/protocol';

const ownerToken = 'form-test-owner';
const agentToken = 'form-test-agent';

async function startMultiStepFixture() {
  let step1Trusted = false;
  let step2Trusted = false;
  let otpTrusted = false;
  let loginCount = 0;
  let mode: 'two-step-otp' | 'push-challenge' = 'two-step-otp';

  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (req.url === '/login') {
      res.end(`<!doctype html><html><head><title>Step 1</title></head><body>
        <h1>Sign in</h1>
        <form id="step1" method="post" action="/step2">
          <label for="email">Email address</label>
          <input id="email" name="email" type="email" autocomplete="username" required>
          <button type="submit">Next</button>
        </form>
        <script>
          let trusted = false;
          document.getElementById('email').addEventListener('keydown', e => { if (e.isTrusted) trusted = true; });
          document.getElementById('step1').addEventListener('submit', e => {
            e.preventDefault();
            fetch('/mark?step=1&trusted=' + (trusted ? '1' : '0')).then(() => { location.href = '/password'; });
          });
        </script>
      </body></html>`);
      return;
    }

    if (req.url === '/password') {
      res.end(`<!doctype html><html><head><title>Step 2</title></head><body>
        <h1>Enter password</h1>
        <form id="step2" method="post" action="/verify">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
          <button type="submit">Sign in</button>
        </form>
        <script>
          let trusted = false;
          document.getElementById('password').addEventListener('keydown', e => { if (e.isTrusted) trusted = true; });
          document.getElementById('step2').addEventListener('submit', e => {
            e.preventDefault();
            fetch('/mark?step=2&trusted=' + (trusted ? '1' : '0')).then(() => { location.href = '${mode === 'push-challenge' ? '/challenge' : '/otp'}'; });
          });
        </script>
      </body></html>`);
      return;
    }

    if (req.url === '/otp') {
      res.end(`<!doctype html><html><head><title>2FA</title></head><body>
        <h1>Verify it's you</h1>
        <form id="step3" method="post" action="/complete">
          <label for="otp">Verification code</label>
          <input id="otp" name="otp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
          <button type="submit">Verify</button>
        </form>
        <script>
          let trusted = false;
          document.getElementById('otp').addEventListener('keydown', e => { if (e.isTrusted) trusted = true; });
          document.getElementById('step3').addEventListener('submit', e => {
            e.preventDefault();
            fetch('/mark?step=3&trusted=' + (trusted ? '1' : '0')).then(() => { location.href = '/complete'; });
          });
        </script>
      </body></html>`);
      return;
    }

    if (req.url === '/challenge') {
      res.end(`<!doctype html><html><head><title>Confirm on phone</title></head><body>
        <h1>Check your phone</h1>
        <p>Tap Yes on your phone and match number 42 to approve the sign-in.</p>
      </body></html>`);
      return;
    }

    if (req.url?.startsWith('/mark?')) {
      const parsed = new URL(req.url, 'http://localhost');
      const trusted = parsed.searchParams.get('trusted') === '1';
      if (parsed.searchParams.get('step') === '1') step1Trusted = trusted;
      if (parsed.searchParams.get('step') === '2') step2Trusted = trusted;
      if (parsed.searchParams.get('step') === '3') otpTrusted = trusted;
      res.end('ok');
      return;
    }

    if (req.url === '/complete') {
      loginCount++;
      res.writeHead(303, { Location: '/account', 'Set-Cookie': 'multi_step=ok; HttpOnly; Path=/' });
      res.end();
      return;
    }

    if (req.url === '/account' && req.headers.cookie?.includes('multi_step=ok')) {
      res.end('<!doctype html><html><head><title>Account</title></head><body><h1>Welcome back</h1></body></html>');
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    setMode(next: 'two-step-otp' | 'push-challenge') { mode = next; },
    get trusted() { return { step1: step1Trusted, step2: step2Trusted, otp: otpTrusted }; },
    get loginCount() { return loginCount; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function connectOwner(bridgeUrl: string) {
  const ws = new WebSocket(bridgeUrl.replace(/^http/, 'ws') + '/ws');
  const received: ServerMessage[] = [];
  const listeners = new Set<(message: ServerMessage) => void>();
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(String(data)) as ServerMessage;
    received.push(message);
    for (const listener of [...listeners]) listener(message);
  });
  const waitFor = <T extends ServerMessage>(predicate: (message: ServerMessage) => message is T, timeoutMs = 10_000) =>
    new Promise<T>((resolve, reject) => {
      const existing = received.find(predicate);
      if (existing) { resolve(existing); return; }
      const timer = setTimeout(() => { listeners.delete(onMessage); reject(new Error('Timed out waiting for socket message.')); }, timeoutMs);
      const onMessage = (message: ServerMessage) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        listeners.delete(onMessage);
        resolve(message);
      };
      listeners.add(onMessage);
    });
  return {
    ws,
    waitFor,
    send(payload: Record<string, unknown>) { ws.send(JSON.stringify(payload)); },
    async ready() {
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      ws.send(JSON.stringify({ type: 'auth', token: ownerToken }));
      return waitFor((m): m is Extract<ServerMessage, { type: 'ready' }> => m.type === 'ready');
    },
    close() { ws.close(); },
  };
}

describe('guided form-first sign-in over bridge WebSocket', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

  it('completes a two-step login + OTP with trusted keystrokes, rejects wrong origin, and hands back an authenticated browser', async () => {
    const fixture = await startMultiStepFixture(); cleanups.push(() => fixture.close());
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, allowLocalUrls: true }); cleanups.push(() => bridge.close());
    const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const req = await client.create({ agent: 'Form Test', title: 'Multi-step sign-in', url: `${fixture.origin}/login`, ttlSeconds: 120 });

    const approve = await fetch(`${bridge.url}/api/requests/${req.id}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(approve.ok).toBe(true);

    const owner = connectOwner(bridge.url); cleanups.push(async () => owner.close());
    const ready = await owner.ready();
    expect(ready.info.formFillAvailable).toBe(true);
    owner.send({ type: 'watch', requestId: req.id });

    const initial = await owner.waitFor((m): m is Extract<ServerMessage, { type: 'form-state' }> => m.type === 'form-state' && m.state.stage === 'credentials');
    expect(initial.state.origin).toBe(fixture.origin);
    expect(initial.state.fields.map(f => f.kind)).toEqual(['email']);

    // Origin mismatch must be refused without typing anything.
    const badSubmitId = '11111111-1111-4111-8111-111111111111';
    owner.send({ type: 'form-submit', submitId: badSubmitId, expectedOrigin: 'https://wrong.example', values: [{ kind: 'email', value: 'user@example.invalid' }, { kind: 'password', value: 'synthetic-pass' }] });
    const refused = await owner.waitFor((m): m is Extract<ServerMessage, { type: 'form-result' }> => m.type === 'form-result' && m.submitId === badSubmitId);
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('address changed');
    expect(fixture.trusted.step1).toBe(false);

    // Submit both email and password together: bridge automatically completes Step 1 -> Step 2 and stops at OTP!
    const credSubmitId = '22222222-2222-4222-8222-222222222222';
    owner.send({ type: 'form-submit', submitId: credSubmitId, expectedOrigin: fixture.origin, values: [{ kind: 'email', value: 'user@example.invalid' }, { kind: 'password', value: 'synthetic-secret-99' }] });
    const afterCreds = await owner.waitFor((m): m is Extract<ServerMessage, { type: 'form-result' }> => m.type === 'form-result' && m.submitId === credSubmitId, 15_000);
    expect(afterCreds.ok).toBe(true);
    expect(afterCreds.state.stage).toBe('otp');
    expect(afterCreds.state.fields.map(f => f.kind)).toEqual(['otp']);
    expect(fixture.trusted.step1).toBe(true);
    expect(fixture.trusted.step2).toBe(true);

    // Submit OTP -> transitions to signed-in!
    const otpSubmitId = '33333333-3333-4333-8333-333333333333';
    owner.send({ type: 'form-submit', submitId: otpSubmitId, expectedOrigin: fixture.origin, values: [{ kind: 'otp', value: '482910' }] });
    const afterOtp = await owner.waitFor((m): m is Extract<ServerMessage, { type: 'form-result' }> => m.type === 'form-result' && m.submitId === otpSubmitId, 15_000);
    expect(afterOtp.ok).toBe(true);
    expect(afterOtp.state.stage).toBe('signed-in');
    expect(fixture.trusted.otp).toBe(true);
    expect(fixture.loginCount).toBe(1);

    // Hand back and verify the agent gets the authenticated session.
    const complete = await fetch(`${bridge.url}/api/requests/${req.id}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(complete.ok).toBe(true);
    const result = await client.get(req.id);
    expect(result.status).toBe('completed');
    const agentBrowser = await chromium.connectOverCDP(result.browser!.cdpUrl);
    try {
      const account = agentBrowser.contexts().flatMap(c => c.pages()).find(p => p.url() === `${fixture.origin}/account`);
      expect(account).toBeDefined();
      expect(await account!.locator('h1').textContent()).toBe('Welcome back');
    } finally {
      await agentBrowser.close();
    }
  }, 60_000);

  it('detects a push-2FA challenge without leaking page text', async () => {
    const fixture = await startMultiStepFixture(); cleanups.push(() => fixture.close());
    fixture.setMode('push-challenge');
    const bridge = await createBridge({ ownerToken, agentToken, port: 0, allowLocalUrls: true }); cleanups.push(() => bridge.close());
    const client = new BridgeClient({ url: bridge.url, token: agentToken });
    const req = await client.create({ agent: 'Challenge Test', title: 'Push 2FA sign-in', url: `${fixture.origin}/login`, ttlSeconds: 120 });

    await fetch(`${bridge.url}/api/requests/${req.id}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, body: '{}' });
    const owner = connectOwner(bridge.url); cleanups.push(async () => owner.close());
    await owner.ready();
    owner.send({ type: 'watch', requestId: req.id });
    await owner.waitFor((m): m is Extract<ServerMessage, { type: 'form-state' }> => m.type === 'form-state' && m.state.stage === 'credentials');

    const submitId = '44444444-4444-4444-8444-444444444444';
    owner.send({ type: 'form-submit', submitId, expectedOrigin: fixture.origin, values: [{ kind: 'email', value: 'user@example.invalid' }, { kind: 'password', value: 'synthetic-secret-99' }] });
    const result = await owner.waitFor((m): m is Extract<ServerMessage, { type: 'form-result' }> => m.type === 'form-result' && m.submitId === submitId, 20_000);
    expect(result.ok).toBe(true);
    expect(result.state.stage).toBe('challenge');
    // Generic guidance only: never leaks raw page content like the number 42 in the state metadata.
    expect(result.state.hint).not.toContain('42');
    expect(JSON.stringify(result.state)).not.toContain('synthetic-secret-99');
  }, 60_000);
});
