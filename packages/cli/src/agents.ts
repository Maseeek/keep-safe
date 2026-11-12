import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { binPath, installSpec, runningFromNpx } from './paths';

function run(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    execFile(command, args, { timeout: 20_000, windowsHide: true }, (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}`.trim() }));
  });
}

/** The command an agent runs to start the Keep Safe MCP server. */
export async function mcpCommand(): Promise<string[]> {
  // A temporary npx copy can vanish, so point agents at npx itself.
  if (runningFromNpx) return ['npx', '-y', installSpec, 'mcp'];
  const which = await run(process.platform === 'win32' ? 'where' : 'which', ['keep-safe']);
  if (which.ok && which.output) return ['keep-safe', 'mcp'];
  return ['node', binPath, 'mcp'];
}

export function mcpEnvironment(directory: string): Record<string, string> {
  return directory === join(homedir(), '.keep-safe') ? {} : { KEEP_SAFE_CONFIG_DIR: directory };
}

export interface Registration { agent: string; status: 'added' | 'present' | 'failed' | 'missing'; detail?: string }

/** Registers with agent CLIs that are installed. Others get the JSON snippet instead. */
export async function registerAgents(directory: string, only?: string[]): Promise<Registration[]> {
  const command = await mcpCommand();
  const environment = Object.entries(mcpEnvironment(directory));
  const results: Registration[] = [];
  const wanted = (name: string) => !only?.length || only.includes(name);
  if (wanted('claude')) {
    if (!(await run('claude', ['--version'])).ok) results.push({ agent: 'claude', status: 'missing' });
    else {
      const listed = await run('claude', ['mcp', 'get', 'keep-safe']);
      if (listed.ok) results.push({ agent: 'claude', status: 'present' });
      else {
        const added = await run('claude', ['mcp', 'add', '--scope', 'user', ...environment.flatMap(([key, value]) => ['-e', `${key}=${value}`]), 'keep-safe', '--', ...command]);
        results.push({ agent: 'claude', status: added.ok ? 'added' : 'failed', ...(added.ok ? {} : { detail: added.output.split('\n')[0] }) });
      }
    }
  }
  if (wanted('codex')) {
    if (!(await run('codex', ['--version'])).ok) results.push({ agent: 'codex', status: 'missing' });
    else {
      const listed = await run('codex', ['mcp', 'get', 'keep-safe']);
      if (listed.ok) results.push({ agent: 'codex', status: 'present' });
      else {
        const added = await run('codex', ['mcp', 'add', 'keep-safe', ...environment.flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--', ...command]);
        results.push({ agent: 'codex', status: added.ok ? 'added' : 'failed', ...(added.ok ? {} : { detail: added.output.split('\n')[0] }) });
      }
    }
  }
  return results;
}

export async function mcpSnippet(directory: string): Promise<string> {
  const [command, ...args] = await mcpCommand();
  const env = mcpEnvironment(directory);
  return JSON.stringify({ mcpServers: { 'keep-safe': { command, args, ...(Object.keys(env).length ? { env } : {}) } } }, null, 2);
}
