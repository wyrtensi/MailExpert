// MAIL_DELETE_ENABLED=false: a saved rule with the delete action and the block list leave the
// letter where it is instead of moving it to Trash or deleting it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({
  resolveArchiveFolder: vi.fn(),
  isAllMailFolder: vi.fn(),
  resolveTrashFolder: vi.fn(async () => 'Trash'),
  resolveAllTrashPaths: vi.fn(async () => new Set(['Trash'])),
  getDeleteStrategy: vi.fn(() => ({ action: 'move', destination: 'Trash' })),
  adjustFolderCounts: vi.fn(),
}));
vi.mock('./ruleForwarder.js', () => ({ forwardRuleMessage: vi.fn() }));

const { query } = await import('./db.js');
const { applyInboxRules, applyBlockList } = await import('./inboxRules.js');

const account = { id: 'acc-1', folder_mappings: {} };
const msg = () => ({
  id: 'msg-1', uid: 100, folder: 'INBOX', account_id: 'acc-1',
  fromEmail: 'sender@example.com', fromName: 'Sender',
  to: [], subject: 'Test', is_read: false, hasAttachments: false, parsedHeaders: {},
});
const rule = {
  id: 'rule-1', account_id: 'acc-1', enabled: true, stop_processing: false, condition_logic: 'AND',
  conditions: [{ field: 'from', operator: 'contains', value: 'sender@' }],
  actions: [{ type: 'delete', value: '' }],
};
const imap = {
  bulkMoveMessages: vi.fn(async () => ({ failed: [], uidMap: new Map([[100, 500]]) })),
  setFlag: vi.fn(),
  _guardMoveUid: vi.fn(),
  _unguardMoveUid: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('with MAIL_DELETE_ENABLED=false', () => {
  beforeEach(() => { vi.stubEnv('MAIL_DELETE_ENABLED', 'false'); });

  it('a rule that deletes leaves the letter in the inbox', async () => {
    query.mockResolvedValue({ rows: [rule] });
    const result = await applyInboxRules([msg()], account, imap);
    expect(result.remaining).toHaveLength(1);
    expect(imap.bulkMoveMessages).not.toHaveBeenCalled();
    expect(imap.setFlag).not.toHaveBeenCalled();
  });

  it('the block list leaves a blocked sender\'s letter in place', async () => {
    query.mockResolvedValue({ rows: [{ email_address: 'sender@example.com' }] });
    const remaining = await applyBlockList([msg()], account, imap);
    expect(remaining).toHaveLength(1);
    expect(imap.bulkMoveMessages).not.toHaveBeenCalled();
  });
});

describe('with MAIL_DELETE_ENABLED unset', () => {
  it('a rule that deletes moves the letter to Trash', async () => {
    query.mockResolvedValue({ rows: [rule] });
    const result = await applyInboxRules([msg()], account, imap);
    expect(result.remaining).toHaveLength(0);
    expect(imap.bulkMoveMessages).toHaveBeenCalledWith(account, [100], 'INBOX', 'Trash', expect.anything());
  });
});
