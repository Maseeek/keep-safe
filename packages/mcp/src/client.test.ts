import { describe, expect, it } from 'vitest';
import { BridgeClient } from './client.js';

describe('agent bridge client', () => {
  it('keeps credentials out of URLs and sends the separate agent bearer token', async () => {
    let received: RequestInit | undefined;
    const client = new BridgeClient({ url: 'http://127.0.0.1:4318', token: 'agent-secret', fetch: async (url, init) => {
      expect(String(url)).toBe('http://127.0.0.1:4318/api/requests');
      received = init;
      return Response.json({ id: 'test', status: 'pending' });
    } });
    await client.create({ agent: 'Test', title: 'Sign in', url: 'https://example.com/login' });
    expect(received?.headers).toMatchObject({ Authorization: 'Bearer agent-secret' });
    expect(received?.body).not.toContain('agent-secret');
  });

  it('refuses remote plaintext and URL credentials', () => {
    for (const url of ['http://bridge.example.com', 'https://user:password@example.com', 'https://bridge.example.com?token=bad']) {
      expect(() => new BridgeClient({ url, token: 'secret' })).toThrow();
    }
  });

  it('does not echo server errors or secrets', async () => {
    const client = new BridgeClient({ url: 'https://bridge.example.com', token: 'secret', fetch: async () => new Response('secret internal body', { status: 403 }) });
    await expect(client.get('test')).rejects.toThrow('Bridge rejected the agent token');
    await expect(client.get('test')).rejects.not.toThrow('secret internal body');
  });

  it('returns a terminal denied status immediately rather than retrying', async () => {
    let calls = 0;
    const client = new BridgeClient({ url: 'http://localhost:4318', token: 'secret', fetch: async () => { calls++; return Response.json({ id: 'test', status: 'denied' }); } });
    expect((await client.wait('test')).status).toBe('denied');
    expect(calls).toBe(1);
  });
});
