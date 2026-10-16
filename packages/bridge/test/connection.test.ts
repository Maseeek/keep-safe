import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, chmod, stat, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { loadConfig, readExistingConfig } from '../src/config';
import { connectionOrigin, connectionPort, hostedAppOrigin } from '../src/connection-options';
import { diagnoseConnection } from '../src/doctor';
import { connectionSetup } from '../src/setup';
import { createBridge } from '../src/server';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'keep-safe-connection-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function bridgeFixture() {
  const path = await directory();
  const config = await loadConfig(path);
  let opened = 0;
  const bridge = await createBridge({ ...config, port: 0, appUrl: hostedAppOrigin, browserFactory: async () => { opened++; throw new Error('Diagnostics must not launch a browser'); } });
  cleanup.push(() => bridge.close());
  return { path, config, bridge, port: Number(new URL(bridge.url).port), get opened() { return opened; } };
}
async function endpoint(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  const sockets = new WebSocketServer({ noServer: true });
  const requests: Array<{ path: string; method: string; headers: IncomingMessage['headers'] }> = [];
  const frames: unknown[] = [];
  server.prependListener('request', request => requests.push({ path: request.url!, method: request.method!, headers: request.headers }));
  server.on('upgrade', (request, socket, head) => {
    requests.push({ path: request.url!, method: 'UPGRADE', headers: request.headers });
    sockets.handleUpgrade(request, socket, head, client => { client.on('message', data => frames.push(data)); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { for (const client of sockets.clients) client.terminate(); sockets.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests, frames };
}
const reportCheck = (report: Awaited<ReturnType<typeof diagnoseConnection>>, id: string) => report.checks.find(check => check.id === id)!;

it('checks a real bridge without creating requests, changing configuration or disclosing keys', async () => {
  const fixture = await bridgeFixture();
  await chmod(fixture.path, 0o750);
  await chmod(join(fixture.path, 'config.json'), 0o640);
  await writeFile(join(fixture.path, 'bridge.lock'), 'diagnostics must leave this untouched');
  const before = await readFile(join(fixture.path, 'config.json'));
  const report = await diagnoseConnection({ port: fixture.port, configDirectory: fixture.path, appUrl: hostedAppOrigin });
  expect(report.ok).toBe(true);
  for (const id of ['config', 'local-health', 'local-auth', 'chromium', 'local-cors', 'local-websocket']) expect(reportCheck(report, id).status).toBe('pass');
  expect(reportCheck(report, 'public-https').status).toBe('warn');
  expect(fixture.opened).toBe(0);
  expect(await readFile(join(fixture.path, 'config.json'))).toEqual(before);
  expect((await stat(fixture.path)).mode & 0o777).toBe(0o750);
  expect((await stat(join(fixture.path, 'config.json'))).mode & 0o777).toBe(0o640);
  expect(await readFile(join(fixture.path, 'bridge.lock'), 'utf8')).toBe('diagnostics must leave this untouched');
  const output = JSON.stringify(report);
  for (const secret of [fixture.config.ownerToken, fixture.config.agentToken, fixture.config.vapid.privateKey]) expect(output.includes(secret)).toBe(false);
});

it('keeps all public HTTP and WebSocket probes unauthenticated and sends the actual app Origin', async () => {
  const fixture = await bridgeFixture();
  const remote = await endpoint((request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Origin': hostedAppOrigin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' }).end();
    } else response.end(JSON.stringify({ ok: true }));
  });
  const report = await diagnoseConnection({ port: fixture.port, configDirectory: fixture.path, appUrl: hostedAppOrigin, publicUrl: remote.origin });
  expect(report.ok).toBe(true);
  expect(reportCheck(report, 'public-https').status).toBe('warn'); // Explicit loopback development fixture.
  expect(remote.requests.map(request => `${request.method} ${request.path}`)).toEqual(['GET /api/health', 'OPTIONS /api/info', 'UPGRADE /ws']);
  for (const request of remote.requests) {
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers.cookie).toBeUndefined();
    if (request.method !== 'GET') expect(request.headers.origin).toBe(hostedAppOrigin);
  }
  expect(remote.requests[1].headers['access-control-request-method']).toBe('POST');
  expect(remote.frames).toEqual([]);
  expect(fixture.opened).toBe(0);
  expect(report.notes.join(' ')).toContain('not endpoint ownership');
});

it('distinguishes mismatched local authority from a blocked app origin without changing keys', async () => {
  const fixture = await bridgeFixture();
  const other = await directory();
  await loadConfig(other);
  const report = await diagnoseConnection({ port: fixture.port, configDirectory: other, appUrl: 'https://wrong-app.example' });
  expect(report.ok).toBe(false);
  expect(reportCheck(report, 'local-health').status).toBe('pass');
  expect(reportCheck(report, 'local-auth').message).toContain('rejected this configuration');
  expect(reportCheck(report, 'local-cors').status).toBe('fail');
  expect(reportCheck(report, 'local-websocket').status).toBe('fail');
});

it('never creates missing config paths or reveals invalid file contents', async () => {
  const fixture = await bridgeFixture();
  const parent = await directory();
  const missing = join(parent, 'absent', 'config');
  const report = await diagnoseConnection({ port: fixture.port, configDirectory: missing, appUrl: hostedAppOrigin });
  expect(reportCheck(report, 'config').status).toBe('fail');
  expect(reportCheck(report, 'local-auth').status).toBe('warn');
  expect(await readdir(parent)).toEqual([]);
  await writeFile(join(parent, 'config.json'), '{not-json-private-marker');
  const invalid = await diagnoseConnection({ port: fixture.port, configDirectory: parent, appUrl: hostedAppOrigin });
  expect(JSON.stringify(invalid).includes('not-json-private-marker')).toBe(false);
  expect(await readdir(parent)).toEqual(['config.json']);
  await expect(readExistingConfig(parent)).rejects.toThrow('Invalid bridge configuration');
});

it('does not follow health, preflight, WebSocket or authenticated loopback redirects', async () => {
  const fixture = await bridgeFixture();
  const destination = await endpoint((_request, response) => response.end('{"ok":true}'));
  const redirect = await endpoint((_request, response) => response.writeHead(302, { Location: destination.origin + '/private-redirect-marker' }).end());
  // Override the fixture WS handler to respond with an HTTP redirect instead of upgrading.
  const server = createServer((_request, response) => response.writeHead(302, { Location: destination.origin }).end());
  server.on('upgrade', (_request, socket) => socket.end(`HTTP/1.1 302 Found\r\nLocation: ${destination.origin}\r\nContent-Length: 0\r\n\r\n`));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const redirectPort = (server.address() as { port: number }).port;
  const report = await diagnoseConnection({ port: redirectPort, configDirectory: fixture.path, appUrl: hostedAppOrigin, publicUrl: `http://127.0.0.1:${redirectPort}` });
  expect(report.ok).toBe(false);
  for (const id of ['local-health', 'local-auth', 'public-health', 'public-cors', 'public-websocket']) expect(reportCheck(report, id).status).toBe('fail');
  expect(destination.requests).toEqual([]);
  expect(JSON.stringify(report).includes('private-redirect-marker')).toBe(false);
  // The independent redirect endpoint also covers a body/Location string that must never be printed.
  const remote = await diagnoseConnection({ port: fixture.port, configDirectory: fixture.path, appUrl: hostedAppOrigin, publicUrl: redirect.origin });
  expect(reportCheck(remote, 'public-health').message).toContain('redirects');
  expect(JSON.stringify(remote).includes('private-redirect-marker')).toBe(false);
});

it('bounds response size and time through body consumption and sanitizes remote error pages', async () => {
  const fixture = await bridgeFixture();
  for (const mode of ['oversized', 'invalid', 'stalled', 'error']) {
    const remote = await endpoint((request, response) => {
      if (request.method === 'OPTIONS') { response.writeHead(403).end('private-remote-body'); return; }
      if (mode === 'oversized') response.end('private-remote-body'.repeat(500));
      else if (mode === 'invalid') response.end('<html>private-remote-body</html>');
      else if (mode === 'error') response.writeHead(503).end('private-remote-body');
      else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"private-remote-body":'); }
    });
    const report = await diagnoseConnection({ port: fixture.port, configDirectory: fixture.path, appUrl: hostedAppOrigin, publicUrl: remote.origin, timeoutMs: 200 });
    expect(reportCheck(report, 'public-health').status).toBe('fail');
    expect(reportCheck(report, 'public-cors').status).toBe('fail');
    expect(JSON.stringify(report).includes('private-remote-body')).toBe(false);
    expect(reportCheck(report, 'public-health').message).toContain(mode === 'oversized' ? 'oversized' : mode === 'invalid' ? 'invalid JSON' : mode === 'stalled' ? 'timed out' : 'HTTP 503');
  }
});

it('rejects unsupported origins and ports before setup or diagnostics can act', async () => {
  for (const value of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com?secret=value', 'https://example.com#secret', 'https://example.com?', 'https://example.com#', 'file:///private', 'not-a-url', 'https://example.com\n']) {
    expect(() => connectionOrigin(value)).toThrow('root HTTPS origins');
    await expect(diagnoseConnection({ port: 4318, configDirectory: '/unused', appUrl: value })).rejects.toThrow('root HTTPS origins');
  }
  for (const value of ['0', '-1', '65536', '1.5', '0x10', '1e3', 'Infinity', '']) expect(() => connectionPort(value)).toThrow('Port must');
  expect(connectionOrigin('https://EXAMPLE.com:443/')).toBe('https://example.com');
  expect(connectionOrigin('http://[::1]:4318/')).toBe('http://[::1]:4318');
});

it.each(['oversized', 'invalid', 'stalled', 'error'])('bounds the direct local authority response: %s', async mode => {
  const fixture = await bridgeFixture();
  const local = await endpoint((_request, response) => {
    if (mode === 'oversized') response.end('private-local-body'.repeat(500));
    else if (mode === 'invalid') response.end('<html>private-local-body</html>');
    else if (mode === 'error') response.writeHead(503).end('private-local-body');
    else { response.writeHead(200); response.write('{"private-local-body":'); }
  });
  const report = await diagnoseConnection({ port: Number(new URL(local.origin).port), configDirectory: fixture.path, appUrl: hostedAppOrigin, timeoutMs: 200 });
  expect(reportCheck(report, 'local-auth').status).toBe('fail');
  expect(JSON.stringify(report).includes('private-local-body')).toBe(false);
  for (const secret of [fixture.config.ownerToken, fixture.config.agentToken, fixture.config.vapid.privateKey]) expect(JSON.stringify(report).includes(secret)).toBe(false);
});

it('prints shell-safe setup commands without reading or creating a configuration directory', async () => {
  const parent = await directory();
  const path = join(parent, "uncreated'$(touch SHOULD-NOT-EXIST)");
  const setup = connectionSetup({ port: 4318, configDirectory: path });
  const capture = `npm() { printf '%s\\0' "$@"; }\n${setup.commands.localStart}`;
  const { stdout } = await promisify(execFile)('bash', ['-c', capture], { cwd: parent });
  expect(stdout.split('\0')).toEqual(['run', 'bridge', '--', '--port', '4318', '--app-url', hostedAppOrigin, '--config-dir', path, '']);
  expect(await readdir(parent)).toEqual([]);
  expect(setup.commands.publicStart).toContain('YOUR-TUNNEL');
  expect(setup.commands.doctor).toContain("'doctor'");
});
