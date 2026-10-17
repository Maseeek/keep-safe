import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentConfig } from '../scripts/agent-config';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary: string[] = [];
beforeEach(() => { vi.stubEnv('KEEP_SAFE_PORT', undefined); vi.stubEnv('KEEP_SAFE_CONFIG_DIR', undefined); });
afterEach(async () => { vi.unstubAllEnvs(); for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'keep-safe-config generator-')); temporary.push(directory);
  const result = await run(process.execPath, ['--import', resolve(root, 'node_modules/tsx/dist/loader.mjs'), resolve(root, 'scripts/agent-config.ts'), ...args], {
    cwd: directory,
    env: { ...process.env, KEEP_SAFE_PORT: '4318', KEEP_SAFE_CONFIG_DIR: directory, ...env },
  });
  return { ...result, directory };
}

describe('agent configuration examples', () => {
  it('creates parseable JSON with absolute paths even when a checkout contains spaces', () => {
    for (const client of ['claude', 'antigravity', 'generic']) {
      const config = JSON.parse(agentConfig(client, '/tmp/My Keep Safe'));
      expect(config.mcpServers['keep-safe'].args).toContain('/tmp/My Keep Safe/packages/mcp/src/index.ts');
      expect(config.mcpServers['keep-safe'].env).toEqual({ KEEP_SAFE_CONFIG_DIR: '/tmp/My Keep Safe/.keep-safe', KEEP_SAFE_BRIDGE_URL: 'http://127.0.0.1:4318' });
      expect(JSON.stringify(config)).not.toContain('TOKEN');
    }
  });

  it('generates a Codex stdio entry with enough time for the bounded login wait', () => {
    const config = agentConfig('codex', '/tmp/keep-safe');
    expect(config).toContain('[mcp_servers.keep_safe]');
    expect(config).toContain('tool_timeout_sec = 150');
    expect(config).toContain('KEEP_SAFE_BRIDGE_URL = "http://127.0.0.1:4318"');
    expect(config).not.toContain('agentToken');
  });

  it('rejects an unknown client without attempting a config write', () => {
    expect(() => agentConfig('unknown')).toThrow('Choose a client:');
  });

  it('honors environment defaults and lets explicit options win with invocation-relative paths', () => {
    vi.stubEnv('KEEP_SAFE_PORT', '5123'); vi.stubEnv('KEEP_SAFE_CONFIG_DIR', 'Environment keys');
    const environment = JSON.parse(agentConfig('generic', '/tmp/checkout', { cwd: '/tmp/invocation' })).mcpServers['keep-safe'].env;
    expect(environment).toEqual({ KEEP_SAFE_CONFIG_DIR: '/tmp/invocation/Environment keys', KEEP_SAFE_BRIDGE_URL: 'http://127.0.0.1:5123' });
    const explicit = JSON.parse(agentConfig('generic', '/tmp/checkout', { cwd: '/tmp/invocation', port: 6234, configDirectory: 'Explicit keys' })).mcpServers['keep-safe'].env;
    expect(explicit).toEqual({ KEEP_SAFE_CONFIG_DIR: '/tmp/invocation/Explicit keys', KEEP_SAFE_BRIDGE_URL: 'http://127.0.0.1:6234' });
  });

  it.each(['0', '65536', '-1', '1.5', '1e3', 'bad-port', '4318/synthetic-private-argument'])('rejects invalid port %s with a safe validation message', port => {
    expect(() => agentConfig('generic', '/tmp/checkout', { port })).toThrow('Port must be between 1 and 65535.');
  });

  it('generates real CLI JSON with flags overriding environment and relative selected paths', async () => {
    const result = await cli(['claude', '--port', '5342', '--config-dir', 'Selected keys'], { KEEP_SAFE_PORT: '6453', KEEP_SAFE_CONFIG_DIR: 'Ignored environment keys' });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).mcpServers['keep-safe'].env).toEqual({ KEEP_SAFE_CONFIG_DIR: resolve(result.directory, 'Selected keys'), KEEP_SAFE_BRIDGE_URL: 'http://127.0.0.1:5342' });
  });

  it('generates real CLI configuration from environment settings', async () => {
    const result = await cli(['antigravity'], { KEEP_SAFE_PORT: '7456', KEEP_SAFE_CONFIG_DIR: 'Environment keys' });
    expect(JSON.parse(result.stdout).mcpServers['keep-safe'].env).toEqual({ KEEP_SAFE_CONFIG_DIR: resolve(result.directory, 'Environment keys'), KEEP_SAFE_BRIDGE_URL: 'http://127.0.0.1:7456' });
  });

  it('keeps the default key directory anchored to the checkout when invoked elsewhere', async () => {
    const result = await cli([], { KEEP_SAFE_CONFIG_DIR: undefined, KEEP_SAFE_PORT: undefined });
    expect(JSON.parse(result.stdout).mcpServers['keep-safe'].env).toEqual({ KEEP_SAFE_CONFIG_DIR: resolve(root, '.keep-safe'), KEEP_SAFE_BRIDGE_URL: 'http://127.0.0.1:4318' });
  });

  it('does not read or rewrite selected configuration files', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'keep-safe-unread config-')); temporary.push(directory);
    const content = 'Not JSON. synthetic-private-key-must-not-be-read';
    await writeFile(resolve(directory, 'config.json'), content);
    const result = await cli(['generic', '--config-dir', directory]);
    expect(result.stdout).not.toContain('synthetic-private-key');
    expect(await readFile(resolve(directory, 'config.json'), 'utf8')).toBe(content);
    expect(await readdir(directory)).toEqual(['config.json']);
  });

  it.each([
    ['generic', '--port', 'synthetic-private-port'],
    ['generic', '--port'],
    ['generic', '--config-dir'],
    ['generic', '--synthetic-private-option'],
    ['generic', 'synthetic-private-extra-argument'],
  ])('rejects invalid CLI options without echoing arguments: %j', async (...args) => {
    let error: unknown;
    try { await cli(args); } catch (reason) { error = reason; }
    expect(error).toBeDefined();
    const result = error as { stdout: string; stderr: string };
    expect(result.stdout).toBe(''); expect(result.stderr).not.toContain('synthetic-private');
    expect(result.stderr).toMatch(/Usage:|Port must be/);
  });

  const tomllibAvailable = spawnSync('python3', ['-c', 'import tomllib'], { stdio: 'ignore' }).status === 0;
  it.skipIf(!tomllibAvailable)('parses generated TOML with the existing Python standard-library parser', () => {
    const config = agentConfig('codex', '/tmp/My "Keep Safe"\\checkout', { configDirectory: '/tmp/Private "phone keys"', port: 6123 });
    const parsed = spawnSync('python3', ['-c', 'import sys,tomllib,json;print(json.dumps(tomllib.loads(sys.stdin.read())))'], { input: config, encoding: 'utf8' });
    expect(parsed.status).toBe(0);
    const value = JSON.parse(parsed.stdout).mcp_servers.keep_safe;
    expect(value.env).toEqual({ KEEP_SAFE_CONFIG_DIR: '/tmp/Private "phone keys"', KEEP_SAFE_BRIDGE_URL: 'http://127.0.0.1:6123' });
    expect(value.args).toContain('/tmp/My "Keep Safe"\\checkout/packages/mcp/src/index.ts');
    expect(value.tool_timeout_sec).toBe(150);
  });
});
