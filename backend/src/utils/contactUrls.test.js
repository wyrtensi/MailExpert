import { describe, expect, it } from 'vitest';
import { normalizeContactUrls } from './contactUrls.js';

describe('normalizeContactUrls', () => {
  it('keeps http(s) addresses and adds https:// to a bare host', () => {
    expect(normalizeContactUrls([
      { value: ' example.com/team ', type: 'work' },
      { value: 'http://intranet.example.com', type: 'home' },
    ])).toEqual([
      { value: 'https://example.com/team', type: 'work' },
      { value: 'http://intranet.example.com', type: 'home' },
    ]);
  });

  it('skips empty rows and defaults an unknown type to work', () => {
    expect(normalizeContactUrls([{ value: '' }, { value: 'example.org', type: 'blog' }]))
      .toEqual([{ value: 'https://example.org', type: 'work' }]);
    expect(normalizeContactUrls(undefined)).toEqual([]);
  });

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com', 'https://', 'not a url at all'])(
    'rejects %s', (value) => {
      expect(() => normalizeContactUrls([{ value }])).toThrow(/not a valid http or https address/);
    },
  );

  it('rejects a non-array and too many websites', () => {
    expect(() => normalizeContactUrls('https://example.com')).toThrow(/must be an array/);
    expect(() => normalizeContactUrls(Array.from({ length: 21 }, (_, i) => ({ value: `site${i}.example.com` }))))
      .toThrow(/at most 20/);
  });
});

describe('vCard websites', async () => {
  const { generateVCard, parseVCard } = await import('./vcard.js');
  it('writes and reads URL lines', () => {
    const vcard = generateVCard({ uid: 'u1', displayName: 'Dana', urls: [{ value: 'https://dana.example.com/a;b', type: 'work' }] });
    expect(vcard).toContain('URL;TYPE=WORK:https://dana.example.com/a\\;b');
    expect(parseVCard(vcard).urls).toEqual([{ value: 'https://dana.example.com/a;b', type: 'work' }]);
  });
});
