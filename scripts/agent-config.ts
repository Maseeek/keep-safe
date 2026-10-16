import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const supportedClients = ['codex', 'claude', 'antigravity', 'generic'] as const;
export type AgentClient = typeof supportedClients[number];

/** Generates configuration only. Never reads credentials or changes a user's client files. */
export function agentConfig(client: string, root = fileURLToPath(new URL('..', import.meta.url))) {
  if (!supportedClients.includes(client as AgentClient)) throw new Error(`Choose a client: ${supportedClients.join(', ')}.`);
  const args = ['--import', resolve(root, 'node_modules/tsx/dist/loader.mjs'), resolve(root, 'packages/mcp/src/index.ts')];
  const configDir = resolve(root, '.keep-safe');
  if (client === 'codex') return [
    '[mcp_servers.keep_safe]',
    'command = "node"',
    `args = ${JSON.stringify(args)}`,
    'tool_timeout_sec = 150',
    '',
    '[mcp_servers.keep_safe.env]',
    `KEEP_SAFE_CONFIG_DIR = ${JSON.stringify(configDir)}`,
    '',
  ].join('\n');
  return JSON.stringify({ mcpServers: { 'keep-safe': { command: 'node', args, env: { KEEP_SAFE_CONFIG_DIR: configDir } } } }, null, 2) + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const client = process.argv[2] ?? 'generic';
  try { process.stdout.write(agentConfig(client)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Could not generate configuration.'}\n`); process.exitCode = 1; }
}
