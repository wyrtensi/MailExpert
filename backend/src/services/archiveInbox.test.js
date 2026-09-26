import { describe, it, expect, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({
  resolveArchiveFolder: vi.fn(async () => 'Archive'),
  isAllMailFolder: vi.fn(async () => false),
  adjustFolderCounts: vi.fn(),
}));
import { query } from './db.js';
import { archiveInboxCopy } from './archiveInbox.js';

// An INBOX copy whose DB-first move is pending holds a placeholder uid (services/moveQueue.js):
// it is on its way elsewhere, and a MOVE from that uid would reach nothing.
describe('archiveInboxCopy', () => {
  it('does not archive a copy whose move is pending', async () => {
    const imap = { moveMessage: vi.fn(), _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn() };
    await expect(archiveInboxCopy(imap, { id: 'a', folder_mappings: {} }, { id: 'ib', uid: '-6' }))
      .rejects.toMatchObject({ movePending: true, code: 'move_pending' });
    expect(imap.moveMessage).not.toHaveBeenCalled();
    expect(imap._guardMoveUid).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
