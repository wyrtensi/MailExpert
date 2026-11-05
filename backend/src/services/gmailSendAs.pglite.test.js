import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// syncGmailSendAs on the real schema: reads the send-as list with the mailbox's OAuth token and
// applies the plan to account_aliases in one transaction, with one journal entry when it changed
// something. The token manager and fetch are mocked; the database is a real (in-process) Postgres.

const dbState = vi.hoisted(() => ({ db: null }));
vi.mock('./db.js', () => ({
  query: (sql, params) => dbState.db.query(sql, params),
  withTransaction: (fn) => dbState.db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
}));
vi.mock('./oauth/tokenManager.js', () => ({
  ensureFreshOAuthAccount: vi.fn(),
  // A minimal stand-in for the real class (tested in tokenManager.test.js).
  OAuthTokenError: class OAuthTokenError extends Error {
    constructor(code) {
      super(`OAuth token error: ${code}`);
      this.name = 'OAuthTokenError';
      this.code = code;
    }
  },
}));
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn(() => Promise.resolve()) } }));

const { createRealSchemaDb } = await import('./testing/realSchema.js');
const { ensureFreshOAuthAccount, OAuthTokenError } = await import('./oauth/tokenManager.js');
const { pluginRegistry } = await import('../plugins/registry.js');
const { setMailEngine } = await import('../plugins/mailEngine.js');
const { sanitizeSignature } = await import('./emailSanitizer.js');
const { GMAIL_SEND_AS_URL, GmailSendAsError, syncGmailSendAs } = await import('./gmailSendAs.js');

const SALES = '71000000-0000-4000-8000-000000000001';
const USER = '72000000-0000-4000-8000-000000000001';
const TOKEN = 'plain-access-token-1';
const FRESH_TOKEN = 'plain-access-token-2';

let db;

beforeAll(async () => {
  db = await createRealSchemaDb();
  dbState.db = db;
}, 120000);
afterAll(async () => { await db.close(); });

const sendAsEntry = (email, extra = {}) => ({
  sendAsEmail: email, displayName: `Name ${email}`, verificationStatus: 'accepted', isPrimary: false, ...extra,
});
const PRIMARY = { sendAsEmail: 'sales@example.com', displayName: 'Sales', isPrimary: true, verificationStatus: 'accepted' };

const okResponse = (sendAs) => ({ ok: true, status: 200, json: async () => ({ sendAs }) });
const errorResponse = (status) => ({ ok: false, status, json: async () => ({ error: { message: 'nope' } }) });

let fetchMock;
let engine;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ensureFreshOAuthAccount.mockReset();
  ensureFreshOAuthAccount.mockImplementation(async (account) => account);
  pluginRegistry.runHook.mockClear();
  engine = { broadcast: vi.fn() };
  setMailEngine(engine);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await db.exec('DELETE FROM mailbox_audit_log; DELETE FROM account_aliases; DELETE FROM email_accounts; DELETE FROM users;');
  await db.query("INSERT INTO users (id, username, email) VALUES ($1, 'anna', 'anna@example.com')", [USER]);
  await db.query(
    `INSERT INTO email_accounts (id, name, email_address, imap_host, oauth_provider, oauth_access_token, oauth_refresh_token)
     VALUES ($1, 'Sales', 'sales@example.com', 'imap.gmail.com', 'google', $2, 'plain-refresh-token')`,
    [SALES, TOKEN],
  );
});

const aliases = async () => (await db.query(
  'SELECT id, name, email, reply_to, signature, source FROM account_aliases WHERE account_id = $1 ORDER BY email',
  [SALES],
)).rows;
const auditRows = async () => (await db.query(
  "SELECT actor_user_id, actor_email, account_id, account_email, details FROM mailbox_audit_log WHERE action = 'mailbox.aliases_synced' ORDER BY occurred_at, id",
)).rows;
const syncedAt = async () => (await db.query('SELECT gmail_send_as_synced_at FROM email_accounts WHERE id = $1', [SALES])).rows[0].gmail_send_as_synced_at;
const insertAlias = async (email, { name = 'Old', source = 'manual', signature = null } = {}) => (await db.query(
  'INSERT INTO account_aliases (account_id, name, email, signature, source) VALUES ($1, $2, $3, $4, $5) RETURNING *',
  [SALES, name, email, signature, source],
)).rows[0];

describe('syncGmailSendAs', () => {
  it('creates gmail aliases from send-as and sets gmail_send_as_synced_at', async () => {
    fetchMock.mockResolvedValue(okResponse([
      PRIMARY,
      sendAsEntry('info@example.com', { replyToAddress: 'reply@example.com' }),
      sendAsEntry('pending@example.com', { verificationStatus: 'pending' }),
    ]));

    const result = await syncGmailSendAs(SALES, { actor: { userId: USER, email: 'anna@example.com' } });

    expect(result).toMatchObject({ status: 'synced', added: ['info@example.com'], updated: [], removed: [] });
    expect(result.syncedAt).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(GMAIL_SEND_AS_URL);
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(await aliases()).toEqual([expect.objectContaining({
      name: 'Name info@example.com', email: 'info@example.com', reply_to: 'reply@example.com', signature: '', source: 'gmail',
    })]);
    expect(await syncedAt()).toBeInstanceOf(Date);
    const audit = await auditRows();
    expect(audit).toEqual([{
      actor_user_id: USER, actor_email: 'anna@example.com', account_id: SALES, account_email: 'sales@example.com',
      details: { added: ['info@example.com'], updated: [], removed: [] },
    }]);
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
    expect(pluginRegistry.runHook).toHaveBeenCalledWith('onAccountIdentityChanged', { accountId: SALES });
    // Every open tab re-reads the mailbox list, so a reply picks the new alias without a reload.
    expect(engine.broadcast).toHaveBeenCalledTimes(1);
    expect(engine.broadcast).toHaveBeenCalledWith({ type: 'aliases_changed', accountId: SALES });
  });

  it('a failing broadcast does not fail the sync', async () => {
    engine.broadcast.mockImplementation(() => { throw new Error('socket gone'); });
    fetchMock.mockResolvedValue(okResponse([PRIMARY, sendAsEntry('info@example.com')]));

    const result = await syncGmailSendAs(SALES);

    expect(result).toMatchObject({ status: 'synced', added: ['info@example.com'] });
    expect(await aliases()).toEqual([expect.objectContaining({ email: 'info@example.com', source: 'gmail' })]);
    expect(engine.broadcast).toHaveBeenCalledTimes(1);
  });

  it('second run with the same send-as changes nothing and writes no audit', async () => {
    const signature = '<div>Best,<br>Jane</div>';
    fetchMock.mockResolvedValue(okResponse([PRIMARY, sendAsEntry('info@example.com', { signature })]));

    await syncGmailSendAs(SALES);
    const before = await aliases();
    expect(before).toHaveLength(1);
    expect(before[0].signature).toBe(sanitizeSignature(signature));
    const firstSyncedAt = await syncedAt();
    pluginRegistry.runHook.mockClear();
    engine.broadcast.mockClear();

    const result = await syncGmailSendAs(SALES);

    expect(result).toMatchObject({ status: 'synced', added: [], updated: [], removed: [] });
    expect(await aliases()).toEqual(before);
    expect(await auditRows()).toHaveLength(1);
    const secondSyncedAt = await syncedAt();
    expect(secondSyncedAt).toBeInstanceOf(Date);
    expect(secondSyncedAt.getTime()).toBeGreaterThanOrEqual(firstSyncedAt.getTime());
    expect(pluginRegistry.runHook).not.toHaveBeenCalled();
    expect(engine.broadcast).not.toHaveBeenCalled();
  });

  it('removes a vanished gmail alias, keeps manual aliases and the second sender name row', async () => {
    await insertAlias('old@example.com', { source: 'gmail' });
    const manual = await insertAlias('support@example.com', { name: 'Support' });
    const secondName = await insertAlias('sales@example.com', { name: 'Sales Desk' });
    fetchMock.mockResolvedValue(okResponse([PRIMARY]));

    const result = await syncGmailSendAs(SALES);

    expect(result).toMatchObject({ status: 'synced', added: [], updated: [], removed: ['old@example.com'] });
    const rows = await aliases();
    expect(rows.map((r) => r.email)).toEqual(['sales@example.com', 'support@example.com']);
    expect(rows.find((r) => r.id === manual.id)).toMatchObject({ name: 'Support', source: 'manual' });
    expect(rows.find((r) => r.id === secondName.id)).toMatchObject({ name: 'Sales Desk', source: 'manual' });
    const [audit] = await auditRows();
    expect(audit.actor_user_id).toBeNull();
    expect(audit.actor_email).toBe('MailExpert');
    expect(audit.details).toEqual({ added: [], updated: [], removed: ['old@example.com'] });
  });

  it('keeps alias ids on update', async () => {
    const gmail = await insertAlias('info@example.com', { source: 'gmail', name: 'Old name' });
    const manual = await insertAlias('help@example.com', { name: 'Help' });
    fetchMock.mockResolvedValue(okResponse([
      PRIMARY, sendAsEntry('Info@Example.com'), sendAsEntry('help@example.com'),
    ]));

    const result = await syncGmailSendAs(SALES);

    expect(result.added).toEqual([]);
    expect(result.updated.sort()).toEqual(['Info@Example.com', 'help@example.com']);
    expect(result.removed).toEqual([]);
    const rows = await aliases();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === gmail.id)).toMatchObject({ email: 'Info@Example.com', name: 'Name Info@Example.com', source: 'gmail' });
    expect(rows.find((r) => r.id === manual.id)).toMatchObject({ email: 'help@example.com', name: 'Name help@example.com', source: 'gmail' });
  });

  it('skips reconnect_required account without calling fetch', async () => {
    await db.query('UPDATE email_accounts SET oauth_reconnect_required = true WHERE id = $1', [SALES]);
    expect(await syncGmailSendAs(SALES)).toEqual({ status: 'skipped', reason: 'reconnect_required' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ensureFreshOAuthAccount).not.toHaveBeenCalled();

    // The refresh finds the grant revoked: skipped as well, nothing fetched.
    await db.query('UPDATE email_accounts SET oauth_reconnect_required = false WHERE id = $1', [SALES]);
    ensureFreshOAuthAccount.mockRejectedValueOnce(new OAuthTokenError('oauth_reconnect_required'));
    expect(await syncGmailSendAs(SALES)).toEqual({ status: 'skipped', reason: 'reconnect_required' });
    expect(fetchMock).not.toHaveBeenCalled();

    // Another refresh failure propagates unchanged.
    const refreshFailed = new OAuthTokenError('oauth_refresh_failed');
    ensureFreshOAuthAccount.mockRejectedValueOnce(refreshFailed);
    await expect(syncGmailSendAs(SALES)).rejects.toBe(refreshFailed);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await syncedAt()).toBeNull();
  });

  it('skips a missing or non-google account without calling fetch', async () => {
    expect(await syncGmailSendAs('71000000-0000-4000-8000-0000000000ff')).toEqual({ status: 'skipped', reason: 'not_found' });
    await db.query("UPDATE email_accounts SET oauth_provider = 'microsoft' WHERE id = $1", [SALES]);
    expect(await syncGmailSendAs(SALES)).toEqual({ status: 'skipped', reason: 'not_google' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ensureFreshOAuthAccount).not.toHaveBeenCalled();
  });

  it('retries once with force refresh on 401', async () => {
    ensureFreshOAuthAccount.mockImplementation(async (account, options) => (
      options?.force ? { ...account, oauth_access_token: FRESH_TOKEN } : account
    ));
    fetchMock
      .mockResolvedValueOnce(errorResponse(401))
      .mockResolvedValueOnce(okResponse([PRIMARY, sendAsEntry('info@example.com')]));

    const result = await syncGmailSendAs(SALES);

    expect(result).toMatchObject({ status: 'synced', added: ['info@example.com'] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${FRESH_TOKEN}`);
    expect(ensureFreshOAuthAccount).toHaveBeenCalledTimes(2);
    expect(ensureFreshOAuthAccount.mock.calls[1][1]).toEqual({ force: true });

    // A second 401 after the refresh propagates, with no token in the message, and changes nothing.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(errorResponse(401));
    const before = await aliases();
    const err = await syncGmailSendAs(SALES).catch((e) => e);
    expect(err).toBeInstanceOf(GmailSendAsError);
    expect(err.code).toBe('unauthorized');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(FRESH_TOKEN);
    expect(await aliases()).toEqual(before);
  });

  it('upstream error leaves aliases untouched', async () => {
    await insertAlias('old@example.com', { source: 'gmail' });
    await insertAlias('support@example.com');
    const before = await aliases();
    fetchMock.mockResolvedValue(errorResponse(500));

    const err = await syncGmailSendAs(SALES).catch((e) => e);

    expect(err).toBeInstanceOf(GmailSendAsError);
    expect(err.code).toBe('upstream');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await aliases()).toEqual(before);
    expect(await syncedAt()).toBeNull();
    expect(await auditRows()).toEqual([]);
    expect(pluginRegistry.runHook).not.toHaveBeenCalled();
    expect(engine.broadcast).not.toHaveBeenCalled();
  });

  it('two concurrent syncs of one account produce no duplicate aliases', async () => {
    // PGlite is a single connection and runs transactions one after another, so this does not
    // exercise FOR UPDATE itself: it proves the second sync re-reads the alias rows inside its own
    // transaction and plans from them instead of from what it saw before the fetch. The unique
    // gmail index (account_id, lower(email)) is the hard backstop on a real server.
    fetchMock.mockImplementation(async () => okResponse([PRIMARY, sendAsEntry('info@example.com'), sendAsEntry('team@example.com')]));

    const [a, b] = await Promise.all([syncGmailSendAs(SALES), syncGmailSendAs(SALES)]);

    expect([a.status, b.status]).toEqual(['synced', 'synced']);
    expect([...a.added, ...b.added].sort()).toEqual(['info@example.com', 'team@example.com']);
    expect((await aliases()).map((r) => r.email)).toEqual(['info@example.com', 'team@example.com']);
    expect(await auditRows()).toHaveLength(1);
  });
});
