import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createBridge, type BridgeOptions } from '../packages/bridge/src/server';
import type { BrowserSession } from '../packages/bridge/src/browser';
import type { DevicePairResult, LoginRequest, PageControlsSnapshot, ServerMessage } from '../packages/shared/src/protocol';

const owner = 'controls-server-owner';
const agent = 'controls-server-agent';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}
async function tick() { await new Promise(resolve => setTimeout(resolve, 10)); }

async function phone(url: string, token?: string) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws');
  const messages: ServerMessage[] = [];
  let closeCode: number | undefined;
  socket.on('message', raw => messages.push(JSON.parse(raw.toString()) as ServerMessage));
  socket.on('close', code => { closeCode = code; });
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  cleanup.push(async () => { socket.terminate(); });
  const send = (message: object) => socket.send(JSON.stringify(message));
  async function next<T extends ServerMessage['type']>(type: T) {
    await expect.poll(() => messages.some(message => message.type === type), { timeout: 3000 }).toBe(true);
    return messages.splice(messages.findIndex(message => message.type === type), 1)[0] as Extract<ServerMessage, { type: T }>;
  }
  if (token) send({ type: 'auth', token });
  return { socket, messages, send, next, get closeCode() { return closeCode; } };
}

async function fixture(block: 'inspect' | 'focus' | undefined = undefined, options: Partial<BridgeOptions> = {}) {
  let clock = Date.now();
  const gate = deferred(); const started = deferred(); const finished = deferred();
  const snapshot: PageControlsSnapshot = {
    snapshotId: randomUUID(), origin: 'https://example.com', truncated: false,
    controls: Array.from({ length: 50 }, (_, index) => ({
      id: randomUUID(), role: index === 1 ? 'checkbox' : index === 2 ? 'button' : 'textbox',
      name: index === 0 ? 'Password' : `Control ${index} ${'n'.repeat(140)}`.slice(0, 160),
      protected: index === 0, disabled: index === 3, ...(index === 1 ? { checked: true } : {}),
    })),
  };
  const events: string[] = [];
  const inputs: Array<{ type: string; [key: string]: unknown }> = [];
  const inspectionOptions: Array<{ includeFrames?: boolean } | undefined> = [];
  let inspections = 0;
  let inspected = false;
  let password = 'synthetic-private-field-value';
  const browser: BrowserSession = {
    cdpUrl: 'http://127.0.0.1:9333',
    frame: async () => ({ data: 'aW1hZ2U=', width: 390, height: 720, url: 'https://example.com/login' }),
    inspectControls: async options => {
      inspectionOptions.push(options);
      inspections++; events.push('inspect started');
      if (block === 'inspect') { started.resolve(); await gate.promise; }
      inspected = true; events.push('inspect finished'); finished.resolve();
      return snapshot;
    },
    input: async input => {
      if (input.type !== 'focus' || !inspected || input.snapshotId !== snapshot.snapshotId || input.controlId !== snapshot.controls[0].id) throw new Error('Stale synthetic control.');
      inputs.push(input); events.push('focus started');
      if (block === 'focus') { started.resolve(); await gate.promise; }
      events.push('focus finished'); finished.resolve();
    },
    prepareHandoff: async () => { password = ''; events.push('password cleared'); },
    close: async () => { events.push('browser closed'); },
  };
  const bridge = await createBridge({ ownerToken: owner, agentToken: agent, port: 0, now: () => clock, expiryIntervalMs: 100_000, browserFactory: async () => browser, ...options });
  cleanup.push(() => bridge.close()); cleanup.push(async () => { gate.resolve(); });
  async function request(path: string, token = owner, method = 'GET', body?: unknown) {
    return fetch(bridge.url + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  async function create() {
    const response = await request('/api/requests', agent, 'POST', { agent: 'Synthetic controls agent', title: 'Sign in', url: 'https://example.com/login', ttlSeconds: 120 });
    expect(response.status).toBe(201); return response.json() as Promise<LoginRequest>;
  }
  async function watch(item: LoginRequest, token = owner) {
    expect((await request(`/api/requests/${item.id}/approve`, token, 'POST')).status).toBe(200);
    const client = await phone(bridge.url, token); await client.next('ready');
    client.send({ type: 'watch', requestId: item.id }); await client.next('frame');
    return client;
  }
  return { ...bridge, request, create, watch, snapshot, inputs, inspectionOptions, events, gate, started, finished, advance: (ms: number) => { clock += ms; }, get inspections() { return inspections; }, get password() { return password; } };
}

describe('page controls owner authorization and lifecycle', () => {
  it('keeps legacy dashboards main-only unless they explicitly opt into embedded-origin metadata', async () => {
    const bridge = await fixture(); const item = await bridge.create(); const controller = await bridge.watch(item);
    for (const includeFrames of [undefined, false, 'true', 1, true]) {
      controller.send({ type: 'inspect-controls', inspectionId: randomUUID(), ...(includeFrames === undefined ? {} : { includeFrames }) });
      await controller.next('controls');
    }
    expect(bridge.inspectionOptions).toEqual([
      { includeFrames: false }, { includeFrames: false }, { includeFrames: false }, { includeFrames: false }, { includeFrames: true },
    ]);
  });

  it('requires owner authentication and an active controller before inspecting any browser', async () => {
    const bridge = await fixture();
    const anonymous = await phone(bridge.url);
    anonymous.send({ type: 'inspect-controls', inspectionId: randomUUID() });
    await expect.poll(() => anonymous.closeCode).toBe(4001);
    const unauthorized = await phone(bridge.url, agent);
    await expect.poll(() => unauthorized.closeCode).toBe(4001);
    expect(unauthorized.messages).toEqual([]);
    const idle = await phone(bridge.url, owner); await idle.next('ready');
    idle.send({ type: 'inspect-controls', inspectionId: randomUUID() }); await idle.next('error');
    expect(bridge.inspections).toBe(0);
    expect(bridge.inputs).toEqual([]);
  });

  it('returns bounded metadata only to the controller and acknowledges matching focus without typing or clicking', async () => {
    const bridge = await fixture(); const item = await bridge.create();
    const controller = await bridge.watch(item);
    const observer = await phone(bridge.url, owner); await observer.next('ready');
    observer.send({ type: 'watch', requestId: item.id }); await observer.next('error');
    observer.send({ type: 'inspect-controls', inspectionId: randomUUID() }); await observer.next('error');
    const inspectionId = randomUUID();
    controller.send({ type: 'inspect-controls', inspectionId });
    const result = await controller.next('controls');
    expect(result).toEqual({ type: 'controls', requestId: item.id, inspectionId, snapshot: bridge.snapshot });
    expect(result.snapshot.controls).toHaveLength(50);
    expect(result.snapshot.controls.every(control => control.name.length <= 160)).toBe(true);
    const serialized = JSON.stringify(result);
    for (const secret of [bridge.password, 'cookie', 'cdpUrl', 'value', 'href', owner, agent]) expect(serialized).not.toContain(secret);
    expect(observer.messages.some(message => message.type === 'controls' || message.type === 'focused')).toBe(false);
    controller.send({ type: 'focus', snapshotId: bridge.snapshot.snapshotId, controlId: bridge.snapshot.controls[0].id });
    expect(await controller.next('focused')).toEqual({ type: 'focused', requestId: item.id, snapshotId: bridge.snapshot.snapshotId, controlId: bridge.snapshot.controls[0].id });
    expect(bridge.inputs).toEqual([{ type: 'focus', snapshotId: bridge.snapshot.snapshotId, controlId: bridge.snapshot.controls[0].id }]);
    expect(bridge.password).toBe('synthetic-private-field-value');
    controller.send({ type: 'unwatch' });
    controller.send({ type: 'inspect-controls', inspectionId: randomUUID() }); await controller.next('error');
    expect(bridge.inspections).toBe(1);
  });

  it('rejects malformed inspection and focus handles before invoking the browser', async () => {
    const bridge = await fixture(); const item = await bridge.create(); const controller = await bridge.watch(item);
    for (const invalid of [{ type: 'inspect-controls' }, { type: 'inspect-controls', inspectionId: 'not-a-uuid' }, { type: 'focus', snapshotId: randomUUID(), controlId: 'secret-as-selector' }]) {
      controller.send(invalid); await controller.next('error');
    }
    expect(bridge.inspections).toBe(0); expect(bridge.inputs).toEqual([]);
  });

  it('suppresses inspection metadata that finishes after the request expires', async () => {
    const bridge = await fixture('inspect'); const item = await bridge.create(); const controller = await bridge.watch(item);
    controller.send({ type: 'inspect-controls', inspectionId: randomUUID() }); await bridge.started.promise;
    bridge.advance(120_001);
    const state = await (await bridge.request('/api/requests')).json() as { requests: LoginRequest[] };
    expect(state.requests[0].status).toBe('expired');
    bridge.gate.resolve(); await bridge.finished.promise;
    controller.send({ type: 'inspect-controls', inspectionId: randomUUID() }); await controller.next('error');
    expect(controller.messages.some(message => message.type === 'controls')).toBe(false);
    expect(bridge.events).toContain('browser closed');
  });

  it('suppresses pending metadata when the controlling phone is revoked', async () => {
    const bridge = await fixture('inspect');
    const paired = await (await bridge.request('/api/devices', owner, 'POST', { name: 'Revoked controls phone' })).json() as DevicePairResult;
    const item = await bridge.create(); const controller = await bridge.watch(item, paired.token);
    controller.send({ type: 'inspect-controls', inspectionId: randomUUID() }); await bridge.started.promise;
    expect((await bridge.request(`/api/devices/${paired.device.id}/revoke`, owner, 'POST')).status).toBe(200);
    await expect.poll(() => controller.closeCode).toBe(4001);
    bridge.gate.resolve(); await bridge.finished.promise; await tick();
    expect(controller.messages.some(message => message.type === 'controls')).toBe(false);
    expect((await bridge.request('/api/info', paired.token)).status).toBe(401);
  });

  it.each([false, true])('drains inspection before handoff cleanup and suppresses its late metadata (disconnected: %s)', async disconnected => {
    const bridge = await fixture('inspect'); const item = await bridge.create(); const controller = await bridge.watch(item);
    controller.send({ type: 'inspect-controls', inspectionId: randomUUID() }); await bridge.started.promise;
    if (disconnected) { controller.socket.close(); await expect.poll(() => controller.closeCode).toBeDefined(); }
    let completed = false;
    const response = bridge.request(`/api/requests/${item.id}/complete`, owner, 'POST').then(result => { completed = true; return result; });
    // A second owner sees finalization reject a watch while inspection remains pinned.
    const observer = await phone(bridge.url, owner); await observer.next('ready');
    observer.send({ type: 'watch', requestId: item.id }); await observer.next('error');
    expect(completed).toBe(false); expect(bridge.events).toEqual(['inspect started']);
    expect((await (await bridge.request(`/api/requests/${item.id}`, agent)).json()).browser).toBeUndefined();
    bridge.gate.resolve(); expect((await response).status).toBe(200);
    expect(bridge.events).toEqual(['inspect started', 'inspect finished', 'password cleared']);
    expect(bridge.password).toBe('');
    expect((await (await bridge.request(`/api/requests/${item.id}`, agent)).json()).browser.cdpUrl).toBe('http://127.0.0.1:9333');
    expect(controller.messages.some(message => message.type === 'controls')).toBe(false);
  });

  it.each(['inspect', 'focus'] as const)('discards queued watches from a closed controller after held %s settles', async block => {
    const bridge = await fixture(block); const item = await bridge.create(); const controller = await bridge.watch(item);
    if (block === 'focus') {
      controller.send({ type: 'inspect-controls', inspectionId: randomUUID() }); await controller.next('controls');
      controller.send({ type: 'focus', snapshotId: bridge.snapshot.snapshotId, controlId: bridge.snapshot.controls[0].id });
    } else controller.send({ type: 'inspect-controls', inspectionId: randomUUID() });
    await bridge.started.promise;
    // This command reaches the queue before the close event, but cannot execute
    // until the already accepted browser operation releases its barrier.
    controller.send({ type: 'watch', requestId: item.id });
    controller.socket.close(); await expect.poll(() => controller.closeCode).toBeDefined();
    const next = await phone(bridge.url, owner); await next.next('ready');
    next.send({ type: 'watch', requestId: item.id }); await next.next('error');
    expect((await (await bridge.request(`/api/requests/${item.id}`, agent)).json()).browser).toBeUndefined();
    bridge.gate.resolve(); await bridge.finished.promise; await tick();
    next.send({ type: 'watch', requestId: item.id }); await next.next('frame');
    expect(controller.messages.some(message => message.type === 'controls' || message.type === 'focused')).toBe(false);
    expect(bridge.password).toBe('synthetic-private-field-value');
    expect((await (await bridge.request(`/api/requests/${item.id}`, agent)).json()).status).toBe('active');
  });

  it.each(['inspect', 'focus'] as const)('blocks another controller while an orphaned %s is still pending', async block => {
    const bridge = await fixture(block); const item = await bridge.create(); const controller = await bridge.watch(item);
    if (block === 'focus') {
      controller.send({ type: 'inspect-controls', inspectionId: randomUUID() }); await controller.next('controls');
      controller.send({ type: 'focus', snapshotId: bridge.snapshot.snapshotId, controlId: bridge.snapshot.controls[0].id });
    } else controller.send({ type: 'inspect-controls', inspectionId: randomUUID() });
    await bridge.started.promise;
    controller.socket.close(); await expect.poll(() => controller.closeCode).toBeDefined();
    const next = await phone(bridge.url, owner); await next.next('ready');
    next.send({ type: 'watch', requestId: item.id }); await next.next('error');
    expect(next.messages.some(message => message.type === 'frame')).toBe(false);
    bridge.gate.resolve(); await bridge.finished.promise; await tick();
    next.send({ type: 'watch', requestId: item.id }); await next.next('frame');
    expect(controller.messages.some(message => message.type === (block === 'focus' ? 'focused' : 'controls'))).toBe(false);
  });
});
