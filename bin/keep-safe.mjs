#!/usr/bin/env node
// Launches the TypeScript CLI through the bundled tsx loader, so a plain
// `npx` or global install needs no build step for the command-line tools.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
let loader;
try { loader = join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs'); }
catch { console.error('Keep Safe is missing its dependencies. Run npm install in ' + root + ' and try again.'); process.exit(1); }
const child = spawn(process.execPath, ['--import', pathToFileURL(loader).href, join(root, 'packages', 'cli', 'src', 'main.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { if (!child.killed) child.kill(signal); });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
