import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { query } from './db.js';
import { CONTACT_LETTERS_MAX_LIMIT, contactLetters } from './contactLetters.js';

afterEach(() => {
  query.mockReset();
});

describe('contactLetters', () => {
  it('is null for a contact that does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // contact lookup

    const result = await contactLetters('missing-id');

    expect(result).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('is empty, with no further queries, for a contact with no email address', async () => {
    query.mockResolvedValueOnce({ rows: [{ emails: [] }] }); // contact lookup

    const result = await contactLetters('contact-1');

    expect(result).toEqual({ received: 0, sent: 0, lastDate: null, total: 0, items: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('is empty, with no message query, when no account is enabled', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ emails: [{ value: 'maya@c.example' }] }] }) // contact
      .mockResolvedValueOnce({ rows: [] }); // enabled accounts

    const result = await contactLetters('contact-1');

    expect(result).toEqual({ received: 0, sent: 0, lastDate: null, total: 0, items: [] });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('queries own addresses, alias addresses and folder skips per account, and clamps limit/offset', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ emails: [{ value: ' Maya@C.example ' }, { value: 'm.chen@c.example' }] }] }) // contact
      .mockResolvedValueOnce({ rows: [{ id: 'acct-1' }, { id: 'acct-2' }] }) // enabled accounts
      .mockResolvedValueOnce({
        rows: [
          { id: 'acct-1', email_address: 'sales@x.example', folder_mappings: { trash: 'Trash', spam: 'Spam' } },
          { id: 'acct-2', email_address: 'ops@x.example', folder_mappings: {} },
        ],
      }) // account details
      .mockResolvedValueOnce({ rows: [{ account_id: 'acct-1', email: 'help@x.example' }] }) // aliases
      .mockResolvedValueOnce({ rows: [{ received: '3', sent: '1', last_date: '2026-09-16T08:45:00.000Z', total: '4' }] }) // aggregate
      .mockResolvedValueOnce({
        rows: [
          { id: 'm1', account_id: 'acct-1', folder: 'INBOX', subject: 'Hi', snippet: 's', date: '2026-09-16T08:45:00.000Z', direction: 'in' },
        ],
      }); // page

    const result = await contactLetters('contact-1', { limit: 999, offset: -5 });

    expect(query).toHaveBeenCalledTimes(6);

    // Aggregate and page queries share the same filter params (calls 5 and 6, 0-indexed 4/5).
    const aggParams = query.mock.calls[4][1];
    const pageCall = query.mock.calls[5];
    const pageParams = pageCall[1];

    const [allFromAddresses, accountIds, contactAddresses, ownAccountIds, ownEmails, skipAccountIds, skipFolders] = aggParams;
    expect(accountIds).toEqual(['acct-1', 'acct-2']);
    expect(contactAddresses).toEqual(['maya@c.example', 'm.chen@c.example']);
    // Own addresses include both accounts' own address plus the alias, each paired with its account.
    expect(ownAccountIds).toEqual(['acct-1', 'acct-1', 'acct-2']);
    expect(ownEmails).toEqual(['sales@x.example', 'help@x.example', 'ops@x.example']);
    // The indexed filter address list is the union of contact + every own address.
    expect(allFromAddresses.sort()).toEqual(
      ['maya@c.example', 'm.chen@c.example', 'sales@x.example', 'help@x.example', 'ops@x.example'].sort(),
    );
    // Only acct-1 defines trash/spam folders.
    expect(skipAccountIds).toEqual(['acct-1', 'acct-1']);
    expect(skipFolders).toEqual(['Trash', 'Spam']);

    // limit/offset are clamped and appended as the last two page-query params.
    expect(pageParams.slice(7)).toEqual([CONTACT_LETTERS_MAX_LIMIT, 0]);
    expect(pageCall[0]).toContain('LIMIT $8 OFFSET $9');

    expect(result).toEqual({
      received: 3,
      sent: 1,
      lastDate: '2026-09-16T08:45:00.000Z',
      total: 4,
      items: [{ id: 'm1', account_id: 'acct-1', folder: 'INBOX', subject: 'Hi', snippet: 's', date: '2026-09-16T08:45:00.000Z', direction: 'in' }],
    });
  });
});
