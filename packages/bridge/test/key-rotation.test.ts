import { mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { acquireConfigLock } from '../src/config-lock';
import { createDeviceStore } from '../src/devices';
import { rotateKeys, type KeyScope } from '../src/key-rotation';
import { createBridge } from '../src/server';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'keep-safe-rotation-')); directories.push(path); return path; }
async function fixture() {
  const path = await directory();
  const config = await loadConfig(path);
  await writeFile(join(path, 'config.json'), JSON.stringify({ ...config, port: 9431 }));
  const store = await createDeviceStore(join(path, 'devices.json'), Date.now);
  const phone = await store.pair('Test phone');
  await store.close();
  await writeFile(join(path, 'subscriptions.json'), '[\n  {"endpoint":"https://fcm.googleapis.com/test-fixture","keys":{"p256dh":"' + 'a'.repeat(87) + '","auth":"' + 'b'.repeat(22) + '"}}\n]\n');
  return { path, config, phone };
}

describe('offline key replacement', () => {
  it.each<KeyScope>(['owner', 'agent', 'all'])('enforces %s rotation roles after a bridge restart', async scope => {
    const { path, config, phone } = await fixture();
    const devices = await readFile(join(path, 'devices.json'), 'utf8');
    const subscriptions = await readFile(join(path, 'subscriptions.json'), 'utf8');
    await rotateKeys(path, scope);
    const next = await loadConfig(path, { createIfMissing: false });
    expect(next.ownerToken === config.ownerToken).toBe(scope === 'agent');
    expect(next.agentToken === config.agentToken).toBe(scope === 'owner');
    expect(next.ownerToken === next.agentToken).toBe(false);
    expect(JSON.stringify(next.vapid) === JSON.stringify(config.vapid)).toBe(true);
    expect(JSON.parse(await readFile(join(path, 'config.json'), 'utf8')).port).toBe(9431);
    if (scope === 'agent') {
      expect(await readFile(join(path, 'devices.json'), 'utf8') === devices).toBe(true);
      expect(await readFile(join(path, 'subscriptions.json'), 'utf8') === subscriptions).toBe(true);
    } else {
      expect(JSON.parse(await readFile(join(path, 'devices.json'), 'utf8'))).toEqual({ version: 1, devices: [] });
      expect(JSON.parse(await readFile(join(path, 'subscriptions.json'), 'utf8'))).toEqual([]);
    }
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect((await stat(join(path, 'config.json'))).mode & 0o777).toBe(0o600);
    expect((await readdir(path)).some(name => name.endsWith('.tmp') || name === 'bridge.lock')).toBe(false);
    const bridge = await createBridge({ ownerToken: next.ownerToken, agentToken: next.agentToken, port: 0, devicesFile: join(path, 'devices.json') });
    try {
      const owner = (token: string) => fetch(bridge.url + '/api/info', { headers: { Authorization: `Bearer ${token}` } });
      const agent = (token: string) => fetch(bridge.url + '/api/requests', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'Rotation fixture', title: 'Check role', url: 'https://example.com' }) });
      expect((await owner(config.ownerToken)).status).toBe(scope === 'agent' ? 200 : 401);
      expect((await owner(phone.token)).status).toBe(scope === 'agent' ? 200 : 401);
      expect((await agent(config.agentToken)).status).toBe(scope === 'owner' ? 201 : 401);
      expect((await owner(next.ownerToken)).status).toBe(200);
      expect((await agent(next.agentToken)).status).toBe(201);
    } finally { await bridge.close(); }
  });

  it('refuses running, stale, and malformed locks without touching credentials', async () => {
    const { path } = await fixture();
    const original = await readFile(join(path, 'config.json'), 'utf8');
    const lock = await acquireConfigLock(path, 'bridge');
    await expect(rotateKeys(path, 'all')).rejects.toThrow('configuration is locked');
    await lock.release();
    for (const value of ['{"pid":999999999,"purpose":"bridge"}', 'malformed-lock']) {
      await writeFile(join(path, 'bridge.lock'), value);
      await expect(rotateKeys(path, 'all')).rejects.toThrow('configuration is locked');
      expect(await readFile(join(path, 'bridge.lock'), 'utf8')).toBe(value);
      await unlink(join(path, 'bridge.lock'));
    }
    expect(await readFile(join(path, 'config.json'), 'utf8') === original).toBe(true);
  });

  it('never deletes a replacement lock owned by another operation', async () => {
    const path = await directory();
    const first = await acquireConfigLock(path, 'bridge');
    await unlink(join(path, 'bridge.lock'));
    const second = await acquireConfigLock(path, 'rotation');
    await expect(first.release()).rejects.toThrow('lock changed');
    expect((await stat(join(path, 'bridge.lock'))).isFile()).toBe(true);
    await second.release();
    await second.release();
  });

  it('requires existing valid configuration and releases its lock after rejection', async () => {
    const path = await directory();
    await expect(rotateKeys(path, 'all')).rejects.toThrow('No existing bridge configuration');
    expect(await readdir(path)).toEqual([]);
    for (const value of ['{broken-json-with-private-marker', 'null', '{"ownerToken":["' + 'a'.repeat(64) + '"]}']) {
      await writeFile(join(path, 'config.json'), value);
      await expect(rotateKeys(path, 'all')).rejects.toThrow('Invalid bridge configuration');
      expect(await readFile(join(path, 'config.json'), 'utf8')).toBe(value);
      expect(await readdir(path)).toEqual(['config.json']);
    }
  });

  it('does not commit new owner authority when notification revocation fails', async () => {
    const { path } = await fixture();
    const original = await readFile(join(path, 'config.json'), 'utf8');
    await unlink(join(path, 'subscriptions.json'));
    await mkdir(join(path, 'subscriptions.json'));
    await expect(rotateKeys(path, 'owner')).rejects.toThrow();
    expect(await readFile(join(path, 'config.json'), 'utf8') === original).toBe(true);
    expect(JSON.parse(await readFile(join(path, 'devices.json'), 'utf8'))).toEqual({ version: 1, devices: [] });
    expect((await readdir(path)).some(name => name.endsWith('.tmp') || name === 'bridge.lock')).toBe(false);
  });
});
