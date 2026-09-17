import { describe, expect, it, vi } from 'vitest';
import { providerThreadIndexState } from './providerThreadIndex.js';

describe('providerThreadIndexState', () => {
  it.each([
    [[], 'missing'],
    [[{ indisvalid: true }], 'valid'],
    [[{ indisvalid: false }], 'invalid'],
  ])('%j -> %s', async (rows, expected) => {
    const query = vi.fn(async () => ({ rows }));
    expect(await providerThreadIndexState(query)).toBe(expected);
    expect(query.mock.calls[0][0]).toMatch(/relname = 'idx_messages_provider_thread'/);
  });
});
