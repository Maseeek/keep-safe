import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import webpush from 'web-push';

export interface BridgeConfig {
  ownerToken: string;
  agentToken: string;
  vapid: { publicKey: string; privateKey: string };
}

export async function loadConfig(directory = '.keep-safe'): Promise<BridgeConfig> {
  const path = resolve(directory);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const file = join(path, 'config.json');
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as BridgeConfig;
    if (!/^[a-f0-9]{64}$/.test(value.ownerToken) || !/^[a-f0-9]{64}$/.test(value.agentToken) || value.ownerToken === value.agentToken || !value.vapid?.publicKey || !value.vapid?.privateKey) {
      throw new Error('Invalid bridge configuration. Move the config file aside to create new pairing keys.');
    }
    await chmod(file, 0o600);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
