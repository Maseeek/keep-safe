import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

it('launches CLI-generated custom-port/custom-directory MCP config from another working directory without env overrides', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'keep-safe-stdio with spaces-'));
  const configDirectory = resolve(directory, 'private configuration');
  const invocationDirectory = resolve(directory, 'another working directory');
  let bridge: Awaited<ReturnType<typeof createBridge>> | undefined;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    await Promise.all([mkdir(configDirectory), mkdir(invocationDirectory)]);
    bridge = await createBridge({ ownerToken: 'stdio-owner-test', agentToken: 'stdio-agent-test', port: 0 });
    await writeFile(resolve(configDirectory, 'config.json'), JSON.stringify({ agentToken: 'stdio-agent-test' }), { mode: 0o600 });
    const generated = await run(process.execPath, ['--import', resolve(root, 'node_modules/tsx/dist/loader.mjs'), resolve(root, 'scripts/agent-config.ts'), 'generic', '--port', String(bridge.port), '--config-dir', '../private configuration'], {
      cwd: invocationDirectory,
      env: { ...process.env, KEEP_SAFE_PORT: '1', KEEP_SAFE_CONFIG_DIR: 'ignored directory' },
    });
    const config = JSON.parse(generated.stdout).mcpServers['keep-safe'];
    expect(config.env).toEqual({ KEEP_SAFE_CONFIG_DIR: configDirectory, KEEP_SAFE_BRIDGE_URL: bridge.url });
    client = new Client({ name: 'stdio-integration-test', version: '1.0.0' });
    transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: invocationDirectory, env: config.env, stderr: 'pipe' });
    await client.connect(transport);
    const created = await client.callTool({ name: 'request_login', arguments: { agent: 'Stdio test', title: 'Test request', url: 'https://example.com/login' } });
    expect(created.isError).not.toBe(true);
    const result = created.structuredContent as { request: { id: string; status: string } };
    expect(result.request.status).toBe('pending');
    const denied = await fetch(`${bridge.url}/api/requests/${result.request.id}/deny`, { method: 'POST', headers: { Authorization: 'Bearer stdio-owner-test' } });
    expect(denied.status).toBe(200);
    const checked = await client.callTool({ name: 'get_login_request', arguments: { request_id: result.request.id } });
    expect(checked.structuredContent).toMatchObject({ request: { status: 'denied' } });
  } finally {
    await Promise.allSettled([client?.close(), transport?.close(), bridge?.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

it('tells the agent how to fix an MCP entry whose agent key belongs to another Keep Safe setup', async () => {
  // The reported case: an older checkout entry reads one key directory while the keep-safe command's bridge uses another.
  const directory = await mkdtemp(resolve(tmpdir(), 'keep-safe-stdio-mismatch-'));
  let bridge: Awaited<ReturnType<typeof createBridge>> | undefined;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    bridge = await createBridge({ ownerToken: 'mismatch-owner-secret', agentToken: 'running-bridge-agent-secret', port: 0 });
    await writeFile(resolve(directory, 'config.json'), JSON.stringify({ ownerToken: 'other-owner-secret', agentToken: 'other-setup-agent-secret' }), { mode: 0o600 });
    const generated = await run(process.execPath, ['--import', resolve(root, 'node_modules/tsx/dist/loader.mjs'), resolve(root, 'scripts/agent-config.ts'), 'generic', '--port', String(bridge.port), '--config-dir', directory]);
    const config = JSON.parse(generated.stdout).mcpServers['keep-safe'];
    client = new Client({ name: 'stdio-mismatch-test', version: '1.0.0' });
    transport = new StdioClientTransport({ command: config.command, args: config.args, env: config.env, stderr: 'pipe' });
    await client.connect(transport);
    const result = await client.callTool({ name: 'request_login', arguments: { agent: 'Stdio test', title: 'Test request', url: 'https://example.com/login' } });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain('refused this MCP server\'s agent key');
    expect(text).toContain('npx -y github:Maseeek/keep-safe mcp');
    expect(text).toContain('Never ask the owner for a key');
    expect(text).not.toContain('owner pairing token');
    expect(text).not.toMatch(/secret/);
    expect(text).not.toContain(directory);
  } finally {
    await Promise.allSettled([client?.close(), transport?.close(), bridge?.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});
