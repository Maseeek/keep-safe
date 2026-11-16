import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { createBridge } from '../src/server';
import { startGestureFixture } from '../../../tests/fixtures/gesture-site';

const ownerToken = 'owner-gesture-secret';
const agentToken = 'agent-gesture-secret';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close().catch(() => {}); });

type Header = { type: string; requestId: string; width: number; height: number; url: string; frameEpoch?: string; gestures?: boolean; [key: string]: unknown };
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

/** A phone speaking the socket protocol directly, against a real managed Chromium. */
async function phone(options: { stream?: boolean; attach?: boolean } = {}) {
  const site = await startGestureFixture(); cleanup.push(site.close);
  let cdpUrl: string | undefined;
  if (options.attach) {
    // The agent's own browser: no touch emulation, opened on the page already.
    const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port; await new Promise(resolve => probe.close(resolve));
    const own = await chromium.launch({ args: [`--remote-debugging-port=${port}`] }); cleanup.push(() => own.close());
    const page = await own.newPage({ viewport: { width: 390, height: 720 } }); await page.goto(site.url);
    cdpUrl = `http://127.0.0.1:${port}`;
  }
  const bridge = await createBridge({ ownerToken, agentToken, port: 0, allowLocalUrls: true }); cleanup.push(() => bridge.close());
  const call = (path: string, token: string, body?: unknown) => fetch(bridge.url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const request = await (await call('/api/requests', agentToken, { agent: 'Gesture fixture', title: 'Synthetic gestures', url: site.url, ttlSeconds: 120, ...(cdpUrl ? { cdpUrl } : {}) })).json() as { id: string };
  expect((await call(`/api/requests/${request.id}/approve`, ownerToken, {})).status).toBe(200);
  const ws = new WebSocket(bridge.url.replace('http:', 'ws:') + '/ws'); cleanup.push(async () => { ws.terminate(); });
  const messages: Header[] = []; const binary: Array<{ header: Header; jpeg: Buffer }> = []; const json: Header[] = [];
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) { const message = JSON.parse(data.toString()) as Header; if (message.type === 'frame') json.push(message); else messages.push(message); return; }
    const length = data.readUInt32BE(0);
    binary.push({ header: JSON.parse(data.subarray(4, 4 + length).toString()) as Header, jpeg: data.subarray(4 + length) });
  });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const send = (message: unknown) => ws.send(JSON.stringify(message));
  const next = async (type: string) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { const index = messages.findIndex(message => message.type === type); if (index !== -1) return messages.splice(index, 1)[0]; await pause(5); }
    throw new Error(`Expected WebSocket message ${type}`);
  };
  send({ type: 'auth', token: ownerToken }); const ready = await next('ready');
  send({ type: 'watch', requestId: request.id, viewport: { width: 390, height: 720, scale: 2, touch: true }, ...(options.stream === false ? {} : { stream: true }) });
  await expect.poll(() => binary.length + json.length, { timeout: 15000 }).toBeGreaterThan(0);
  await expect.poll(() => site.count('ready')).toBe(1);
  const touch = (phase: string, x: number, y: number, tap?: boolean) => send({ type: 'touch', phase, x, y, ...(tap ? { tap } : {}) });
  const mouse = (phase: string, x: number, y: number, tap?: boolean) => send({ type: 'mouse', phase, x, y, ...(tap ? { tap } : {}) });
  const complete = async () => {
    expect((await call(`/api/requests/${request.id}/complete`, ownerToken, {})).status).toBe(200);
    const result = await (await call(`/api/requests/${request.id}`, agentToken)).json() as { browser: { cdpUrl: string } };
    const agent = await chromium.connectOverCDP(result.browser.cdpUrl); cleanup.push(() => agent.close());
    return agent.contexts().flatMap(context => context.pages()).find(page => page.url() === site.url)!;
  };
  return { site, bridge, ws, ready, request, send, next, messages, binary, json, touch, mouse, complete, call };
}

describe('raw gestures and the live stream', () => {
  it('pushes sharp binary frames only while the page changes', async () => {
    const test = await phone();
    expect((test.ready.info as { streamAvailable?: boolean }).streamAvailable).toBe(true);
    expect(test.json).toEqual([]);
    const first = test.binary[0];
    expect(first.header).toMatchObject({ type: 'frame', requestId: test.request.id, width: 390, height: 720, url: test.site.url, gestures: true, navigationAvailable: true });
    expect(first.header.frameEpoch).toMatch(/^[0-9a-f-]{36}$/);
    // A JPEG at the phone's pixel density: 780 pixels across for a 390-point screen.
    expect(first.jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
    const start = first.jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    expect(first.jpeg.readUInt16BE(start + 7)).toBe(780);
    // A still page sends nothing more. The old timed capture sent one image a second.
    await pause(400); const still = test.binary.length; await pause(1300);
    expect(test.binary.length).toBe(still);
    // A swipe is a real touch: the page scrolls, keeps moving after the finger lifts, and frames follow it.
    test.touch('start', 200, 600);
    for (let step = 1; step <= 8; step++) { test.touch('move', 200, 600 - step * 45); await pause(16); }
    test.touch('end', 200, 240);
    await expect.poll(() => test.binary.length, { timeout: 5000 }).toBeGreaterThan(still + 5);
    const page = await test.complete();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(400); // 360 from the finger, the rest from momentum
  }, 40000);

  it('drags a puzzle to the end, wherever the moves were dropped in between', async () => {
    const test = await phone();
    // A tap on the field says a text field took focus, and never what it holds.
    test.touch('start', 100, 48); test.touch('end', 100, 48, true);
    expect(await test.next('editable')).toEqual({ type: 'editable', requestId: test.request.id, editable: true, kind: 'email' });
    expect(test.site.count('field-focused')).toBe(1);
    test.touch('start', 48, 138);
    // Far more moves than a page takes in one burst. Only the newest matters, plus the last before release.
    for (let step = 1; step <= 150; step++) test.touch('move', 48 + step * 1.7, 138);
    test.touch('end', 303, 138);
    await expect.poll(() => test.site.count('puzzle-solved'), { timeout: 5000 }).toBe(1);
    // A release that was not a tap reports nothing about focus.
    await pause(150); expect(test.messages.filter(message => message.type === 'editable')).toEqual([]);
    expect(test.messages.filter(message => message.type === 'error')).toEqual([]);
    const page = await test.complete();
    expect(await page.evaluate(() => (window as unknown as { gesture: { events: string[]; pointerTypes: string[] } }).gesture)).toEqual({ events: ['down', 'up'], pointerTypes: ['touch'] });
  }, 40000);

  it('lifts a held finger before the agent gets the browser, and when the phone leaves', async () => {
    const test = await phone();
    test.touch('start', 48, 138); test.touch('move', 120, 138);
    await pause(150);
    // The owner hands back with the finger still down.
    const page = await test.complete();
    const events = () => page.evaluate(() => (window as unknown as { gesture: { events: string[] } }).gesture.events);
    expect(await events()).toEqual(['down', 'cancel']);
    expect(await page.evaluate(() => (document.querySelector('#knob') as HTMLElement).offsetLeft)).toBe(0);
    expect(test.site.count('puzzle-solved')).toBe(0);
  }, 40000);

  it('cancels a drag when the phone disconnects mid-gesture', async () => {
    const test = await phone();
    test.touch('start', 48, 138); test.touch('move', 150, 138);
    await pause(150);
    test.ws.close();
    // A second phone finds the puzzle back at the start, and can solve it.
    const again = new WebSocket(test.bridge.url.replace('http:', 'ws:') + '/ws'); cleanup.push(async () => { again.terminate(); });
    await new Promise<void>((resolve, reject) => { again.once('open', resolve); again.once('error', reject); });
    let frames = 0; again.on('message', (_data, isBinary) => { if (isBinary) frames++; });
    again.send(JSON.stringify({ type: 'auth', token: ownerToken }));
    await pause(200);
    again.send(JSON.stringify({ type: 'watch', requestId: test.request.id, stream: true }));
    await expect.poll(() => frames, { timeout: 5000 }).toBeGreaterThan(0);
    const send = (phase: string, x: number, y: number) => again.send(JSON.stringify({ type: 'touch', phase, x, y }));
    send('start', 48, 138); for (let step = 1; step <= 10; step++) send('move', 48 + step * 26, 138); send('end', 308, 138);
    await expect.poll(() => test.site.count('puzzle-solved'), { timeout: 5000 }).toBe(1);
    const page = await test.complete();
    expect(await page.evaluate(() => (window as unknown as { gesture: { events: string[] } }).gesture.events)).toEqual(['down', 'cancel', 'down', 'up']);
  }, 40000);

  it('hovers, drags a selection and double clicks with a mouse', async () => {
    const test = await phone();
    test.mouse('move', 100, 228);
    await expect.poll(() => test.site.count('hovered'), { timeout: 5000 }).toBe(1);
    // Press at the start of the first word and drag to the end of the second.
    test.mouse('down', 21, 305); for (let step = 1; step <= 6; step++) test.mouse('move', 21 + step * 22, 305); test.mouse('up', 153, 305);
    test.mouse('down', 205, 305); test.mouse('up', 205, 305, true);
    await test.next('editable');
    test.mouse('down', 205, 305); test.mouse('up', 205, 305, true);
    await test.next('editable');
    const page = await test.complete();
    // The double click replaced the dragged selection with the word under it.
    expect(await page.evaluate(() => String(getSelection()).trim())).toBe('charlie');
    expect(test.messages.filter(message => message.type === 'error')).toEqual([]);
  }, 40000);

  it('selects exactly the dragged text', async () => {
    const test = await phone();
    test.mouse('down', 21, 305); for (let step = 1; step <= 6; step++) test.mouse('move', 21 + step * 22, 305); test.mouse('up', 153, 305);
    await pause(200);
    const page = await test.complete();
    expect(await page.evaluate(() => String(getSelection()))).toBe('alpha bravo');
  }, 40000);

  it('follows a window the page opens, and returns when it closes', async () => {
    const test = await phone();
    test.touch('start', 120, 410); test.touch('end', 120, 410, true);
    await expect.poll(() => test.site.count('window-ready'), { timeout: 5000 }).toBe(1);
    // The stream moves to the new window without the phone asking again.
    await expect.poll(() => test.binary.at(-1)!.header.url, { timeout: 5000 }).toBe(test.site.origin + '/window');
    expect(test.binary.at(-1)!.header).toMatchObject({ width: 390, height: 720, gestures: true });
    await pause(300);
    test.touch('start', 160, 140); test.touch('end', 160, 140, true);
    await expect.poll(() => test.site.count('window-tapped'), { timeout: 5000 }).toBe(1);
    // The window closed itself: the first page is live again and still takes touches.
    await expect.poll(() => test.binary.at(-1)!.header.url, { timeout: 5000 }).toBe(test.site.url);
    await pause(300);
    test.touch('start', 300, 410); test.touch('end', 300, 410, true);
    await expect.poll(() => test.site.count('corner-tapped'), { timeout: 5000 }).toBe(1);
    expect(test.messages.filter(message => message.type === 'error')).toEqual([]);
  }, 40000);

  it('drags and taps in a browser the agent attached', async () => {
    const test = await phone({ attach: true });
    expect(test.binary[0].header).toMatchObject({ width: 390, height: 720, gestures: true });
    // An attached browser keeps its own navigation controls.
    expect(test.binary[0].header.navigationAvailable).toBe(false);
    test.touch('start', 48, 138);
    for (let step = 1; step <= 20; step++) { test.touch('move', 48 + step * 13, 138); await pause(16); }
    await pause(120); test.touch('end', 308, 138);
    await expect.poll(() => test.site.count('puzzle-solved'), { timeout: 5000 }).toBe(1);
    test.touch('start', 100, 48); test.touch('end', 100, 48, true);
    expect(await test.next('editable')).toMatchObject({ editable: true, kind: 'email' });
    expect(test.messages.filter(message => message.type === 'error')).toEqual([]);
  }, 40000);

  it('refuses malformed pointer input and still serves clients that predate the stream', async () => {
    const test = await phone({ stream: false });
    // No stream was asked for: frames are JSON, as older apps expect.
    expect(test.binary).toEqual([]);
    expect(test.json[0]).toMatchObject({ type: 'frame', width: 390, height: 720, gestures: true });
    expect(typeof test.json[0].data).toBe('string');
    for (const bad of [
      { type: 'touch', phase: 'hover', x: 10, y: 10 }, { type: 'touch', phase: 'start', x: 391, y: 10 }, { type: 'touch', phase: 'start', x: 10, y: -1 },
      { type: 'touch', phase: 'start', x: 10, y: 10, tap: 'yes' }, { type: 'touch', phase: 'start', x: 10, y: 10, id: 1 }, { type: 'mouse', phase: 'start', x: 10, y: 10 },
      { type: 'mouse', phase: 'down', x: Number.NaN, y: 10 }, { type: 'mouse', phase: 'down', x: 10, y: 10, button: 'right' },
    ]) { test.send(bad); expect((await test.next('error')).message).toBe('The requested action was not accepted. Check that the session is still active.'); }
    // Classic taps and wheel scrolling keep working beside the new messages.
    test.send({ type: 'click', x: 300, y: 410 });
    await expect.poll(() => test.site.count('corner-tapped'), { timeout: 5000 }).toBe(1);
    test.send({ type: 'scroll', deltaX: 0, deltaY: 300, x: 200, y: 400 });
    await pause(300);
    const page = await test.complete();
    expect(await page.evaluate(() => window.scrollY)).toBe(300);
    expect(await page.evaluate(() => (window as unknown as { gesture: { events: string[] } }).gesture.events)).toEqual([]);
  }, 40000);
});
