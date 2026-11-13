import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startTunnel, stopTunnel } from '../src/tunnel';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close().catch(() => {}); });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Stands in for cloudflared: prints an address the way it does, then stays up. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'keep-safe-tunnel-'));
  const binary = join(directory, 'cloudflared');
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('fs');
const count = Number(fs.existsSync(__dirname + '/starts') ? fs.readFileSync(__dirname + '/starts', 'utf8') : 0) + 1;
fs.writeFileSync(__dirname + '/starts', String(count));
console.error('INF Requesting new quick Tunnel on trycloudflare.com...');
setTimeout(() => console.error('INF |  https://fake-tunnel-' + count + '.trycloudflare.com  |'), 150);
setInterval(() => {}, 1000);
`);
  await chmod(binary, 0o755);
  cleanup.push(async () => { await stopTunnel(directory); await rm(directory, { recursive: true, force: true }); });
  const stored = async () => JSON.parse(await readFile(join(directory, 'tunnel.json'), 'utf8')) as { pid: number; url: string; port: number };
  return { directory, binary, stored };
}

describe.skipIf(process.platform === 'win32')('secure public link', () => {
  it('reports the address, outlives a bridge restart, and replaces a tunnel that ended', async () => {
    const { directory, binary, stored } = await fixture();
    const seen: string[] = [];
    const first = startTunnel({ binary, port: 4999, directory, verify: false, onAddress: address => seen.push(address) });
    expect(first.state()).toBe('starting');
    expect(await first.ready(15_000)).toBe(true);
    expect(first.url()).toBe('https://fake-tunnel-1.trycloudflare.com');
    expect(seen).toEqual(['https://fake-tunnel-1.trycloudflare.com']);
    const { pid } = await stored();
    expect((await readFile(join(directory, 'tunnel.json'), 'utf8'))).toContain('"port": 4999');

    // The bridge stops, the tunnel stays, and the next bridge picks it up again.
    first.stop();
    expect(alive(pid)).toBe(true);
    const second = startTunnel({ binary, port: 4999, directory, verify: false });
    cleanup.push(async () => second.stop());
    expect(await second.ready(15_000)).toBe(true);
    expect(second.url()).toBe('https://fake-tunnel-1.trycloudflare.com');
    expect((await stored()).pid).toBe(pid);

    // The tunnel ends by itself: a new one opens and the address follows.
    process.kill(pid);
    await expect.poll(() => second.url(), { timeout: 20_000 }).toBe('https://fake-tunnel-2.trycloudflare.com');
    expect(second.state()).toBe('ready');
    const next = (await stored()).pid;
    expect(next).not.toBe(pid);

    second.stop();
    await stopTunnel(directory);
    await expect.poll(() => alive(next), { timeout: 5000 }).toBe(false);
  }, 60_000);

  it('opens a new tunnel when the port changed, and never touches an unrelated process', async () => {
    const { directory, binary, stored } = await fixture();
    const first = startTunnel({ binary, port: 4999, directory, verify: false });
    expect(await first.ready(15_000)).toBe(true);
    const { pid } = await stored();
    first.stop();
    const moved = startTunnel({ binary, port: 5001, directory, verify: false });
    cleanup.push(async () => moved.stop());
    expect(await moved.ready(15_000)).toBe(true);
    expect(moved.url()).toBe('https://fake-tunnel-2.trycloudflare.com');
    await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
    moved.stop();
    await stopTunnel(directory);

    // A stale record that points at some other live process is ignored, not stopped.
    await writeFile(join(directory, 'tunnel.json'), JSON.stringify({ version: 1, pid: process.pid, port: 5001, url: 'https://stale-words.trycloudflare.com', startedAt: new Date().toISOString() }));
    await stopTunnel(directory);
    expect(alive(process.pid)).toBe(true);
  }, 60_000);

  it('reports failure when the program never gives an address', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'keep-safe-tunnel-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const binary = join(directory, 'cloudflared');
    await writeFile(binary, '#!/usr/bin/env node\nconsole.error("ERR no network"); process.exit(1);\n');
    await chmod(binary, 0o755);
    const tunnel = startTunnel({ binary, port: 4999, directory, verify: false });
    cleanup.push(async () => tunnel.stop());
    expect(await tunnel.ready(15_000)).toBe(false);
    expect(tunnel.state()).toBe('failed');
    expect(tunnel.url()).toBeUndefined();
  }, 30_000);
});
