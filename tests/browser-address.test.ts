import { expect, it } from 'vitest';
import { browserAddress } from '../apps/web/src/browser-address';

it('shows scheme and port without leaking credentials, paths, query, or fragments', () => {
  expect(browserAddress('https://user:secret@example.com:8443/login?code=sensitive#token'))
    .toEqual({ label: 'https://example.com:8443', secure: true });
  expect(browserAddress('http://example.com/login'))
    .toEqual({ label: 'http://example.com', secure: false });
  expect(browserAddress('https://example.com:443/login').label).toBe('https://example.com');
});

it('never presents a secure connection for opaque or invalid browser pages', () => {
  expect(browserAddress('about:blank')).toEqual({ label: 'about:blank', secure: false });
  expect(browserAddress('data:text/html,private-content')).toEqual({ label: 'data:', secure: false });
  expect(browserAddress('blob:https://example.com/private-id')).toEqual({ label: 'blob:', secure: false });
  expect(browserAddress('invalid-private-text')).toEqual({ label: 'Unknown page', secure: false });
});
