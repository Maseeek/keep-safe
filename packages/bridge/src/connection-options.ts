import { ConfigError } from './config';

export const hostedAppOrigin = 'https://keep-safe-eight.vercel.app';

/** Tailscale addresses: the CGNAT range it assigns, MagicDNS names, and the bare machine name. */
export function tailnetHost(hostname: string): boolean {
  const ip = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (ip) return Number(ip[1]) >= 64 && Number(ip[1]) <= 127;
  return /^[a-z0-9-]{1,63}$/i.test(hostname) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(hostname);
}

/** Plain HTTP is accepted on loopback, and on a tailnet only when the caller opts in:
 * Tailscale already encrypts that traffic between the owner's own devices. */
export function connectionOrigin(value: string, options: { tailnetHttp?: boolean } = {}): string {
  const message = 'Public and app URLs must be root HTTPS origins (or loopback HTTP for development), without credentials, path, query or fragment.';
  try {
    if (value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error();
    const url = new URL(value);
    const plainAllowed = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || (options.tailnetHttp === true && tailnetHost(url.hostname));
    if (url.username || url.password || url.href !== `${url.origin}/` || !['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !plainAllowed)) throw new Error();
    return url.origin;
  } catch { throw new ConfigError(message); }
}

export function connectionPort(value: string): number {
  if (!/^\d+$/.test(value)) throw new ConfigError('Port must be between 1 and 65535.');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError('Port must be between 1 and 65535.');
  return port;
}
