import { describe, expect, it } from 'vitest';
import { agentConfig } from '../scripts/agent-config';

describe('agent configuration examples', () => {
  it('creates parseable JSON with absolute paths even when a checkout contains spaces', () => {
    for (const client of ['claude', 'antigravity', 'generic']) {
      const config = JSON.parse(agentConfig(client, '/tmp/My Keep Safe'));
      expect(config.mcpServers['keep-safe'].args).toContain('/tmp/My Keep Safe/packages/mcp/src/index.ts');
      expect(config.mcpServers['keep-safe'].env).toEqual({ KEEP_SAFE_CONFIG_DIR: '/tmp/My Keep Safe/.keep-safe' });
      expect(JSON.stringify(config)).not.toContain('TOKEN');
    }
  });

  it('generates a Codex stdio entry with enough time for the bounded login wait', () => {
    const config = agentConfig('codex', '/tmp/keep-safe');
    expect(config).toContain('[mcp_servers.keep_safe]');
    expect(config).toContain('tool_timeout_sec = 150');
    expect(config).not.toContain('agentToken');
  });

  it('rejects an unknown client without attempting a config write', () => {
    expect(() => agentConfig('unknown')).toThrow('Choose a client:');
  });
});
