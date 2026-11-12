import { Agent, request } from 'node:http';

/** Loopback only, on a private agent: keys never pass through an environment proxy. */
export function localJson<T>(port: number, path: string, options: { token?: string; body?: unknown; timeoutMs?: number } = {}): Promise<{ status: number; data: T }> {
  const agent = new Agent({ keepAlive: false });
  return new Promise<{ status: number; data: T }>((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const call = request({
      host: '127.0.0.1', port, path, agent, method: payload === undefined ? 'GET' : 'POST',
      headers: { ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) },
      timeout: options.timeoutMs ?? 5000,
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 1_000_000) call.destroy(new Error('Response too large.')); else chunks.push(Buffer.from(chunk)); });
      response.once('error', reject);
      response.once('end', () => {
        let data: unknown = {};
        try { data = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* Non-JSON answers are reported by status. */ }
        resolve({ status: response.statusCode ?? 502, data: data as T });
      });
    });
    call.once('timeout', () => call.destroy(new Error('The bridge did not answer in time.')));
    call.once('error', reject);
    call.end(payload);
  }).finally(() => agent.destroy());
}

export async function bridgeHealthy(port: number): Promise<boolean> {
  try { return (await localJson<{ ok?: boolean }>(port, '/api/health', { timeoutMs: 1500 })).data.ok === true; }
  catch { return false; }
}
