import { afterEach, describe, expect, it, vi } from 'vitest';
import http, { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { BridgeAuthError, BridgeClient } from './client.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function endpoint(host: string, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { server, port: (server.address() as { port: number }).port };
}

describe('agent bridge client', () => {
  it.each(['127.0.0.1', 'localhost', '[::1]'])('keeps %s bearer requests direct despite proxy-capable global transports', async host => {
    let proxyRequests = 0; let directRequests = 0;
    const proxy = await endpoint('127.0.0.1', (_request, response) => { proxyRequests++; response.end('{"id":"proxy","status":"denied"}'); });
    const bridge = await endpoint(host === '[::1]' ? '::1' : host, (request, response) => {
      directRequests++;
      expect(request.headers.authorization).toBe('Bearer synthetic-agent-token');
      expect(request.url).toBe('/api/requests/test');
      response.end('{"id":"direct","status":"denied"}');
    });
    const original = http.globalAgent;
    const proxyAgent = new http.Agent({ keepAlive: false });
    // Simulate a globally configured proxy on Node20 too, without requiring a newer runtime.
    proxyAgent.createConnection = () => connect(proxy.port, '127.0.0.1');
    http.globalAgent = proxyAgent;
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { proxyRequests++; return Response.json({ id: 'proxy', status: 'denied' }); });
    try {
      const client = new BridgeClient({ url: `http://${host}:${bridge.port}`, token: 'synthetic-agent-token' });
      expect((await client.get('test')).id).toBe('direct');
      expect(directRequests).toBe(1); expect(proxyRequests).toBe(0); expect(globalFetch).not.toHaveBeenCalled();
    } finally { http.globalAgent = original; proxyAgent.destroy(); }
  });

  it('preserves the default fetch transport for remote HTTPS bridges', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'https', status: 'denied' }));
    const client = new BridgeClient({ url: 'https://bridge.example.com', token: 'synthetic-agent-token' });
    expect((await client.get('test')).id).toBe('https');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer synthetic-agent-token' } });
  });

  it('does not follow local redirects or forward credentials to their destination', async () => {
    let destinationRequests = 0;
    const destination = await endpoint('127.0.0.1', (_request, response) => { destinationRequests++; response.end('{"id":"redirected"}'); });
    const redirect = await endpoint('127.0.0.1', (_request, response) => { response.writeHead(302, { Location: `http://127.0.0.1:${destination.port}/private-destination` }); response.end('private-redirect-body'); });
    const client = new BridgeClient({ url: `http://127.0.0.1:${redirect.port}`, token: 'synthetic-agent-token' });
    await expect(client.get('test')).rejects.toThrow('Cannot reach the Keep Safe bridge');
    expect(destinationRequests).toBe(0);
  });

  it('keeps the 15-second timeout active until a local response body finishes', async () => {
    const bridge = await endpoint('127.0.0.1', (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"private-body-marker":'); });
    const original = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(delay => { expect(delay).toBe(15000); return original(25); });
    const client = new BridgeClient({ url: `http://127.0.0.1:${bridge.port}`, token: 'synthetic-agent-token' });
    await expect(client.get('test')).rejects.toThrow('Cannot reach the Keep Safe bridge');
    expect(timeout).toHaveBeenCalledOnce();
  });

  it('sanitizes malformed successful local responses', async () => {
    const bridge = await endpoint('127.0.0.1', (_request, response) => response.end('private-body-marker-not-json'));
    const client = new BridgeClient({ url: `http://127.0.0.1:${bridge.port}`, token: 'synthetic-agent-token' });
    const failure = await client.get('test').catch(error => error);
    expect(failure.message).toBe('Bridge returned an unreadable response. Check the bridge URL and status.');
  });

  it('preserves local POST JSON and status-specific errors without reading error pages', async () => {
    let body = ''; let calls = 0;
    const bridge = await endpoint('127.0.0.1', (request, response) => {
      calls++;
      if (request.method === 'POST') {
        expect(request.headers['content-type']).toBe('application/json');
        request.on('data', data => { body += data; });
        request.on('end', () => { response.writeHead(201).end('{"id":"created","status":"pending"}'); });
      } else { response.writeHead(403); response.write('private-error-body'); }
    });
    const client = new BridgeClient({ url: `http://127.0.0.1:${bridge.port}`, token: 'synthetic-agent-token' });
    const input = { agent: 'Test', title: 'Sign in', url: 'https://example.com/login' };
    expect((await client.create(input)).id).toBe('created');
    expect(JSON.parse(body)).toEqual(input);
    await expect(client.get('test')).rejects.toThrow(BridgeAuthError);
    expect(calls).toBe(2);
  });

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
    await expect(client.get('test')).rejects.toThrow(BridgeAuthError);
    await expect(client.get('test')).rejects.not.toThrow('secret internal body');
  });

  it('returns a terminal denied status immediately rather than retrying', async () => {
    let calls = 0;
    const client = new BridgeClient({ url: 'http://localhost:4318', token: 'secret', fetch: async () => { calls++; return Response.json({ id: 'test', status: 'denied' }); } });
    expect((await client.wait('test')).status).toBe('denied');
    expect(calls).toBe(1);
  });
});

describe('agent long polling client', () => {
  it('long polls with the last seen update and returns as soon as the request ends', async () => {
    const urls: string[] = []; const timeouts: number[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(delay => { timeouts.push(delay); return original(delay); });
    const replies = [
      { id: 'test', status: 'approved', updatedAt: 'one' },
      { id: 'test', status: 'active', updatedAt: 'two' },
      { id: 'test', status: 'completed', updatedAt: 'three' },
    ];
    const client = new BridgeClient({ url: 'http://127.0.0.1:4318', token: 'secret', fetch: async url => { urls.push(String(url)); return Response.json(replies.shift()); } });
    const started = Date.now();
    expect((await client.wait('test', 120)).status).toBe('completed');
    // Only the first quick answer pauses: without a baseline it may come from a bridge that ignores wait.
    expect(Date.now() - started).toBeLessThan(2500);
    expect(urls.map(url => new URL(url).search)).toEqual(['?wait=30', '?wait=30&since=one', '?wait=30&since=two']);
    expect(timeouts).toEqual([45000, 45000, 45000]);
  });

  it('keeps the earlier cadence against a bridge that ignores the wait parameter', async () => {
    let calls = 0;
    const client = new BridgeClient({ url: 'http://127.0.0.1:4318', token: 'secret', fetch: async () => { calls++; return Response.json({ id: 'test', status: 'pending', updatedAt: 'same' }); } });
    expect((await client.wait('test', 2)).status).toBe('pending');
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(3);
  });

  it('cancels a held long poll', async () => {
    const controller = new AbortController();
    const client = new BridgeClient({ url: 'http://127.0.0.1:4318', token: 'secret', fetch: (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) });
    const waiting = client.wait('test', 60, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(waiting).rejects.toThrow('Wait cancelled.');
  });
});
