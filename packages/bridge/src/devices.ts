import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, unlink, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DevicePairResult, PairedDevice } from '../../shared/src/protocol';

interface StoredDevice extends PairedDevice { digest: string }
/** A paired phone stays paired while it is used. Thirty idle days end it. */
export const DEVICE_LIFETIME_DAYS = 30;
const DEVICE_LIFETIME_MS = DEVICE_LIFETIME_DAYS * 24 * 60 * 60 * 1000;
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
export function atomicJsonWriter(path?: string) {
  let pending = Promise.resolve();
  return {
    write(value: unknown) {
      if (!path) return Promise.resolve();
      const content = JSON.stringify(value);
      const operation = pending.then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, content, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
        finally { await unlink(temporary).catch(() => {}); }
      });
      pending = operation.catch(() => {});
      return operation;
    },
    flush() { return pending; },
  };
}

export async function createDeviceStore(path: string | undefined, now: () => number) {
  const devices = new Map<string, StoredDevice>();
  const writer = atomicJsonWriter(path);
  if (path) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown; devices?: unknown };
      if (value.version !== 1 || !Array.isArray(value.devices) || value.devices.length > 10) throw new Error('Invalid paired device file.');
      for (const item of value.devices as StoredDevice[]) {
        if (!item || typeof item.id !== 'string' || !/^[a-f0-9-]{36}$/.test(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80 || typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest) || ![item.createdAt, item.expiresAt, item.lastSeenAt].every(date => typeof date === 'string' && Number.isFinite(Date.parse(date)))) throw new Error('Invalid paired device file.');
        devices.set(item.id, { id: item.id, name: item.name, digest: item.digest, createdAt: item.createdAt, expiresAt: item.expiresAt, lastSeenAt: item.lastSeenAt });
      }
      await chmod(path, 0o600);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Paired devices could not be loaded safely.'); }
  }
  const publicDevice = (device: StoredDevice): PairedDevice => ({ id: device.id, name: device.name, createdAt: device.createdAt, expiresAt: device.expiresAt, lastSeenAt: device.lastSeenAt });
  const persist = () => writer.write({ version: 1, devices: [...devices.values()] });
  let seenTimer: ReturnType<typeof setTimeout> | undefined;
  function active(id: string, touch = false) {
    const device = devices.get(id);
    if (!device || now() >= Date.parse(device.expiresAt)) return false;
    if (touch && now() - Date.parse(device.lastSeenAt) >= 60_000) {
      device.lastSeenAt = new Date(now()).toISOString();
      // Sliding expiry: renew at most daily so an active phone never needs
      // re-pairing, while an unused key still ends on its own.
      if (Date.parse(device.expiresAt) - now() < DEVICE_LIFETIME_MS - RENEW_AFTER_MS) device.expiresAt = new Date(now() + DEVICE_LIFETIME_MS).toISOString();
      seenTimer ??= setTimeout(() => { seenTimer = undefined; void persist().catch(() => {}); }, 1000);
      seenTimer.unref();
    }
    return true;
  }
  return {
    active,
    authenticate(token: string | undefined) {
      if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
      const digest = createHash('sha256').update(token).digest();
      for (const device of devices.values()) if (timingSafeEqual(digest, Buffer.from(device.digest, 'hex')) && active(device.id, true)) return publicDevice(device);
      return undefined;
    },
    /** Lets a paired phone show it holds its key without sending it. The proof
     * is keyed by the stored digest and bound to one message. */
    prove(id: unknown, message: string, proof: unknown) {
      if (typeof id !== 'string' || typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) return undefined;
      const device = devices.get(id);
      if (!device || !active(id, true)) return undefined;
      const expected = createHmac('sha256', Buffer.from(device.digest, 'hex')).update(message).digest();
      return timingSafeEqual(expected, Buffer.from(proof, 'hex')) ? publicDevice(device) : undefined;
    },
    list(currentId?: string) { return [...devices.values()].filter(device => active(device.id)).map(device => ({ ...publicDevice(device), ...(device.id === currentId ? { current: true } : {}) })); },
    async pair(name: string): Promise<DevicePairResult> {
      if (devices.size >= 10) throw new Error('Ten phones are already paired. Revoke a phone before pairing another.');
      const time = now();
      const token = randomBytes(32).toString('hex');
      const device: StoredDevice = { id: randomUUID(), name, createdAt: new Date(time).toISOString(), lastSeenAt: new Date(time).toISOString(), expiresAt: new Date(time + DEVICE_LIFETIME_MS).toISOString(), digest: createHash('sha256').update(token).digest('hex') };
      devices.set(device.id, device);
      try { await persist(); } catch (error) { devices.delete(device.id); throw error; }
      return { device: publicDevice(device), token };
    },
    remove(id: string) { return devices.delete(id); },
    prune() { const expired = [...devices.values()].filter(device => !active(device.id)).map(device => device.id); for (const id of expired) devices.delete(id); return expired; },
    persist,
    async close() { if (seenTimer) { clearTimeout(seenTimer); await persist(); } await writer.flush(); },
  };
}
