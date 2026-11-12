import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Agent, request as httpRequest } from 'node:http';
import type { CreateRequestInput, LoginRequest } from '../../shared/src/protocol.js';

export interface AgentRequest extends LoginRequest {
  browser?: { cdpUrl: string; pageUrl: string };
}

export interface BridgeClientOptions { url: string; token: string; fetch?: typeof fetch }

/** Keep local authority off global fetch/proxy dispatchers, including Node's environment proxy support. */
async function directLoopbackRequest(url: URL, init: RequestInit): Promise<Response> {
  const agent = new Agent({ keepAlive: false });
  try {
    return await new Promise<Response>((resolve, reject) => {
      const request = httpRequest(url, {
        agent, method: init.method, headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal ?? undefined,
      }, response => {
        const status = response.statusCode ?? 502;
        if (status >= 300 && status < 400) { response.destroy(); reject(new Error('Bridge redirects are disabled.')); return; }
        if (status < 200 || status >= 300) { response.destroy(); resolve(new Response(null, { status })); return; }
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.once('error', reject);
        response.once('aborted', () => reject(new Error('Bridge response was interrupted.')));
        response.once('end', () => {
          try { resolve(new Response([204, 205].includes(status) ? null : Buffer.concat(chunks), { status })); }
          catch { reject(new Error('Bridge response could not be read.')); }
        });
      });
      request.once('error', reject);
      request.end(typeof init.body === 'string' ? init.body : undefined);
    });
  } finally { agent.destroy(); }
}

export class BridgeClient {
  private readonly url: URL;
  private readonly fetcher: (url: URL, init: RequestInit) => Promise<Response>;
  constructor(private readonly options: BridgeClientOptions) {
    this.url = new URL(options.url);
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password || this.url.search || this.url.hash) {
      throw new Error('Bridge URL must be an HTTP(S) origin without credentials, query, or fragment.');
    }
    if (this.url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(this.url.hostname)) {
      throw new Error('Use HTTPS for a remote bridge.');
    }
    if (!options.token) throw new Error('Agent token is missing. Start the bridge or set KEEP_SAFE_AGENT_TOKEN.');
    this.fetcher = options.fetch ?? (this.url.protocol === 'http:' ? directLoopbackRequest : fetch);
  }

  private async request<T>(path: string, input?: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    let response: Response;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15000);
    try {
      response = await this.fetcher(new URL(path, this.url), {
        method: input === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${this.options.token}`, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: input === undefined ? undefined : JSON.stringify(input),
        signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
        redirect: 'error',
      });
    } catch {
      if (options.signal?.aborted) throw new Error('Wait cancelled.');
      throw new Error('Cannot reach the Keep Safe bridge. Check it is running and the configured URL is reachable.');
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('Bridge rejected the agent token. Use the agent token, not the owner pairing token.');
      if (response.status === 404) throw new Error('Login request was not found.');
      throw new Error(`Bridge request failed (${response.status}). Check the URL, request fields, and bridge status.`);
    }
    try { return await response.json() as T; }
    catch { throw new Error('Bridge returned an unreadable response. Check the bridge URL and status.'); }
  }

  create(input: CreateRequestInput): Promise<AgentRequest> { return this.request('/api/requests', input); }
  /** Paired-phone counts. Older bridges have no such route, so failure means unknown. */
  async status(): Promise<{ phones: number; notifications: number } | undefined> {
    try { return await this.request('/api/status'); } catch { return undefined; }
  }
  get(id: string): Promise<AgentRequest> { return this.request(`/api/requests/${encodeURIComponent(id)}`); }

  /**
   * Long poll: the bridge holds the response until the request's updatedAt differs from `since`
   * (default: its value on arrival), it reaches an outcome, or `waitSeconds` (1–30) pass.
   */
  poll(id: string, waitSeconds: number, since?: string, signal?: AbortSignal): Promise<AgentRequest> {
    const query = new URLSearchParams({ wait: String(waitSeconds), ...(since ? { since } : {}) });
    return this.request(`/api/requests/${encodeURIComponent(id)}?${query}`, undefined, { timeoutMs: 15000 + waitSeconds * 1000, signal });
  }

  async wait(id: string, timeoutSeconds = 60, signal?: AbortSignal): Promise<AgentRequest> {
    const deadline = Date.now() + Math.max(1, Math.min(timeoutSeconds, 120)) * 1000;
    let since: string | undefined;
    while (true) {
      signal?.throwIfAborted();
      const started = Date.now();
      const waitSeconds = Math.floor(Math.min(deadline - started, 30_000) / 1000);
      const request = waitSeconds >= 1 ? await this.poll(id, waitSeconds, since, signal) : await this.get(id);
      if (['completed', 'denied', 'expired'].includes(request.status) || Date.now() >= deadline) return request;
      const changed = since !== undefined && request.updatedAt !== since;
      since = request.updatedAt;
      // A bridge without long polling answers at once; keep the earlier 1.5-second cadence for it.
      const pause = changed ? 0 : Math.min(1500 - (Date.now() - started), deadline - Date.now());
      if (pause > 0) await new Promise<void>((done, reject) => {
        const finish = () => { signal?.removeEventListener('abort', abort); done(); };
        const timer = setTimeout(finish, pause);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Wait cancelled.')); };
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
  }
}

export async function configuredClient(): Promise<BridgeClient> {
  const configDir = process.env.KEEP_SAFE_CONFIG_DIR ?? resolve(process.cwd(), '.keep-safe');
  let file: { agentToken?: string; port?: number } = {};
  // A background bridge records its port beside the keys.
  if (!process.env.KEEP_SAFE_BRIDGE_URL) {
    try { const daemon = JSON.parse(await readFile(resolve(configDir, 'daemon.json'), 'utf8')) as { port?: unknown }; if (Number.isInteger(daemon.port)) file.port = daemon.port as number; }
    catch { /* The default port applies. */ }
  }
  if (!process.env.KEEP_SAFE_AGENT_TOKEN) {
    try { file = { port: file.port, ...JSON.parse(await readFile(resolve(configDir, 'config.json'), 'utf8')) }; }
    catch { /* Explicit error below avoids leaking a path or file contents. */ }
  }
  return new BridgeClient({
    url: process.env.KEEP_SAFE_BRIDGE_URL ?? `http://127.0.0.1:${file.port ?? 4318}`,
    token: process.env.KEEP_SAFE_AGENT_TOKEN ?? file.agentToken ?? '',
  });
}
