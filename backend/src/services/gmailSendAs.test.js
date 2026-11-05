import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchGmailSendAs, planSendAsSync, GmailSendAsError, GMAIL_SEND_AS_URL } from './gmailSendAs.js';

describe('fetchGmailSendAs', () => {
  let fetchMock;
  beforeEach(() => { fetchMock = vi.fn(); global.fetch = fetchMock; });
  afterEach(() => { vi.restoreAllMocks(); delete global.fetch; });

  it('sends Bearer token and returns sendAs array', async () => {
    const list = [{ sendAsEmail: 'a@example.com' }];
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ sendAs: list }) });
    const signal = new AbortController().signal;
    expect(await fetchGmailSendAs({ accessToken: 'tok', signal })).toEqual(list);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(GMAIL_SEND_AS_URL);
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.signal).toBe(signal);
  });

  it('maps 401/429/503 to codes unauthorized/rate_limited/upstream', async () => {
    for (const [status, code] of [[401, 'unauthorized'], [429, 'rate_limited'], [503, 'upstream'], [403, 'upstream']]) {
      fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({ error: 'secret-body' }) });
      const err = await fetchGmailSendAs({ accessToken: 'tok-secret' }).catch((e) => e);
      expect(err).toBeInstanceOf(GmailSendAsError);
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
      expect(err.message).not.toContain('tok-secret');
      expect(err.message).not.toContain('secret-body');
    }
  });

  it('maps a network failure to upstream with null status', async () => {
    fetchMock.mockRejectedValue(new Error('boom tok-secret'));
    const err = await fetchGmailSendAs({ accessToken: 'tok-secret' }).catch((e) => e);
    expect(err.code).toBe('upstream');
    expect(err.status).toBeNull();
    expect(err.message).not.toContain('tok-secret');
  });

  it('throws bad_response when sendAs is missing', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const err = await fetchGmailSendAs({ accessToken: 't' }).catch((e) => e);
    expect(err.code).toBe('bad_response');
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } });
    expect((await fetchGmailSendAs({ accessToken: 't' }).catch((e) => e)).code).toBe('bad_response');
  });

  it('returns [] for { sendAs: [] }', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ sendAs: [] }) });
    expect(await fetchGmailSendAs({ accessToken: 't' })).toEqual([]);
  });
});

const sa = (email, extra = {}) => ({ sendAsEmail: email, displayName: '', verificationStatus: 'accepted', ...extra });
const plan = (args) => planSendAsSync({ accountEmail: 'me@example.com', existing: [], sendAs: [], ...args });

describe('planSendAsSync', () => {
  it('skips primary, pending and the mailbox address', () => {
    const p = plan({
      sendAs: [
        sa('me@example.com', { isPrimary: true }),
        sa('ME@example.com'),
        sa('pending@example.com', { verificationStatus: 'pending' }),
        sa('', {}),
        sa('ok@example.com'),
      ],
    });
    expect(p.create.map((f) => f.email)).toEqual(['ok@example.com']);
    expect(p.update).toEqual([]);
  });

  it('treats JSmith@ and jsmith@ as the same alias', () => {
    const row = { id: 'r1', name: 'jsmith', email: 'jsmith@example.com', reply_to: null, signature: null, source: 'gmail' };
    const p = plan({ existing: [row], sendAs: [sa('JSmith@example.com')] });
    expect(p.create).toEqual([]);
    expect(p.remove).toEqual([]);
    expect(p.update).toEqual([{ id: 'r1', fields: { name: 'JSmith', email: 'JSmith@example.com', reply_to: null, signature: '' } }]);
    const same = plan({ existing: [{ ...row, email: 'JSmith@example.com', name: 'JSmith' }], sendAs: [sa('jsmith@example.com')] });
    expect(same.update).toHaveLength(1); // case of the address differs from Gmail
  });

  it('updates only changed gmail rows, adopts matching manual rows, removes vanished gmail rows, never touches other manual rows', () => {
    const existing = [
      { id: 'g1', name: 'Same', email: 'same@example.com', reply_to: '', signature: '', source: 'gmail' },
      { id: 'g2', name: 'Old', email: 'chg@example.com', reply_to: null, signature: null, source: 'gmail' },
      { id: 'g3', name: 'Gone', email: 'gone@example.com', reply_to: null, signature: null, source: 'gmail' },
      { id: 'm1', name: 'Man', email: 'Adopt@example.com', reply_to: null, signature: null, source: 'manual' },
      { id: 'm2', name: 'Other', email: 'other@example.com', reply_to: null, signature: null, source: 'manual' },
      { id: 'm3', name: 'Own', email: 'ME@example.com', reply_to: null, signature: null, source: 'manual' },
    ];
    const p = plan({
      existing,
      sendAs: [
        sa('same@example.com', { displayName: 'Same' }),
        sa('chg@example.com', { displayName: 'New', replyToAddress: 'r@example.com' }),
        sa('adopt@example.com', { displayName: 'Adopted' }),
        sa('fresh@example.com', { displayName: 'Fresh' }),
        sa('me@example.com'),
      ],
    });
    expect(p.update.map((u) => u.id)).toEqual(['g2']);
    expect(p.update[0].fields.reply_to).toBe('r@example.com');
    expect(p.adopt.map((a) => a.id)).toEqual(['m1']);
    expect(p.adopt[0].fields.name).toBe('Adopted');
    expect(p.create.map((f) => f.email)).toEqual(['fresh@example.com']);
    expect(p.remove).toEqual(['g3']);
  });

  it('falls back to local part when displayName is blank', () => {
    const p = plan({ sendAs: [sa('sales@example.com', { displayName: '   ' })] });
    expect(p.create[0].name).toBe('sales');
  });

  it('stores a missing, empty or sanitized-away send-as signature as an empty string', () => {
    const p = plan({
      sendAs: [
        sa('none@example.com'),
        sa('empty@example.com', { signature: '' }),
        sa('script@example.com', { signature: '<script>x</script>' }),
      ],
    });
    expect(p.create.map((f) => f.signature)).toEqual(['', '', '']);
  });

  it('updates a gmail row holding a null signature to an empty one', () => {
    const row = { id: 'g1', name: 'a', email: 'a@example.com', reply_to: null, signature: null, source: 'gmail' };
    const p = plan({ existing: [row], sendAs: [sa('a@example.com', { displayName: 'a' })] });
    expect(p.update).toEqual([{ id: 'g1', fields: { name: 'a', email: 'a@example.com', reply_to: null, signature: '' } }]);
  });
});
