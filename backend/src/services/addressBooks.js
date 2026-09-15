import { query } from './db.js';

export const DEFAULT_ADDRESS_BOOK_NAME = 'Contacts';

// The shared address book that contacts created by hand, recipients of sent mail and senders
// learned from inbound mail go to. Migration 0056 creates it; if it is ever missing it is
// created again. A concurrent request creating it first hits the single-default index, so
// the insert becomes a no-op and the read below finds that book.
export async function defaultAddressBookId(queryFn = query) {
  const existing = await queryFn('SELECT id FROM address_books WHERE is_default');
  if (existing.rows.length) return existing.rows[0].id;
  await queryFn('INSERT INTO address_books (name, is_default) VALUES ($1, true) ON CONFLICT DO NOTHING', [DEFAULT_ADDRESS_BOOK_NAME]);
  const created = await queryFn('SELECT id FROM address_books WHERE is_default');
  return created.rows[0].id;
}
