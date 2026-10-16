import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { agentConfig } from '../scripts/agent-config';

it('launches the generated MCP config from another working directory and reports a real denied handoff', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'keep-safe-stdio-'));
  const bridge = await createBridge({ ownerToken: 'stdio-owner-test', agentToken: 'stdio-agent-test', port: 0 });
  await writeFile(resolve(directory, 'config.json'), JSON.stringify({ agentToken: 'stdio-agent-test' }), { mode: 0o600 });
  const config = JSON.parse(agentConfig('generic')).mcpServers['keep-safe'];
  const client = new Client({ name: 'stdio-integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: config.command, args: config.args, cwd: directory,
    env: { ...config.env, KEEP_SAFE_CONFIG_DIR: directory, KEEP_SAFE_BRIDGE_URL: bridge.url },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const created = await client.callTool({ name: 'request_login', arguments: { agent: 'Stdio test', title: 'Test request', url: 'https://example.com/login' } });
    expect(created.isError).not.toBe(true);
    const result = created.structuredContent as { request: { id: string; status: string } };
    expect(result.request.status).toBe('pending');
    const denied = await fetch(`${bridge.url}/api/requests/${result.request.id}/deny`, { method: 'POST', headers: { Authorization: 'Bearer stdio-owner-test' } });
    expect(denied.status).toBe(200);
    const checked = await client.callTool({ name: 'get_login_request', arguments: { request_id: result.request.id } });
    expect(checked.structuredContent).toMatchObject({ request: { status: 'denied' } });
  } finally { await client.close(); await transport.close(); await bridge.close(); await rm(directory, { recursive: true, force: true }); }
});
