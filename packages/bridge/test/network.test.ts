import { afterEach, expect, it } from 'vitest';
import { createServer, get } from 'node:http';
import { connect } from 'node:net';
import { createOutboundProxy, publicAddress, resolveDestination, validateTargetUrl } from '../src/network';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it('rejects DNS answers resolving to private, reserved, or mixed network addresses', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', '::ffff:0:127.0.0.1', 'fd00::1', 'fe80::1', '64:ff9b::7f00:1', '100::1', '2001::1', '2002:7f00:1::']) {
    expect(publicAddress(address), address).toBe(false);
    await expect(resolveDestination('looks-public.example', false, async () => [{ address, family: address.includes(':') ? 6 : 4 }])).rejects.toThrow();
  }
  await expect(resolveDestination('mixed.example', false, async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }])).rejects.toThrow();
  expect(await resolveDestination('public.example', false, async () => [{ address: '93.184.216.34', family: 4 }])).toEqual({ address: '93.184.216.34', family: 4 });
  // The development exception is restricted to an explicit loopback hostname, not arbitrary DNS aliases.
  await expect(resolveDestination('alias.example', true, async () => [{ address: '127.0.0.1', family: 4 }])).rejects.toThrow();
  expect(await resolveDestination('localhost', true)).toEqual({ address: '127.0.0.1', family: 4 });
  for (const url of ['https://2130706433', 'https://0x7f000001', 'https://[::ffff:127.0.0.1]', 'https://[::]']) expect(() => validateTargetUrl(url)).toThrow();
});

it('blocks private DNS at the proxy CONNECT boundary', async () => {
  const proxy = await createOutboundProxy(false, async () => [{ address: '127.0.0.1', family: 4 }]);
  cleanup.push(() => proxy.close());
  const url = new URL(proxy.url);
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    const data: Buffer[] = [];
    socket.once('connect', () => socket.write('CONNECT innocent-looking.example:443 HTTP/1.1\r\nHost: innocent-looking.example:443\r\n\r\n'));
    socket.on('data', part => data.push(part)); socket.once('end', () => resolve(Buffer.concat(data).toString())); socket.once('error', reject);
  });
  expect(response).toContain('403 Forbidden');
});

it('survives client socket resets during slow DNS resolution on CONNECT', async () => {
  const proxy = await createOutboundProxy(false, () => new Promise(resolve => setTimeout(() => resolve([{ address: '93.184.216.34', family: 4 }]), 80)));
  cleanup.push(() => proxy.close());
  const endpoint = new URL(proxy.url);
  await new Promise<void>(resolve => {
    const socket = connect(Number(endpoint.port), endpoint.hostname, () => {
      socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
      socket.resetAndDestroy();
      setTimeout(resolve, 120);
    });
  });
});

it('only proxies explicit local HTTP websites when development mode is enabled', async () => {
  const fixture = createServer((_request, response) => response.end('local test website'));
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => fixture.close(() => resolve())));
  const target = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/login`;
  const proxy = await createOutboundProxy(true);
  cleanup.push(() => proxy.close());
  const endpoint = new URL(proxy.url);
  const response = await new Promise<string>((resolve, reject) => {
    get({ hostname: endpoint.hostname, port: endpoint.port, path: target }, result => { const data: Buffer[] = []; result.on('data', part => data.push(part)); result.once('end', () => resolve(Buffer.concat(data).toString())); }).once('error', reject);
  });
  expect(response).toBe('local test website');
});
