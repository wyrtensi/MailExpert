import { describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));

import { query } from './db.js';
import { threadingDiagnostics } from './threadingDiagnostics.js';

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';

function baseRow(overrides = {}) {
  return {
    message_id: '<msg-1@example.com>',
    in_reply_to: null,
    thread_references: null,
    provider_thread_id: null,
    provider_message_id: null,
    thread_id: null,
    threading_reason: null,
    account_id: ACCOUNT_ID,
    is_deleted: false,
    thread_mode: 'rfc',
    ...overrides,
  };
}

describe('threadingDiagnostics', () => {
  it('is null when the message row is missing', async () => {
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [] });
    expect(await threadingDiagnostics(MESSAGE_ID)).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('is null when the message row was soft-deleted', async () => {
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [baseRow({ is_deleted: true })] });
    expect(await threadingDiagnostics(MESSAGE_ID)).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reports a Gmail thread with its provider id and reason', async () => {
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [baseRow({
      provider_thread_id: '9988776655',
      thread_id: 'gmail:9988776655',
      threading_reason: 'gmail-thrid',
      thread_mode: 'gmail',
    })] });
    query.mockResolvedValueOnce({ rows: [{ folder: 'INBOX', count: 2 }] });

    const result = await threadingDiagnostics(MESSAGE_ID);
    expect(result).toMatchObject({
      providerThreadId: '9988776655',
      threadId: 'gmail:9988776655',
      reason: 'gmail-thrid',
      mode: 'gmail',
      conversation: { total: 2, folders: [{ folder: 'INBOX', count: 2 }] },
    });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('GROUP BY folder'), [ACCOUNT_ID, 'gmail:9988776655']);
  });

  it('parses the References header for an RFC row', async () => {
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [baseRow({
      in_reply_to: '<parent@example.com>',
      thread_references: '<root@example.com> <parent@example.com>',
      thread_id: '<root@example.com>',
      threading_reason: 'rfc-ancestor',
    })] });
    query.mockResolvedValueOnce({ rows: [{ folder: 'INBOX', count: 1 }] });

    const result = await threadingDiagnostics(MESSAGE_ID);
    expect(result.inReplyTo).toBe('<parent@example.com>');
    expect(result.references).toEqual(['<root@example.com>', '<parent@example.com>']);
    expect(result.reason).toBe('rfc-ancestor');
  });

  it('groups a null thread_id under the message\'s own id, one letter in one folder', async () => {
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [baseRow()] });
    query.mockResolvedValueOnce({ rows: [{ folder: 'Archive', count: 1 }] });

    const result = await threadingDiagnostics(MESSAGE_ID);
    expect(result.threadId).toBeNull();
    expect(result.conversation).toEqual({ total: 1, folders: [{ folder: 'Archive', count: 1 }] });
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [ACCOUNT_ID, MESSAGE_ID]);
  });

  it('scopes the folder grouping to this account and thread_id, ordered by count then folder', async () => {
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [baseRow({ thread_id: '<root@example.com>', threading_reason: 'rfc-root' })] });
    query.mockResolvedValueOnce({ rows: [
      { folder: 'INBOX', count: 3 },
      { folder: 'Archive', count: 1 },
    ] });

    const result = await threadingDiagnostics(MESSAGE_ID);
    expect(result.conversation.total).toBe(4);
    expect(result.conversation.folders).toEqual([
      { folder: 'INBOX', count: 3 },
      { folder: 'Archive', count: 1 },
    ]);
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain('account_id = $1');
    expect(sql).toContain('thread_key = $2');
    expect(sql).toContain('is_deleted = false');
    expect(params).toEqual([ACCOUNT_ID, '<root@example.com>']);
  });
});
