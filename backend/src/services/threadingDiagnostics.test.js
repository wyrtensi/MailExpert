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
    // The generated column: COALESCE(thread_id, id::text). Defaults to the row's own id,
    // matching a null thread_id above.
    thread_key: MESSAGE_ID,
    threading_reason: null,
    account_id: ACCOUNT_ID,
    is_deleted: false,
    thread_mode: 'rfc',
    ...overrides,
  };
}

// Queues the message-row response plus the total/folder pair threadingDiagnostics fires
// with Promise.all (in that call order).
function mockConversation(totalRow, folderRows) {
  query.mockResolvedValueOnce({ rows: [totalRow] });
  query.mockResolvedValueOnce({ rows: folderRows });
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
      thread_key: 'gmail:9988776655',
      threading_reason: 'gmail-thrid',
      thread_mode: 'gmail',
    })] });
    mockConversation({ total: 2 }, [{ folder: 'INBOX', count: 2 }]);

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
      thread_key: '<root@example.com>',
      threading_reason: 'rfc-ancestor',
    })] });
    mockConversation({ total: 1 }, [{ folder: 'INBOX', count: 1 }]);

    const result = await threadingDiagnostics(MESSAGE_ID);
    expect(result.inReplyTo).toBe('<parent@example.com>');
    expect(result.references).toEqual(['<root@example.com>', '<parent@example.com>']);
    expect(result.reason).toBe('rfc-ancestor');
  });

  it('groups a null thread_id under the message\'s own id, one letter in one folder', async () => {
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [baseRow()] });
    mockConversation({ total: 1 }, [{ folder: 'Archive', count: 1 }]);

    const result = await threadingDiagnostics(MESSAGE_ID);
    expect(result.threadId).toBeNull();
    expect(result.conversation).toEqual({ total: 1, folders: [{ folder: 'Archive', count: 1 }] });
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [ACCOUNT_ID, MESSAGE_ID]);
  });

  it('uses thread_key from the message row (not a re-derived value) to scope both queries', async () => {
    query.mockReset();
    // An empty-string thread_id would diverge from COALESCE(thread_id, id::text) if re-derived
    // in JS with `row.thread_id || messageId` — the stored thread_key is authoritative.
    query.mockResolvedValueOnce({ rows: [baseRow({ thread_id: '', thread_key: 'weird-key' })] });
    mockConversation({ total: 1 }, [{ folder: 'INBOX', count: 1 }]);

    await threadingDiagnostics(MESSAGE_ID);
    const totalCall = query.mock.calls[1];
    const folderCall = query.mock.calls[2];
    expect(totalCall[1]).toEqual([ACCOUNT_ID, 'weird-key']);
    expect(folderCall[1]).toEqual([ACCOUNT_ID, 'weird-key']);
  });

  it('scopes the folder grouping to this account and thread_id, ordered by count then folder', async () => {
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [baseRow({
      thread_id: '<root@example.com>', thread_key: '<root@example.com>', threading_reason: 'rfc-root',
    })] });
    mockConversation({ total: 4 }, [
      { folder: 'INBOX', count: 3 },
      { folder: 'Archive', count: 1 },
    ]);

    const result = await threadingDiagnostics(MESSAGE_ID);
    expect(result.conversation.total).toBe(4);
    expect(result.conversation.folders).toEqual([
      { folder: 'INBOX', count: 3 },
      { folder: 'Archive', count: 1 },
    ]);
    const [sql, params] = query.mock.calls[2];
    expect(sql).toContain('account_id = $1');
    expect(sql).toContain('thread_key = $2');
    expect(sql).toContain('is_deleted = false');
    expect(params).toEqual([ACCOUNT_ID, '<root@example.com>']);
  });

  it('counts distinct letters for total, not rows — a letter synced into two folders is one letter', async () => {
    // Reproduces the bug: a 2-letter Gmail conversation where every letter also has a copy in
    // [Gmail]/All Mail. Rows: 4 (2 letters x 2 folders each). The thread list and
    // /thread/:threadId both dedupe by message_id; this total must match, not the summed
    // per-folder row counts (which would wrongly report 4).
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [baseRow({
      thread_id: '<root@example.com>', thread_key: '<root@example.com>', threading_reason: 'rfc-root',
    })] });
    mockConversation({ total: 2 }, [
      { folder: 'INBOX', count: 2 },
      { folder: '[Gmail]/All Mail', count: 2 },
    ]);

    const result = await threadingDiagnostics(MESSAGE_ID);
    expect(result.conversation.total).toBe(2);
    expect(result.conversation.folders).toEqual([
      { folder: 'INBOX', count: 2 },
      { folder: '[Gmail]/All Mail', count: 2 },
    ]);

    // The dedicated total query counts distinct identified letters plus unidentified ones —
    // never a plain count(*), which would double the real letter count here.
    const totalSql = query.mock.calls[1][0];
    expect(totalSql).toContain('DISTINCT message_id');
    expect(totalSql).toContain('message_id IS NULL');
  });
});
