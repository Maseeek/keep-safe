import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const bridgeCli = join(packageRoot, 'packages', 'bridge', 'src', 'cli.ts');
export const binPath = join(packageRoot, 'bin', 'keep-safe.mjs');
export const installSpec = 'github:Maseeek/keep-safe';

/** One place for keys and state, wherever the command runs from. */
export function configDirectory(explicit?: string): string {
  return resolve(explicit ?? process.env.KEEP_SAFE_CONFIG_DIR ?? join(homedir(), '.keep-safe'));
}

export function tsxLoader(): string {
  const require = createRequire(import.meta.url);
  return pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href;
}

/** True when this copy lives in npm's temporary npx cache rather than a kept install. */
export const runningFromNpx = /[\\/]_npx[\\/]/.test(packageRoot);
