import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { BridgeClient } from './client';
import { createMcpServer } from './server';

describe('MCP wire compatibility', () => {
  it('advertises the tools and carries a request through the official MCP client', async () => {
    const bridge = new BridgeClient({ url: 'http://127.0.0.1:4318', token: 'agent-token', fetch: async (_url, init) => {
      const input = JSON.parse(String(init?.body));
      expect(input.cdpUrl).toBe('http://127.0.0.1:9222');
      expect(input.ttlSeconds).toBe(600);
      return Response.json({ id: 'test-request', ...input, status: 'pending' });
    } });
    const server = createMcpServer(bridge);
    const client = new Client({ name: 'generic-agent-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toEqual(['request_login', 'get_login_request', 'wait_for_login']);
      const response = await client.callTool({ name: 'request_login', arguments: { agent: 'Any MCP client', title: 'Sign in', url: 'https://example.com/login', cdp_url: 'http://127.0.0.1:9222', ttl_seconds: 600 } });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ request: { id: 'test-request', status: 'pending' } });
    } finally { await client.close(); await server.close(); }
  });
});
