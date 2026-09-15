import { describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { defaultAddressBookId } from './addressBooks.js';

describe('defaultAddressBookId', () => {
  it('returns the shared book', async () => {
    const queryFn = vi.fn().mockResolvedValueOnce({ rows: [{ id: 'book-1' }] });
    expect(await defaultAddressBookId(queryFn)).toBe('book-1');
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn.mock.calls[0][0]).toBe('SELECT id FROM address_books WHERE is_default');
  });

  it('creates the shared book when it is missing', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({ rows: [] })                  // no shared book
      .mockResolvedValueOnce({ rows: [] })                  // insert (or a concurrent request won)
      .mockResolvedValueOnce({ rows: [{ id: 'book-2' }] }); // read it back
    expect(await defaultAddressBookId(queryFn)).toBe('book-2');
    expect(queryFn.mock.calls[1][0]).toBe('INSERT INTO address_books (name, is_default) VALUES ($1, true) ON CONFLICT DO NOTHING');
    expect(queryFn.mock.calls[1][1]).toEqual(['Contacts']);
  });
});
