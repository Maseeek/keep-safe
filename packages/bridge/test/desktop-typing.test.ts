import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { findDesktopTools } from '../src/desktop';
import { openBrowser } from '../src/browser';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close().catch(() => {}); });
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

const tools = await findDesktopTools();
// Typing from the phone's keyboard reaches the sign-in Chrome as real key
// presses through XTEST. Opens real Chrome, so it runs only on request:
// KEEP_SAFE_BROWSER=chrome npx vitest run packages/bridge/test/desktop-typing.test.ts
describe.skipIf(process.env.KEEP_SAFE_BROWSER !== 'chrome' || !tools)('typing into the sign-in Chrome', () => {
  it('types every character in order, in the small quick pieces the phone keyboard sends', async () => {
    // Synthetic text only. Recorded in the sign-in Chrome, never the agent's.
    const page = `<!doctype html><body style="margin:0;font:20px sans-serif">
<input id=plain autocomplete=off style="display:block;box-sizing:border-box;width:100%;height:80px">
<input id=secret type=password autocomplete=off style="display:block;box-sizing:border-box;width:100%;height:80px">
<script>if (!navigator.webdriver) for (const field of [plain, secret]) field.addEventListener('input', () => localStorage.setItem(field.id, field.value));</script>`;
    const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(page); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const session = await openBrowser({ url, allowLocalUrls: true, viewport: { width: 390, height: 720, scale: 2, touch: true } }); cleanup.push(() => session.close());
    await expect.poll(async () => (await session.frame()).width, { timeout: 10_000 }).toBe(500);
    await pause(1500);
    // Chrome's tab strip and toolbar take the top of the picture.
    const top = 87;
    const plain = 'Synthetic.User_01+tag@example.invalid !#$%&*()-=[]{};:\'",.<>/?\\|`~^ 0123456789 éłüñÀÉ ßøå';
    const secret = 'Pa55-w0rd!@#éŁ';
    const pieces = (text: string) => { const parts: string[] = []; for (let index = 0; index < text.length; index += 1 + (index % 3)) parts.push(text.slice(index, index + 1 + (index % 3))); return parts; };
    await session.input({ type: 'click', x: 250, y: top + 40 });
    await pause(300);
    for (const part of pieces(plain)) await session.input({ type: 'text', text: part });
    await session.input({ type: 'click', x: 250, y: top + 120 });
    await pause(300);
    for (const part of pieces(secret)) await session.input({ type: 'text', text: part });
    await pause(800);
    await session.prepareHandoff!();
    const agent = await chromium.connectOverCDP(session.cdpUrl!); cleanup.push(() => agent.close());
    const shown = agent.contexts().flatMap(context => context.pages()).find(item => item.url().startsWith(url))!;
    const typed = await shown.evaluate(() => ({ plain: localStorage.getItem('plain'), secret: localStorage.getItem('secret') }));
    expect(typed).toEqual({ plain, secret });
  }, 90_000);
});
