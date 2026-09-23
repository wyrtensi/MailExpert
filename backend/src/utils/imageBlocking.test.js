import { describe, expect, it } from 'vitest';
import { shouldBlockImages } from './imageBlocking.js';

const letter = { from_email: 'News@Shop.Example.com' };

describe('shouldBlockImages', () => {
  it('shows remote images when the user never chose, or turned blocking off', () => {
    expect(shouldBlockImages(undefined, letter)).toBe(false);
    expect(shouldBlockImages({}, letter)).toBe(false);
    expect(shouldBlockImages({ blockRemoteImages: false }, letter)).toBe(false);
  });

  it('blocks them when the user turned blocking on', () => {
    expect(shouldBlockImages({ blockRemoteImages: true }, letter)).toBe(true);
  });

  it('with blocking on, still shows them for a whitelisted sender or domain', () => {
    expect(shouldBlockImages({ blockRemoteImages: true, imageWhitelist: { addresses: ['news@shop.example.com'] } }, letter)).toBe(false);
    expect(shouldBlockImages({ blockRemoteImages: true, imageWhitelist: { domains: ['example.com'] } }, letter)).toBe(false);
    expect(shouldBlockImages({ blockRemoteImages: true, imageWhitelist: { domains: ['other.example'] } }, letter)).toBe(true);
  });
});
