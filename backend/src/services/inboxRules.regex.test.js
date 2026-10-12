import { describe, it, expect, vi, beforeEach } from 'vitest';
import vm from 'node:vm';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./ruleForwarder.js', () => ({ forwardRuleMessage: vi.fn() }));

const { query } = await import('./db.js');
import { applyInboxRules, isDangerousRegex, matchUserRegex, RULE_TEXT_CHAR_CAP } from './inboxRules.js';

// Patterns the static check passes although their backtracking is polynomial (O(n^k)):
// '.*a.*a.*a.*b' takes seconds on 200 characters and does not finish on 400.
const POLYNOMIAL = ['.*a.*a.*a.*a.*a.*a.*b', '[a-z]*[a-z]*[a-z]*[a-z]*!', '.*a.*a.*a.*b'];

describe('user regex time budget', () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each(POLYNOMIAL)('the static check alone does not catch %s', (pattern) => {
    expect(isDangerousRegex(pattern)).toBe(false);
  });

  it('stops a backtracking pattern at the budget and reports no match', () => {
    expect(matchUserRegex('.*a.*a.*a.*b', 'a'.repeat(2000), { timeoutMs: 5 })).toBe(false);
  });

  it('never runs a pattern again after it exhausted the budget', () => {
    expect(matchUserRegex('[a-z]*[a-z]*[a-z]*[a-z]*!', 'a'.repeat(3000), { timeoutMs: 5 })).toBe(false);
    const run = vi.spyOn(vm.Script.prototype, 'runInContext');
    expect(matchUserRegex('[a-z]*[a-z]*[a-z]*[a-z]*!', 'abc!', { timeoutMs: 5 })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('still matches ordinary patterns, case-insensitively', () => {
    expect(matchUserRegex('^invoice #\\d+', 'Invoice #42 for October')).toBe(true);
    expect(matchUserRegex('^invoice #\\d+', 'Re: Invoice #42')).toBe(false);
  });

  it('matches only within the first RULE_TEXT_CHAR_CAP characters', () => {
    const text = `${'x'.repeat(RULE_TEXT_CHAR_CAP)}needle`;
    expect(matchUserRegex('needle', text)).toBe(false);
    expect(matchUserRegex('needle', `needle${text}`)).toBe(true);
  });

  it('a body rule with a polynomial pattern does not fire and the sync completes', async () => {
    query.mockImplementation(async (sql) => {
      if (/FROM inbox_rules/.test(sql)) {
        return { rows: [{
          id: 'rule-redos', account_id: 'acc-1', enabled: true, stop_processing: false,
          condition_logic: 'AND',
          conditions: [{ field: 'body', operator: 'regex', value: '.*a.*a.*a.*a.*a.*a.*b' }],
          actions: [{ type: 'mark_read' }],
        }] };
      }
      if (/SELECT id, body_text, body_html FROM messages/.test(sql)) {
        return { rows: [{ id: 'msg-1', body_text: 'a'.repeat(5000), body_html: null }] };
      }
      return { rows: [] };
    });
    const imap = { bulkMoveMessages: vi.fn(), setFlag: vi.fn(), _guardMoveUid: vi.fn(), _unguardMoveUid: vi.fn() };
    const msg = { id: 'msg-1', uid: 1, folder: 'INBOX', account_id: 'acc-1', fromEmail: 'a@example.com',
      fromName: '', to: [], subject: 's', is_read: false, hasAttachments: false, parsedHeaders: {} };
    const result = await applyInboxRules([msg], { id: 'acc-1', folder_mappings: {} }, imap);
    expect(imap.setFlag).not.toHaveBeenCalled();
    expect(result.remaining.map(m => m.id)).toEqual(['msg-1']);
    expect(result.mutedIds.size ?? result.mutedIds.length).toBe(0);
  });
});
