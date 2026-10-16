import { lookup } from 'node:dns/promises';
import { BlockList, isIP, connect, type Socket } from 'node:net';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type ClientRequest } from 'node:http';

export type AddressResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const reservedV4 = new BlockList();
const reservedV6 = new BlockList();
for (const [network, prefix] of [ ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4] ] as const) reservedV4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [ ['::', 96], ['::ffff:0:0', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8] ] as const) reservedV6.addSubnet(network, prefix, 'ipv6');

export function isLoopback(host: string) { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase()); }
export function publicAddress(address: string) {
  const family = isIP(address);
  return family !== 0 && !(family === 4 ? reservedV4.check(address, 'ipv4') : reservedV6.check(address, 'ipv6'));
}
export function validateTargetUrl(raw: unknown, allowLocalUrls = false): string {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('A valid HTTPS website URL is required.');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('A valid HTTPS website URL is required.'); }
  if (url.username || url.password) throw new Error('URLs must not contain credentials.');
  const local = isLoopback(url.hostname);
  if (!(url.protocol === 'https:' || (allowLocalUrls && local && url.protocol === 'http:'))) throw new Error('Only HTTPS websites are allowed. Local HTTP needs --allow-local-urls.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if ((local || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (isIP(host) && !publicAddress(host))) && !(allowLocalUrls && local)) throw new Error('Private network website URLs are disabled.');
  url.hash = '';
  return url.href;
}

export async function resolveDestination(host: string, allowLocalUrls = false, resolver: AddressResolver = hostname => lookup(hostname, { all: true, verbatim: true })) {
  const hostname = host.replace(/^\[|\]$/g, '');
  if (allowLocalUrls && isLoopback(hostname)) return { address: hostname === '::1' ? '::1' : '127.0.0.1', family: hostname === '::1' ? 6 : 4 };
  if (isLoopback(hostname)) throw new Error('Private network destinations are disabled.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([resolver(hostname), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Website DNS lookup timed out.')), 5000); timer.unref(); })]);
  } finally { if (timer) clearTimeout(timer); }
  // Reject mixed public/private answers too. Never silently select a public answer from a suspect set.
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Private or reserved network destinations are disabled.');
  return addresses[0];
}

/** Chromium's outbound HTTP proxy pins each connection to a validated DNS address.
 * HTTPS stays encrypted end to end through CONNECT; no passwords or cookies are parsed.
 */
export async function createOutboundProxy(allowLocalUrls: boolean, resolver?: AddressResolver) {
  const inbound = new Set<Socket>();
  const outbound = new Set<Socket>();
  const requests = new Set<ClientRequest>();
  const server = createServer((request, response) => {
    request.on('error', () => {});
    response.on('error', () => {});
    void (async () => {
      const target = new URL(validateTargetUrl(request.url, allowLocalUrls));
      if (target.protocol !== 'http:') throw new Error('HTTPS requires CONNECT.');
      const destination = await resolveDestination(target.hostname, allowLocalUrls, resolver);
      if (request.destroyed || response.destroyed) return;
      const headers: IncomingHttpHeaders = { ...request.headers, host: target.host };
      delete headers['proxy-authorization']; delete headers['proxy-connection'];
      const upstream = httpRequest({ host: destination.address, family: destination.family, port: Number(target.port || 80), path: `${target.pathname}${target.search}`, method: request.method, headers, timeout: 10_000 }, result => {
        if (!response.headersSent && !response.destroyed) response.writeHead(result.statusCode ?? 502, result.headers);
        result.pipe(response);
      });
      requests.add(upstream);
      upstream.on('close', () => requests.delete(upstream));
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => {
        if (!response.headersSent && !response.destroyed) response.writeHead(502);
        if (!response.destroyed) response.end();
      });
      request.pipe(upstream);
      request.on('aborted', () => upstream.destroy());
    })().catch(() => {
      if (!response.headersSent && !response.destroyed) response.writeHead(403);
      if (!response.destroyed) response.end();
    });
  });
  server.on('connection', socket => {
    socket.on('error', () => {});
    inbound.add(socket);
    socket.on('close', () => inbound.delete(socket));
    if (inbound.size > 128) socket.destroy();
  });
  server.on('connect', (request, client, head) => {
    client.on('error', () => {});
    void (async () => {
      const target = new URL(validateTargetUrl(`https://${request.url}`, allowLocalUrls));
      if (target.pathname !== '/' || target.search || target.hash) throw new Error('Invalid CONNECT authority.');
      const destination = await resolveDestination(target.hostname, allowLocalUrls, resolver);
      if (client.destroyed) return;
      const upstream = connect({ host: destination.address, family: destination.family, port: Number(target.port || 443) });
      outbound.add(upstream);
      upstream.on('close', () => outbound.delete(upstream));
      upstream.setTimeout(10_000, () => upstream.destroy());
      upstream.once('connect', () => {
        upstream.setTimeout(0);
        if (client.destroyed) { upstream.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    })().catch(() => {
      if (!client.destroyed) {
        try { client.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); } catch {}
        client.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    async close() {
      for (const req of requests) req.destroy();
      for (const connection of inbound) connection.destroy();
      for (const connection of outbound) connection.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
