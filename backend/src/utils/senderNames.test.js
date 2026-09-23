import { describe, expect, it, vi } from 'vitest';
import { SENDER_NAME_MAX, addSecondSenderName, parseSenderNames } from './senderNames.js';

describe('parseSenderNames', () => {
  it('trims both names and treats empty ones as none', () => {
    expect(parseSenderNames({ senderName: '  Иван Петров ', senderNameAlt: ' Ivan Petrov ' }))
      .toEqual({ senderName: 'Иван Петров', senderNameAlt: 'Ivan Petrov' });
    expect(parseSenderNames({ senderName: '   ', senderNameAlt: '' })).toEqual({ senderName: null, senderNameAlt: null });
    expect(parseSenderNames(undefined)).toEqual({ senderName: null, senderNameAlt: null });
  });

  it('drops a second name that repeats the first, and caps the length', () => {
    expect(parseSenderNames({ senderName: 'Sales', senderNameAlt: 'sales' })).toEqual({ senderName: 'Sales', senderNameAlt: null });
    expect(parseSenderNames({ senderName: 'x'.repeat(300) }).senderName).toHaveLength(SENDER_NAME_MAX);
  });

  it('refuses a name that would add a header', () => {
    expect(parseSenderNames({ senderName: 'Sales\r\nBcc: a@b.example' }).error).toBeTruthy();
    expect(parseSenderNames({ senderName: 'Sales', senderNameAlt: 'x\ny' }).error).toBeTruthy();
  });
});

describe('addSecondSenderName', () => {
  it('adds the second name as an alias with the mailbox address, or nothing without one', async () => {
    const client = { query: vi.fn(async () => ({ rows: [{ id: 'al-1', name: 'Ivan Petrov', email: 'sales@example.com' }] })) };
    expect(await addSecondSenderName(client, { accountId: 'acc-1', email: 'sales@example.com', senderNameAlt: 'Ivan Petrov' }))
      .toEqual({ id: 'al-1', name: 'Ivan Petrov', email: 'sales@example.com' });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO account_aliases'), ['acc-1', 'Ivan Petrov', 'sales@example.com']);
    client.query.mockClear();
    expect(await addSecondSenderName(client, { accountId: 'acc-1', email: 'sales@example.com', senderNameAlt: null })).toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });
});
