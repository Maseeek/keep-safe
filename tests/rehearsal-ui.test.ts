import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridge } from '../packages/bridge/src/server';
import { runRehearsal } from '../packages/bridge/src/rehearsal';
import type { LoginRequest } from '../packages/shared/src/protocol';

const ownerToken = 'a'.repeat(64);
const agentToken = 'b'.repeat(64);
const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureConfig = JSON.stringify({
  ownerToken, agentToken,
  vapid: { publicKey: 'synthetic-rehearsal-public-key', privateKey: 'synthetic-rehearsal-private-key' },
});

async function settles(promise: Promise<unknown>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise.then(() => true, () => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}

function startCli(configDirectory: string, port: number) {
  const child = spawn(process.execPath, ['--import', resolve(root, 'node_modules/tsx/dist/loader.mjs'), resolve(root, 'packages/bridge/src/cli.ts'), 'rehearse', '--port', String(port), '--config-dir', configDirectory], {
    cwd: configDirectory, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  let stdout = ''; let stderr = ''; let done = false; let exitCode: number | null | undefined;
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const finished = new Promise<{ result: string } | { error: unknown }>(resolve => {
    child.once('error', () => { done = true; resolve({ error: 'The synthetic rehearsal CLI could not start.' }); });
    child.once('close', code => { done = true; exitCode = code; resolve({ result: code === 0 ? 'passed' : 'failed' }); });
  });
  return {
    finished, logs: () => stdout.split(/\r?\n/).filter(Boolean), get stderr() { return stderr; }, get exitCode() { return exitCode; },
    async stop() {
      if (done) return;
      child.kill('SIGINT');
      if (!await settles(finished, 6000)) {
        child.kill('SIGKILL');
        if (!await settles(finished, 3000)) throw new Error('The synthetic rehearsal CLI did not exit after test cleanup.');
      }
    },
  };
}

describe('real rehearsal through the built phone interface', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each([320, 390])('returns the same synthetic authenticated browser after explicit phone handback at %ipx', async width => {
    const directory = await mkdtemp(resolve(tmpdir(), 'keep-safe-rehearsal-ui-'));
    const configFile = resolve(directory, 'config.json');
    const controller = new AbortController();
    let bridge: Awaited<ReturnType<typeof createBridge>> | undefined;
    let context: BrowserContext | undefined;
    let rehearsal: Promise<{ result: string } | { error: unknown }> | undefined;
    let cli: ReturnType<typeof startCli> | undefined;
    const logs: string[] = [];
    const errors: string[] = [];
    const external: string[] = [];
    try {
      await writeFile(configFile, fixtureConfig, { mode: 0o600 });
      const before = await stat(configFile);
      bridge = await createBridge({ ownerToken, agentToken, port: 0, staticDir: resolve('apps/web/dist') });
      const running = bridge;

      // The rehearsal attaches an isolated external browser. It must not relax
      // the default managed-browser restrictions for ordinary agent requests.
      const privateTarget = await fetch(`${running.url}/api/requests`, {
        method: 'POST', headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'Boundary fixture', title: 'Must reject', url: 'https://127.0.0.1/login' }),
      });
      expect(privateTarget.status).toBe(400);

      if (width === 390) {
        cli = startCli(directory, running.port);
        rehearsal = cli.finished;
      } else rehearsal = runRehearsal({ configDirectory: directory, port: running.port, signal: controller.signal, log: message => logs.push(message) })
          .then(result => ({ result }), error => ({ error }));
      const currentLogs = () => cli ? cli.logs() : logs;

      // Owner queue polling belongs to this test, never to the agent-only CLI.
      let request: LoginRequest | undefined;
      await expect.poll(async () => {
        const queue = await fetch(`${running.url}/api/requests`, { headers: { Authorization: `Bearer ${ownerToken}` } }).then(response => response.json()) as { requests: LoginRequest[] };
        request = queue.requests.find(item => item.agent === 'Keep Safe rehearsal');
        return request?.status;
      }, { timeout: 15000 }).toBe('pending');
      expect(request!.url).toBe('https://practice.keep-safe.invalid/login');
      expect(Date.parse(request!.expiresAt) - Date.parse(request!.createdAt)).toBe(300_000);

      context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', outgoing => { if (!outgoing.url().startsWith(running.url)) external.push(outgoing.url()); });
      await context.route('**/*', route => route.request().url().startsWith(running.url) ? route.continue() : route.abort());
      await page.goto(`${running.url}/#${new URLSearchParams({ bridge: running.url, token: ownerToken })}`);
      await page.getByRole('button', { name: /Keep Safe rehearsal practice.keep-safe.invalid/ }).click();
      await page.getByRole('button', { name: 'Approve & open', exact: true }).click();
      await page.locator('.remote-screen img').waitFor({ state: 'visible' });

      await page.getByRole('button', { name: 'Page controls', exact: true }).click();
      const focusPhrase = page.getByRole('button', { name: 'Focus Practice phrase', exact: true });
      await focusPhrase.waitFor({ state: 'visible' });
      await focusPhrase.click();
      await expect.poll(() => page.locator('.page-control-focus').innerText()).toContain('Focus confirmed on Practice phrase.');
      await page.getByRole('button', { name: 'Type text', exact: true }).click();
      const input = page.getByLabel('Tap a field in the browser, then send text');
      const inputLogStart = currentLogs().length;
      await input.fill('PRACTICE');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      expect(await input.inputValue()).toBe('');
      await page.getByRole('button', { name: 'Press Enter in browser', exact: true }).click();

      // Explicitly hand back through the phone. The rehearsal, rather than this
      // test driving its page, proves the cookie survives a subsequent reload.
      await page.getByRole('button', { name: 'Done, hand back', exact: true }).click();
      expect(await rehearsal).toEqual({ result: 'passed' });
      await expect.poll(() => page.getByRole('heading', { name: 'Back in good hands.', exact: true }).count()).toBe(1);

      const output = currentLogs().join('\n');
      if (cli) {
        expect(cli.exitCode).toBe(0);
        expect(cli.stderr).toBe('');
        expect(output).toContain('Practice handoff verified. The returned browser stayed signed in after reload.');
      }
      expect(output).toContain(`Practice request ${request!.id} queued for five minutes.`);
      expect(output).toContain('Handback received. Checking the returned practice browser.');
      // The fixed public phrase appears in pre-input instructions only. Actual
      // typing never causes its content, tokens, endpoints or cookies to log.
      expect(currentLogs().slice(inputLogStart).join('\n')).not.toContain('PRACTICE');
      for (const secret of [ownerToken, agentToken, 'synthetic-rehearsal-private-key', 'keep_safe_practice', 'cdpUrl', 'devtools/', 'http://127.0.0.1:', 'token=']) expect(output).not.toContain(secret);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(await readFile(configFile, 'utf8')).toBe(fixtureConfig);
      const after = await stat(configFile);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.mode & 0o777).toBe(before.mode & 0o777);
      expect(await readdir(directory)).toEqual(['config.json']);
    } finally {
      controller.abort();
      try { if (cli) await cli.stop(); else await rehearsal; }
      finally {
        await Promise.allSettled([context?.close(), bridge?.close()]);
        await rm(directory, { recursive: true, force: true });
      }
    }
  }, 45000);
});
