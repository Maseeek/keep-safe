import { randomBytes, randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from './config';
import { acquireConfigLock } from './config-lock';

export type KeyScope = 'owner' | 'agent' | 'all';

async function replacePrivateJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, file);
    let directory;
    try { directory = await open(dirname(file), 'r'); await directory.sync(); }
    catch (error) {
      // Some platforms/filesystems cannot fsync directories. Real I/O errors
      // must still fail the operation instead of claiming durable success.
      if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    } finally { await directory?.close(); }
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Offline only. Never returns or prints either token. */
export async function rotateKeys(directory: string, scope: KeyScope): Promise<void> {
  if (!['owner', 'agent', 'all'].includes(scope)) throw new Error('Invalid key rotation scope.');
  const path = resolve(directory);
  const lock = await acquireConfigLock(path, 'rotation');
  try {
    const config = await loadConfig(path, { createIfMissing: false });
    const next = { ...config };
    if (scope === 'owner' || scope === 'all') {
      next.ownerToken = randomBytes(32).toString('hex');
      // Revocations become durable before new bootstrap authority is committed.
      // Never restore old devices if a later write fails.
      await replacePrivateJson(join(path, 'devices.json'), { version: 1, devices: [] });
      await replacePrivateJson(join(path, 'subscriptions.json'), []);
    }
    if (scope === 'agent' || scope === 'all') next.agentToken = randomBytes(32).toString('hex');
    await replacePrivateJson(join(path, 'config.json'), next);
  } finally { await lock.release(); }
}
