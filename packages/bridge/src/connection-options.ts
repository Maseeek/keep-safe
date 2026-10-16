import { ConfigError } from './config';

export const hostedAppOrigin = 'https://keep-safe-eight.vercel.app';

export function connectionOrigin(value: string): string {
  const message = 'Public and app URLs must be root HTTPS origins (or loopback HTTP for development), without credentials, path, query or fragment.';
  try {
    if (value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error();
    const url = new URL(value);
    if (url.username || url.password || url.href !== `${url.origin}/` || !['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error();
    return url.origin;
  } catch { throw new ConfigError(message); }
}

export function connectionPort(value: string): number {
  if (!/^\d+$/.test(value)) throw new ConfigError('Port must be between 1 and 65535.');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError('Port must be between 1 and 65535.');
  return port;
}
