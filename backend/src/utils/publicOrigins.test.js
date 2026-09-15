import { describe, it, expect } from 'vitest';
import { allowedRequestOrigin, getPublicOrigins } from './publicOrigins.js';

const fakeReq = (protocol, host) => ({
  protocol,
  get: (name) => (name.toLowerCase() === 'host' ? host : undefined),
});

describe('getPublicOrigins', () => {
  it('collects APP_URL and APP_ALT_URLS as unique origins', () => {
    expect(getPublicOrigins({
      APP_URL: 'https://mail.example.com/',
      APP_ALT_URLS: ' https://direct.example.com/login , not a url, ftp://files.example.com, https://mail.example.com',
    })).toEqual(['https://mail.example.com', 'https://direct.example.com']);
  });

  it('is empty without configured URLs', () => {
    expect(getPublicOrigins({})).toEqual([]);
  });
});

describe('allowedRequestOrigin', () => {
  const env = { APP_URL: 'https://mail.example.com', APP_ALT_URLS: 'https://direct.example.com' };

  it('returns the origin of a request that came through a public origin', () => {
    expect(allowedRequestOrigin(fakeReq('https', 'direct.example.com'), env)).toBe('https://direct.example.com');
    expect(allowedRequestOrigin(fakeReq('https', 'mail.example.com'), env)).toBe('https://mail.example.com');
  });

  it('rejects other hosts, another scheme and a missing host', () => {
    expect(allowedRequestOrigin(fakeReq('https', 'evil.example.com'), env)).toBeNull();
    expect(allowedRequestOrigin(fakeReq('http', 'direct.example.com'), env)).toBeNull();
    expect(allowedRequestOrigin(fakeReq('https', undefined), env)).toBeNull();
  });
});
