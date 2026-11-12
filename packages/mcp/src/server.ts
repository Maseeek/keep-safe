import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BridgeClient, type AgentRequest } from './client.js';

/** The three calls the tools need. A wrapper may restart the bridge between them. */
export type LoginClient = Pick<BridgeClient, 'create' | 'get' | 'wait'> & Partial<Pick<BridgeClient, 'status'>>;

function result(request: AgentRequest, setup?: string) {
  const instruction = request.status === 'completed'
    ? 'The owner returned control. Resume in the SAME authenticated browser context. Do not copy cookies or ask the owner for a password.'
    : request.status === 'denied' || request.status === 'expired'
      ? 'Access was denied or expired. Stop this login attempt. Do not retry without a new user request.'
      : 'The owner has not returned control yet. Stop browser input while the human is in control. Poll get_login_request or call wait_for_login. Do not ask for credentials in chat.';
  const data = { request, instruction, ...(setup ? { setup } : {}) };
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
}

export function createMcpServer(client: LoginClient) {
  const server = new McpServer({ name: 'keep-safe', version: '0.2.0' });
  server.registerTool('request_login', {
    title: 'Ask the owner to sign in',
    description: 'Hand an actual Chromium website login to the owner on their phone. Pause browser input until the owner explicitly completes the handoff. Never pass passwords, cookies, or tokens in tool arguments. For an existing browser provide its loopback CDP endpoint; otherwise Keep Safe opens a separate managed browser and returns its endpoint to the agent after approval.',
    inputSchema: {
      agent: z.string().min(1).max(80).describe('Agent name, e.g. Codex or Claude'),
      title: z.string().min(1).max(120).describe('Short human-readable task title'),
      url: z.string().url().max(2048).describe('HTTPS website login URL without credentials'),
      reason: z.string().max(500).optional(),
      cdp_url: z.string().url().max(2048).optional().describe('Existing Chromium CDP endpoint on loopback only'),
      ttl_seconds: z.number().int().min(60).max(1800).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ cdp_url, ttl_seconds, ...input }) => {
    const request = await client.create({ ...input, cdpUrl: cdp_url, ttlSeconds: ttl_seconds });
    const status = await client.status?.();
    return result(request, status?.phones === 0
      ? 'No phone is paired with this computer, so nobody will see this request. Ask the owner to run "keep-safe pair" on this computer and scan the QR code with their phone. The request stays open until it expires.'
      : status && status.notifications === 0 ? 'A phone is paired but has notifications off. Tell the owner to open Keep Safe on their phone to approve this request.' : undefined);
  });

  server.registerTool('get_login_request', {
    title: 'Check a login handoff',
    description: 'Check status and obtain the agent-only managed browser endpoint. Resume only after status completed. Denied/expired means stop. Browser credentials and page content are never returned.',
    inputSchema: { request_id: z.string().min(1).max(128) },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ request_id }) => result(await client.get(request_id)));

  server.registerTool('wait_for_login', {
    title: 'Wait for the owner',
    description: 'Wait up to 120 seconds for a login handoff to complete, expire, or be denied. If still pending, wait again. Never continue browser input while owner controls it.',
    inputSchema: { request_id: z.string().min(1).max(128), timeout_seconds: z.number().int().min(1).max(120).optional() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ request_id, timeout_seconds }, extra) => result(await client.wait(request_id, timeout_seconds, extra.signal)));
  return server;
}
