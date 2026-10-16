import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import webpush from 'web-push';

export interface BridgeConfig {
  ownerToken: string;
  agentToken: string;
  vapid: { publicKey: string; privateKey: string };
}

/** Only these deliberately worded errors are safe for CLI output. */
export class ConfigError extends Error {}

/** Read existing authority without creating files, changing permissions, or acquiring a lock. */
export async function readExistingConfig(directory: string): Promise<BridgeConfig> {
  let content: string;
  try { content = await readFile(join(resolve(directory), 'config.json'), 'utf8'); }
  catch { throw new ConfigError('Existing bridge configuration could not be read. Check the configuration directory and file permissions.'); }
  return parseConfig(content);
}

function parseConfig(content: string): BridgeConfig {
  let value: BridgeConfig;
  try { value = JSON.parse(content) as BridgeConfig; }
  catch { throw new ConfigError('Invalid bridge configuration. Restore a valid local config file before continuing.'); }
  if (!value || typeof value.ownerToken !== 'string' || typeof value.agentToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.ownerToken) || !/^[a-f0-9]{64}$/.test(value.agentToken) || value.ownerToken === value.agentToken || typeof value.vapid?.publicKey !== 'string' || !value.vapid.publicKey || typeof value.vapid?.privateKey !== 'string' || !value.vapid.privateKey) {
    throw new ConfigError('Invalid bridge configuration. Restore a valid local config file before continuing.');
  }
  return value;
}

export async function loadConfig(directory = '.keep-safe', options: { createIfMissing?: boolean } = {}): Promise<BridgeConfig> {
  const path = resolve(directory);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const file = join(path, 'config.json');
  try {
    const content = await readFile(file, 'utf8');
    const value = parseConfig(content);
    await chmod(file, 0o600);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (options.createIfMissing === false) throw new ConfigError('No existing bridge configuration was found. Start the bridge first, then stop it before rotating keys.');
  }
  const config: BridgeConfig = {
    ownerToken: randomBytes(32).toString('hex'),
    agentToken: randomBytes(32).toString('hex'),
    vapid: webpush.generateVAPIDKeys(),
  };
  try {
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return loadConfig(directory);
    throw error;
  }
  return config;
}
