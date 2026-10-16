import WebSocket from 'ws';
import { Agent, request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { browserAvailable } from './browser';
import { ConfigError, readExistingConfig } from './config';
import { connectionOrigin } from './connection-options';

export interface ConnectionCheck {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
}
export interface DoctorOptions {
  port: number;
  configDirectory: string;
  appUrl: string;
  publicUrl?: string;
  timeoutMs?: number;
}
export interface DoctorReport { ok: boolean; checks: ConnectionCheck[]; notes: string[] }

class ProbeError extends Error {}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ProbeError('The endpoint returned no JSON body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) throw new ProbeError('The endpoint returned an oversized response instead of bridge health data.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ProbeError('The endpoint returned invalid JSON, possibly a tunnel protection or error page.'); }
  } finally { await reader.cancel().catch(() => undefined); }
}

async function httpProbe(origin: string, path: string, timeoutMs: number, options: { appOrigin?: string; preflight?: boolean } = {}) {
  try {
    const headers: Record<string, string> = {};
    if (options.appOrigin) headers.Origin = options.appOrigin;
    if (options.preflight) {
      headers['Access-Control-Request-Method'] = 'POST';
      headers['Access-Control-Request-Headers'] = 'authorization, content-type';
    }
    const response = await fetch(new URL(path, origin), {
      method: options.preflight ? 'OPTIONS' : 'GET', headers, redirect: 'manual', credentials: 'omit',
      cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ProbeError('The endpoint redirects. Use the direct bridge origin; redirects are not followed.');
    }
    if (options.preflight || response.status !== 200) {
      await response.body?.cancel();
      return { status: response.status, headers: response.headers, data: undefined };
    }
    return { status: response.status, headers: response.headers, data: await boundedJson(response) };
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new ProbeError('The endpoint timed out. Check that the bridge and tunnel are running.');
    throw new ProbeError('Could not reach the endpoint. Check its address, network connection and TLS certificate.');
  }
}

/** A private agent bypasses global fetch dispatchers and Node's environment-configured proxy agent. */
async function loopbackProbe(port: number, timeoutMs: number, options: { ownerToken?: string; appOrigin?: string; preflight?: boolean } = {}): Promise<{ status: number; headers: Headers; data?: unknown }> {
  const agent = new Agent({ keepAlive: false }); // No proxyEnv: direct sockets, even with NODE_USE_ENV_PROXY=1.
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    const finish = (error?: ProbeError, result?: { status: number; headers: Headers; data?: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response?.destroy();
      request?.destroy();
      agent.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new ProbeError('The local endpoint timed out. Check that the bridge is running.')), timeoutMs);
    const headers: Record<string, string> = {};
    if (options.ownerToken) headers.Authorization = `Bearer ${options.ownerToken}`;
    if (options.appOrigin) headers.Origin = options.appOrigin;
    if (options.preflight) {
      headers['Access-Control-Request-Method'] = 'POST';
      headers['Access-Control-Request-Headers'] = 'authorization, content-type';
    }
    request = httpRequest({ hostname: '127.0.0.1', port, path: options.ownerToken || options.preflight ? '/api/info' : '/api/health', method: options.preflight ? 'OPTIONS' : 'GET', agent, maxHeaderSize: 8192, headers }, incoming => {
      response = incoming;
      incoming.once('error', () => finish(new ProbeError('The local response was interrupted. Check the bridge port.')));
      const status = incoming.statusCode ?? 0;
      const receivedHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach(item => receivedHeaders.append(name, item));
        else if (value !== undefined) receivedHeaders.set(name, value);
      }
      if (options.preflight || status !== 200) {
        if (status >= 300 && status < 400) finish(new ProbeError('The local endpoint redirects. Check the bridge port; redirects are not followed.'));
        else finish(undefined, { status, headers: receivedHeaders });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > 4096) { finish(new ProbeError('The local endpoint returned an oversized response. Check the bridge port.')); return; }
        chunks.push(chunk);
      });
      incoming.once('end', () => {
        try { finish(undefined, { status, headers: receivedHeaders, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { finish(new ProbeError('The local endpoint returned invalid JSON. Check the bridge port.')); }
      });
    });
    request.once('error', () => finish(new ProbeError('Could not reach the local authority endpoint. Check the bridge port.')));
    request.end();
  });
}

async function websocketProbe(origin: string, appOrigin: string, timeoutMs: number, direct = false): Promise<void> {
  const url = new URL('/ws', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const agent = direct ? new Agent({ keepAlive: false }) : undefined;
    const socket = new WebSocket(url, { origin: appOrigin, agent, followRedirects: false, handshakeTimeout: timeoutMs, maxPayload: 4096, perMessageDeflate: false });
    const finish = (error?: ProbeError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      agent?.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new ProbeError('WebSocket upgrade timed out. Check tunnel WebSocket support and the allowed app origin.')), timeoutMs);
    socket.once('open', () => finish()); // No authentication or browser input frame is ever sent.
    socket.once('error', () => finish(new ProbeError('WebSocket upgrade failed. Check tunnel WebSocket support and the allowed app origin.')));
    socket.once('unexpected-response', (request, response) => {
      response.destroy();
      request.destroy();
      finish(new ProbeError('WebSocket upgrade was rejected. Check tunnel protection and the allowed app origin.'));
    });
  });
}

/** Only the fixed loopback /api/info probe receives authority. Public transport probes never do. */
export async function diagnoseConnection(options: DoctorOptions): Promise<DoctorReport> {
  const appOrigin = connectionOrigin(options.appUrl);
  const publicOrigin = options.publicUrl ? connectionOrigin(options.publicUrl) : undefined;
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid diagnostic port.');
  const localOrigin = `http://127.0.0.1:${options.port}`;
  const timeoutMs = options.timeoutMs ?? 5000;
  const checks: ConnectionCheck[] = [];
  const check = async (id: string, label: string, run: () => Promise<string>) => {
    try { checks.push({ id, label, status: 'pass', message: await run() }); }
    catch (error) { checks.push({ id, label, status: 'fail', message: error instanceof ProbeError || error instanceof ConfigError ? error.message : 'The check could not finish. Check local configuration and permissions.' }); }
  };
  let ownerToken: string | undefined;
  await check('config', 'Existing local configuration', async () => {
    ownerToken = (await readExistingConfig(options.configDirectory)).ownerToken;
    return 'Read valid local configuration without changing files or permissions.';
  });
  const health = async (origin: string) => {
    const response = origin === localOrigin ? await loopbackProbe(options.port, timeoutMs) : await httpProbe(origin, '/api/health', timeoutMs);
    if (response.status !== 200) throw new ProbeError(`Health endpoint returned HTTP ${response.status}. Check the bridge address and tunnel protection.`);
    if (!(response.data && typeof response.data === 'object' && 'ok' in response.data && response.data.ok === true)) throw new ProbeError('The endpoint did not return bridge health data. Check the origin and any tunnel protection page.');
    return 'Health endpoint responded. This alone does not establish endpoint ownership.';
  };
  await check('local-health', 'Local bridge', () => health(localOrigin));
  if (ownerToken) await check('local-auth', 'Local owner authentication', async () => {
    const response = await loopbackProbe(options.port, timeoutMs, { ownerToken });
    if (response.status === 401 || response.status === 403) throw new ProbeError('The running bridge rejected this configuration’s owner key. Check its port/config directory and restart it after key replacement.');
    if (response.status !== 200 || !response.data || typeof response.data !== 'object' || !('name' in response.data) || response.data.name !== 'Keep Safe') throw new ProbeError('The local endpoint did not return authenticated Keep Safe information.');
    return 'The bridge accepts this local configuration. No key was sent to the public origin.';
  });
  else checks.push({ id: 'local-auth', label: 'Local owner authentication', status: 'warn', message: 'Skipped because existing local configuration could not be read.' });
  checks.push(await browserAvailable()
    ? { id: 'chromium', label: 'Local Chromium binary', status: 'pass', message: 'Binary found. This check does not launch a browser or prove OS dependencies are installed.' }
    : { id: 'chromium', label: 'Local Chromium binary', status: 'fail', message: 'Binary missing. Run npx playwright install chromium on this computer.' });
  const cors = async (origin: string) => {
    const response = origin === localOrigin ? await loopbackProbe(options.port, timeoutMs, { appOrigin, preflight: true }) : await httpProbe(origin, '/api/info', timeoutMs, { appOrigin, preflight: true });
    const methods = response.headers.get('access-control-allow-methods')?.split(',').map(value => value.trim());
    const headers = response.headers.get('access-control-allow-headers')?.toLowerCase().split(',').map(value => value.trim());
    if (![200, 204].includes(response.status) || response.headers.get('access-control-allow-origin') !== appOrigin || !methods?.includes('GET') || !methods.includes('POST') || !headers?.includes('authorization') || !headers.includes('content-type')) throw new ProbeError('The app origin is not allowed by preflight. Restart the bridge with the same --app-url as the phone’s dashboard.');
    return 'Preflight permits authenticated queue and control requests from the configured app origin.';
  };
  await check('local-cors', 'Local app origin', () => cors(localOrigin));
  await check('local-websocket', 'Local WebSocket transport', async () => { await websocketProbe(localOrigin, appOrigin, timeoutMs, true); return 'Upgrade accepted for the app origin; closed without authenticating or opening a login request.'; });
  if (publicOrigin) {
    checks.push(publicOrigin.startsWith('https:')
      ? { id: 'public-https', label: 'Public HTTPS address', status: 'pass', message: 'HTTPS origin selected. The following probes verify TLS and transport from this computer.' }
      : { id: 'public-https', label: 'Public HTTPS address', status: 'warn', message: 'Loopback HTTP is for development. A phone needs an accessible HTTPS origin.' });
    await check('public-health', 'Public health transport', () => health(publicOrigin));
    await check('public-cors', 'Public app origin', () => cors(publicOrigin));
    await check('public-websocket', 'Public WebSocket transport', async () => { await websocketProbe(publicOrigin, appOrigin, timeoutMs); return 'Upgrade accepted for the app origin; no credentials or authentication frame were sent.'; });
  } else checks.push({ id: 'public-https', label: 'Phone connection', status: 'warn', message: 'No --public-url supplied. HTTPS, tunnel and remote WebSocket transport were not checked. Run setup for guidance.' });
  return {
    ok: !checks.some(value => value.status === 'fail'), checks,
    notes: ['Diagnostics do not change configuration or open a browser session. Public probes carry no keys or cookies.', 'Public checks verify transport from this computer, not endpoint ownership, phone reachability, live control or physical push delivery. Confirm your own tunnel destination before opening a private pairing link.'],
  };
}
