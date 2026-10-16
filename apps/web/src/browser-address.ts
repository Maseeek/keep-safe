/** Show the security-relevant origin without paths, credentials, or URL secrets. */
export function browserAddress(raw: string) {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return { label: url.origin, secure: url.protocol === 'https:' };
    }
    return {
      label: url.protocol === 'about:' && url.pathname === 'blank' ? 'about:blank' : url.protocol,
      secure: false,
    };
  } catch {
    return { label: 'Unknown page', secure: false };
  }
}
