import { once } from 'node:events';
import { chromium, type Browser } from 'playwright';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { BridgeClient } from '../packages/mcp/src/client';
import type { ServerMessage } from '../packages/shared/src/protocol';
import { startLoginFixture } from './fixtures/login-site';

describe('real login handoff', () => {
  it('relays owner input, preserves the signed-in browser for the agent, and revokes owner control after completion', async () => {
    const fixture = await startLoginFixture();
    const bridge = await createBridge({ ownerToken: 'owner-test-token', agentToken: 'agent-test-token', port: 0, allowLocalUrls: true });
    const client = new BridgeClient({ url: bridge.url, token: 'agent-test-token' });
    const socket = new WebSocket(bridge.url.replace('http:', 'ws:') + '/ws');
    const inbox: ServerMessage[] = [];
    socket.on('message', raw => inbox.push(JSON.parse(raw.toString())));
    const wait = async (predicate: (message: ServerMessage) => boolean, timeout = 15000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const index = inbox.findIndex(predicate);
        if (index >= 0) return inbox.splice(index, 1)[0];
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Expected bridge message was not received.');
    };
    const send = (message: object) => socket.send(JSON.stringify(message));
    let agentBrowser: Browser | undefined;
    try {
      await once(socket, 'open');
      send({ type: 'auth', token: 'owner-test-token' });
      await wait(message => message.type === 'ready');
      const request = await client.create({ agent: 'Integration test agent', title: 'Sign in to the test workspace', url: fixture.origin + '/login', ttlSeconds: 120 });
      expect(request.status).toBe('pending');
      const approved = await fetch(`${bridge.url}/api/requests/${request.id}/approve`, { method: 'POST', headers: { Authorization: 'Bearer owner-test-token' } });
      expect(approved.status).toBe(200);
      send({ type: 'watch', requestId: request.id });
      const frame = await wait(message => message.type === 'frame');
      expect(frame.type).toBe('frame');
      if (frame.type !== 'frame') throw new Error('Expected a live frame.');
      expect(frame.data.length).toBeGreaterThan(1000);
      expect(frame.width).toBe(390);
      const activeDetail = await client.get(request.id);
      expect(activeDetail.browser).toBeUndefined();
      // Use the same owner keyboard input path as the phone, without giving the
      // agent a debugging endpoint while the owner enters credentials.
      send({ type: 'key', key: 'Tab' });
      send({ type: 'text', text: 'fixture@example.invalid' });
      send({ type: 'key', key: 'Tab' });
      send({ type: 'text', text: 'synthetic-test-only' });
      send({ type: 'key', key: 'Enter' });
      await wait(message => message.type === 'frame' && message.url.endsWith('/account'));
      const completed = await fetch(`${bridge.url}/api/requests/${request.id}/complete`, { method: 'POST', headers: { Authorization: 'Bearer owner-test-token' } });
      expect(completed.status).toBe(200);
      const result = await client.wait(request.id, 1);
      expect(result.status).toBe('completed');
      expect(result.browser?.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
      agentBrowser = await chromium.connectOverCDP(result.browser!.cdpUrl);
      const page = agentBrowser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith(fixture.origin));
      expect(page).toBeDefined();
      await page!.reload();
      expect(await page!.locator('h1').textContent()).toBe('Signed in successfully');
      inbox.length = 0;
      send({ type: 'text', text: 'must-not-be-applied' });
      await wait(message => message.type === 'error');
      expect(await page!.locator('body').textContent()).not.toContain('must-not-be-applied');
      const ownerQueue = await fetch(`${bridge.url}/api/requests`, { headers: { Authorization: 'Bearer owner-test-token' } });
      const publicData = JSON.stringify(await ownerQueue.json());
      expect(publicData).not.toContain('cdpUrl');
      expect(publicData).not.toContain('synthetic-test-only');
      expect(publicData).not.toContain('keep_safe_fixture');
    } finally {
      socket.terminate();
      await agentBrowser?.close();
      await bridge.close();
      await fixture.close();
    }
  }, 45000);
});
