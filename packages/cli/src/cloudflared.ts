import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The tunnel program Keep Safe fetches when none is installed. Pinned, and
 * checked against the SHA-256 Cloudflare published for that release. */
const version = '2026.11.0';
const assets: Record<string, { file: string; sha256: string; megabytes: number; archive?: boolean }> = {
  'linux-x64': { file: 'cloudflared-linux-amd64', sha256: '51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd', megabytes: 40 },
  'linux-arm64': { file: 'cloudflared-linux-arm64', sha256: 'abe54a006acf9faf2d19ee9d953cb0d0804e92f59c5382a162e57b84d086f56f', megabytes: 38 },
  'linux-arm': { file: 'cloudflared-linux-arm', sha256: '57f6a61df47583ccd5c3507b87964820adccb1f9fd35f311417c7872004dc368', megabytes: 37 },
  'darwin-x64': { file: 'cloudflared-darwin-amd64.tgz', sha256: '8a59d51120cebbe902f0a8d6e1b7a7fd4f9a5bb4dcb3e0f05872483e75e7db6b', megabytes: 22, archive: true },
  'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', sha256: '8c2f90277ef06a6080bb40b964d33f09f1188102f8798f2e344174b6cf41accf', megabytes: 20, archive: true },
  'win32-x64': { file: 'cloudflared-windows-amd64.exe', sha256: 'd5c1d82031da6253dcdcff64c944cd0fe063016edeb2e4fd088075fc9bd52d0a', megabytes: 55 },
};

const runs = (command: string, args: string[]) => new Promise<boolean>(resolve => {
  execFile(command, args, { timeout: 8000, windowsHide: true }, error => resolve(!error));
});

/** Finds the tunnel program, fetching it into the Keep Safe folder the first time. */
export async function ensureCloudflared(directory: string, log: (line: string) => void = () => {}): Promise<string | undefined> {
  const explicit = process.env.KEEP_SAFE_CLOUDFLARED;
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const own = join(directory, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (existsSync(own) && await runs(own, ['--version'])) return own;
  if (await runs('cloudflared', ['--version'])) return 'cloudflared';
  const asset = assets[`${process.platform}-${process.arch}`];
  if (!asset) return undefined;
  log(`Fetching the secure link helper (cloudflared ${version}, about ${asset.megabytes} MB, one time)...`);
  const folder = join(directory, 'bin');
  const download = join(folder, `${asset.file}.download`);
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${version}/${asset.file}`, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) return undefined;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) { log('The download did not match its published checksum, so it was not used.'); return undefined; }
    await writeFile(download, bytes, { mode: 0o700 });
    if (asset.archive) {
      // macOS releases are a tarball holding the one program.
      if (!await runs('tar', ['-xzf', download, '-C', folder])) return undefined;
      await unlink(download).catch(() => {});
    } else await rename(download, own);
    await chmod(own, 0o755);
    return await runs(own, ['--version']) ? own : undefined;
  } catch { return undefined; }
  finally { await unlink(download).catch(() => {}); }
}
