import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ConfigError } from './config';

/** Fail closed instead of guessing whether a stale lock can be stolen. */
export async function acquireConfigLock(directory: string, purpose: 'bridge' | 'rotation') {
  const path = resolve(directory);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const file = join(path, 'bridge.lock');
  const nonce = randomUUID();
  const handle = await open(file, 'wx', 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ConfigError('The configuration is locked by a bridge or key operation. Stop it first. After a crash, follow the lock recovery instructions in the README.');
    throw error;
  });
  let identity: Awaited<ReturnType<typeof handle.stat>>;
  try {
    await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, hostname: hostname(), purpose, nonce, createdAt: new Date().toISOString() }) + '\n');
    await handle.sync();
    identity = await handle.stat();
  } catch (error) {
    await handle.close();
    await unlink(file).catch(() => {});
    throw error;
  }
  await handle.close();
  let released = false;
  return {
    async release() {
      if (released) return;
      try {
        const current = await lstat(file);
        if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) throw new ConfigError('The configuration lock changed. Leave it in place and follow the README recovery instructions.');
        const value = JSON.parse(await readFile(file, 'utf8')) as { nonce?: string };
        if (value.nonce !== nonce) throw new ConfigError('The configuration lock changed. Leave it in place and follow the README recovery instructions.');
        await unlink(file);
        released = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { released = true; return; }
        throw error;
      }
    },
  };
}
