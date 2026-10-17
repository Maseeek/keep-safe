import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connectionPort } from '../packages/bridge/src/connection-options';
import { ConfigError } from '../packages/bridge/src/config';

export const supportedClients = ['codex', 'claude', 'antigravity', 'generic'] as const;
export type AgentClient = typeof supportedClients[number];
export interface AgentConfigOptions {
  port?: string | number;
  configDirectory?: string;
  /** Resolve an explicitly selected relative config directory like the bridge CLI. */
  cwd?: string;
}

class AgentConfigError extends Error {}
const usage = 'Usage: npm run --silent agent:config -- [codex|claude|antigravity|generic] [--port NUMBER] [--config-dir PATH]';

/** Generates configuration only. Never reads credentials or changes a user's client files. */
export function agentConfig(client: string, root = fileURLToPath(new URL('..', import.meta.url)), options: AgentConfigOptions = {}) {
  if (!supportedClients.includes(client as AgentClient)) throw new AgentConfigError(`Choose a client: ${supportedClients.join(', ')}.`);
  const port = connectionPort(String(options.port ?? process.env.KEEP_SAFE_PORT ?? '4318'));
  const selectedDirectory = options.configDirectory ?? process.env.KEEP_SAFE_CONFIG_DIR;
  if (selectedDirectory !== undefined && (!selectedDirectory.trim() || /[\u0000-\u001f\u007f]/.test(selectedDirectory))) throw new AgentConfigError('Config directory must be a non-empty path without control characters.');
  const args = ['--import', resolve(root, 'node_modules/tsx/dist/loader.mjs'), resolve(root, 'packages/mcp/src/index.ts')];
  const configDir = selectedDirectory === undefined ? resolve(root, '.keep-safe') : resolve(options.cwd ?? process.cwd(), selectedDirectory);
  const bridgeUrl = `http://127.0.0.1:${port}`;
  if (client === 'codex') return [
    '[mcp_servers.keep_safe]',
    'command = "node"',
    `args = ${JSON.stringify(args)}`,
    'tool_timeout_sec = 150',
    '',
    '[mcp_servers.keep_safe.env]',
    `KEEP_SAFE_CONFIG_DIR = ${JSON.stringify(configDir)}`,
    `KEEP_SAFE_BRIDGE_URL = ${JSON.stringify(bridgeUrl)}`,
    '',
  ].join('\n');
  return JSON.stringify({ mcpServers: { 'keep-safe': { command: 'node', args, env: { KEEP_SAFE_CONFIG_DIR: configDir, KEEP_SAFE_BRIDGE_URL: bridgeUrl } } } }, null, 2) + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let client = 'generic'; let hasClient = false; let help = false;
    const options: AgentConfigOptions = {};
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index++) {
      const argument = args[index];
      if (argument === '--help') help = true;
      else if (argument === '--port' || argument === '--config-dir') {
        const value = args[++index];
        if (!value || value.startsWith('--')) throw new AgentConfigError(usage);
        if (argument === '--port') options.port = value; else options.configDirectory = value;
      } else if (argument.startsWith('-') || hasClient) throw new AgentConfigError(usage);
      else { client = argument; hasClient = true; }
    }
    if (help) process.stdout.write(`${usage}\n\nPort and config directory default to KEEP_SAFE_PORT and KEEP_SAFE_CONFIG_DIR when set.\nOtherwise use port 4318 and this checkout's .keep-safe directory.\nExplicit options override environment settings. Relative selected paths use the current working directory.\nNo keys are read, printed or written.\n`);
    else process.stdout.write(agentConfig(client, undefined, options));
  }
  catch (error) { process.stderr.write(`${error instanceof AgentConfigError || error instanceof ConfigError ? error.message : 'Could not generate configuration. Check the client, port and config directory.'}\n`); process.exitCode = 1; }
}
