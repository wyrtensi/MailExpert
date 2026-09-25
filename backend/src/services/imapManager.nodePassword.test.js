import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A mail node mailbox whose password the node rejects: MailExpert sets a new one through the
// mailcow API (mailNode/passwordRestore.js, driven by ImapManager._noteNodePasswordRejected).
// Same module isolation as imapManager.test.js, plus the mailcow client and the audit log mocked,
// and an encryption mock with encrypt, so a stored password is visibly the encrypted form.
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((parsed) => parsed) }));
vi.mock('./oauth/tokenManager.js', async (importOriginal) => ({
  OAuthTokenError: (await importOriginal()).OAuthTokenError,
  ensureFreshOAuthAccount: vi.fn(async account => account),
}));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({
  encrypt: vi.fn(v => `enc:${v}`),
  decrypt: vi.fn(v => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v)),
}));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToActiveUsers: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'redacted') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./mailNode/mailcow.js', () => ({
  getMailNodeConfig: vi.fn(),
  getMailbox: vi.fn(),
  listDomains: vi.fn(),
  setMailboxPassword: vi.fn(),
}));
vi.mock('./auditLog.js', () => ({ recordAudit: vi.fn() }));

import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { getMailbox, getMailNodeConfig, listDomains, setMailboxPassword } from './mailNode/mailcow.js';
import { recordAudit } from './auditLog.js';
import { ImapManager, MAIL_NODE_ACTOR, NODE_RESTORE_CONCURRENCY, acquirePooledClient, evictPool, releasePooledClient } from './imapManager.js';

const CFG = { mailHost: 'mail.example.com', apiKey: 'api-key', quotaMb: 5120 };
const NEW_PASSWORD = 'restored-secret-1';

let n = 0;
const nodeAccount = (extra = {}) => {
  const id = `node-pw-${++n}`;
  return {
    id, user_id: 'u1', enabled: true, protocol: 'imap', mail_node: true, oauth_provider: null,
    email_address: `box${n}@example.com`, imap_host: 'mail.example.com', imap_port: 993, imap_tls: true,
    auth_user: `box${n}@example.com`, auth_pass: 'enc:old-password',
    ...extra,
  };
};

const dovecotAuthFailure = () => Object.assign(new Error('Command failed'), {
  response: '1 NO [AUTHENTICATIONFAILED] Authentication failed.',
  responseStatus: 'NO',
  responseText: 'Authentication failed.',
  serverResponseCode: 'AUTHENTICATIONFAILED',
  authenticationFailed: true,
});
const DOVECOT_TEXT = '[AUTHENTICATIONFAILED] Authentication failed.';

// What getMailbox reports for an active mailbox nothing else keeps from signing in.
const activeMailbox = (email, extra = {}) => ({
  email, active: true, quotaMb: 5120, usedBytes: 0,
  state: 1, authsource: 'mailcow', imapAccess: true, forcePwUpdate: false, domain: 'example.com', ...extra,
});

const nodeError = (code) => Object.assign(new Error('node'), { name: 'MailNodeError', code });

// Let the restore (scheduled with setImmediate, then a chain of awaits) run to its end.
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
};

let nodePassword; // the password the node accepts
let logins; // { pass, result } per login attempt
let hold; // { count, promise }: that many rejected logins are answered only when promise resolves
let rows; // accountId -> the stored row
let consoleLines;

function newManager() {
  const mgr = new ImapManager(null);
  for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer', '_providerIdSchedulerTimer']) clearInterval(mgr[key]);
  mgr.broadcast = vi.fn();
  return mgr;
}

const syncErrorWrites = (id) => query.mock.calls
  .filter(([sql, params]) => sql.startsWith('UPDATE email_accounts SET sync_error = $1') && params[1] === id)
  .map(([, params]) => params[0]);
const passwordWrites = () => query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE email_accounts SET auth_pass'));

beforeEach(() => {
  vi.clearAllMocks();
  nodePassword = 'changed-on-the-node';
  logins = [];
  hold = null;
  rows = new Map();
  consoleLines = [];
  ImapFlow.mockImplementation(function (cfg) {
    const client = Object.assign(new EventEmitter(), {
      usable: true,
      connect: vi.fn(() => {
        const pass = cfg.auth?.pass;
        const ok = pass === nodePassword;
        logins.push({ pass, ok });
        if (!ok && hold?.count > 0) {
          hold.count--;
          return hold.promise.then(() => { throw dovecotAuthFailure(); });
        }
        return ok ? Promise.resolve() : Promise.reject(dovecotAuthFailure());
      }),
      logout: vi.fn().mockResolvedValue(),
    });
    client.close = vi.fn(() => { client.usable = false; client.emit('close'); });
    return client;
  });
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true, allowInsecureTls: true });
  resolveForConnection.mockResolvedValue({ host: '127.0.0.1', addresses: ['127.0.0.1'], servername: null });
  getMailNodeConfig.mockResolvedValue(CFG);
  getMailbox.mockImplementation(async (cfg, email) => activeMailbox(email));
  listDomains.mockResolvedValue([{ domain: 'example.com', active: true, maxMailboxes: 500, mailboxes: 10 }]);
  setMailboxPassword.mockImplementation(async () => { nodePassword = NEW_PASSWORD; return NEW_PASSWORD; });
  query.mockReset();
  query.mockImplementation(async (sql, params = []) => {
    if (sql.startsWith('SELECT id, email_address, imap_host, mail_node') || sql.startsWith('SELECT * FROM email_accounts WHERE id = $1')) {
      const found = rows.get(params[0]);
      const row = found && (!sql.includes('enabled = true') || found.enabled) ? found : null;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE email_accounts SET auth_pass')) {
      const row = rows.get(params[1]);
      if (!row?.mail_node) return { rows: [], rowCount: 0 };
      const updated = { ...row, auth_pass: params[0] };
      rows.set(row.id, updated);
      return { rows: [updated], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  for (const level of ['log', 'warn', 'error']) {
    vi.spyOn(console, level).mockImplementation((...args) => { consoleLines.push(args.map(String).join(' ')); });
  }
});
afterEach(() => { vi.restoreAllMocks(); });

const stored = (acct) => { rows.set(acct.id, acct); return acct; };

// The pool's rejected login arms the ladder: account-wide without a persistent session, the
// secondary one while the persistent session is up.
async function rejectPoolLogin(acct) {
  await expect(acquirePooledClient(acct)).rejects.toMatchObject({ serverResponseCode: 'AUTHENTICATIONFAILED' });
}

describe('a mail node mailbox whose password is rejected', () => {
  it('gets a new password through the node API, stored encrypted, and reconnects', async () => {
    const acct = stored(nodeAccount());
    const mgr = newManager();
    mgr.connections.set(acct.id, Object.assign(new EventEmitter(), { close: vi.fn() })); // the IDLE session survives
    const reconnect = vi.spyOn(mgr, 'connectAccount').mockResolvedValue(true);

    await rejectPoolLogin(acct);
    expect(mgr._authLoginBlocked(acct.id)).toBeTruthy(); // the secondary ladder is armed
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));

    expect(getMailbox).toHaveBeenCalledWith(CFG, acct.email_address);
    expect(setMailboxPassword).toHaveBeenCalledTimes(1);
    expect(setMailboxPassword).toHaveBeenCalledWith(CFG, acct.email_address);
    // Stored encrypted, as the create route stores a provisioned password.
    expect(passwordWrites()).toHaveLength(1);
    expect(passwordWrites()[0][1]).toEqual([`enc:${NEW_PASSWORD}`, acct.id]);
    expect(passwordWrites()[0][0]).toMatch(/WHERE id = \$2 AND mail_node = true/);
    // All three ladders are gone and nothing holds a login back.
    expect(mgr._connectCooldown.has(acct.id)).toBe(false);
    expect(mgr._secondaryAuthCooldown.has(acct.id)).toBe(false);
    expect(mgr._secondaryCooldown.has(acct.id)).toBe(false);
    expect(mgr._authLoginBlocked(acct.id)).toBeFalsy();
    // Reconnected with the row that holds the new password.
    expect(reconnect.mock.calls[0][0]).toMatchObject({ id: acct.id, auth_pass: `enc:${NEW_PASSWORD}` });
    // One audit entry, by MailExpert, without any secret.
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith({ actorEmail: MAIL_NODE_ACTOR, accountId: acct.id, action: 'mailbox.password_restored', details: {} });
    // One log line says so, and no line carries the password.
    expect(consoleLines.filter(l => /set a new one through the mail node API/.test(l))).toHaveLength(1);
    expect(consoleLines.some(l => l.includes(NEW_PASSWORD))).toBe(false);
    evictPool(acct.id);
  });

  it('restores it when the account-wide ladder is the one armed, and the reconnect proves it', async () => {
    const acct = stored(nodeAccount());
    const mgr = newManager();

    expect(await mgr.connectAccount(acct)).toBe(false); // the persistent login is rejected
    expect(mgr._connectCooldown.get(acct.id)?.authArmed).toBe(true);
    // The restore reconnects for real; the login with the new password is accepted.
    await vi.waitFor(() => expect(mgr.connections.has(acct.id)).toBe(true));

    expect(setMailboxPassword).toHaveBeenCalledTimes(1);
    expect(logins[0]).toEqual({ pass: 'old-password', ok: false });
    expect(logins[1]).toEqual({ pass: NEW_PASSWORD, ok: true });
    expect(logins.slice(1).every(l => l.pass === NEW_PASSWORD)).toBe(true);
    expect(mgr._connectCooldown.get(acct.id)?.authArmed).toBeFalsy();
    // The accepted login proves the restored password: a later rejection may restore it again.
    expect(mgr._nodePasswordRestored.has(acct.id)).toBe(false);
    await mgr.disconnectAccount(acct.id);
  });

  it('keeps a mailbox disabled on the node disabled: no password change, the ladder and the error stay', async () => {
    const acct = stored(nodeAccount());
    getMailbox.mockResolvedValue({ email: acct.email_address, active: false, quotaMb: 5120, usedBytes: 0 });
    const mgr = newManager();
    const reconnect = vi.spyOn(mgr, 'connectAccount');

    await rejectPoolLogin(acct);
    await vi.waitFor(() => expect(syncErrorWrites(acct.id)).toContain('Password rejected: the mailbox is disabled on the mail node'));

    expect(setMailboxPassword).not.toHaveBeenCalled();
    expect(passwordWrites()).toHaveLength(0);
    expect(mgr._authLoginBlocked(acct.id)).toBeTruthy();
    expect(reconnect).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    // The error the rejection recorded came first; the reason why it stays is what remains.
    expect(syncErrorWrites(acct.id)).toEqual([DOVECOT_TEXT, 'Password rejected: the mailbox is disabled on the mail node']);
    evictPool(acct.id);
  });

  it('does not restore when the node refuses the login for a reason other than the password', async () => {
    const cases = [
      { mailbox: { active: false, state: 2 }, detail: 'Password rejected: login is disabled for the mailbox on the mail node (receive only)' },
      { mailbox: { authsource: 'keycloak' }, detail: 'Password rejected: the mailbox signs in through an external identity provider on the mail node' },
      { mailbox: { imapAccess: false }, detail: 'Password rejected: IMAP access is turned off for the mailbox on the mail node' },
      { mailbox: { forcePwUpdate: true }, detail: 'Password rejected: the mail node asks for a password change at the next login' },
      { domains: [{ domain: 'example.com', active: false }], detail: 'Password rejected: the mailbox domain is disabled on the mail node' },
      { domains: [{ domain: 'other.example', active: true }], detail: 'Password rejected: the mailbox domain is missing on the mail node' },
      { domainsError: nodeError('mail_node_unreachable'), detail: 'Password rejected: the mail node API is unreachable' },
    ];
    for (const { mailbox, domains, domainsError, detail } of cases) {
      const acct = stored(nodeAccount());
      if (mailbox) getMailbox.mockResolvedValueOnce(activeMailbox(acct.email_address, mailbox));
      if (domains) listDomains.mockResolvedValueOnce(domains);
      if (domainsError) listDomains.mockRejectedValueOnce(domainsError);
      const mgr = newManager();
      const reconnect = vi.spyOn(mgr, 'connectAccount');

      await rejectPoolLogin(acct);
      await vi.waitFor(() => expect(syncErrorWrites(acct.id)).toContain(detail));

      expect(setMailboxPassword).not.toHaveBeenCalled();
      expect(passwordWrites()).toHaveLength(0);
      expect(mgr._authLoginBlocked(acct.id)).toBeTruthy();
      expect(reconnect).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
      evictPool(acct.id);
    }
  });

  it('stores the password but does not connect a mailbox disabled or deleted in MailExpert while the restore ran', async () => {
    for (const change of ['disable', 'delete']) {
      const acct = stored(nodeAccount());
      const mgr = newManager();
      setMailboxPassword.mockImplementationOnce(async () => {
        // The user acts while the node API call is in flight.
        if (change === 'disable') rows.set(acct.id, { ...rows.get(acct.id), enabled: false });
        nodePassword = NEW_PASSWORD;
        return NEW_PASSWORD;
      });
      if (change === 'delete') {
        // Deleted after the password was stored, while the restore waits to reconnect.
        mgr.connectingAccounts.add(acct.id);
        setTimeout(() => { rows.delete(acct.id); mgr.connectingAccounts.delete(acct.id); }, 150);
      }
      const reconnect = vi.spyOn(mgr, 'connectAccount');

      mgr._noteAuthFailure(acct);
      await vi.waitFor(() => expect(recordAudit).toHaveBeenCalledTimes(1));
      await new Promise(resolve => setTimeout(resolve, 400));
      await settle();

      expect(passwordWrites()).toHaveLength(1); // the node has the new password: it is stored
      expect(reconnect).not.toHaveBeenCalled();
      expect(mgr.connections.has(acct.id)).toBe(false);
      recordAudit.mockClear();
      query.mockClear();
    }
  });

  it('does not touch the configured node for a mailbox whose row names another host', async () => {
    const acct = stored(nodeAccount({ imap_host: 'Old-Node.example.org' }));
    const mgr = newManager();
    const reconnect = vi.spyOn(mgr, 'connectAccount');
    mgr.connections.set(acct.id, Object.assign(new EventEmitter(), { close: vi.fn() }));

    await rejectPoolLogin(acct);
    await vi.waitFor(() => expect(syncErrorWrites(acct.id)).toContain('Password rejected: the mailbox is not on the configured mail node'));

    expect(getMailbox).not.toHaveBeenCalled();
    expect(setMailboxPassword).not.toHaveBeenCalled();
    expect(passwordWrites()).toHaveLength(0);
    expect(reconnect).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    evictPool(acct.id);

    // The same host in other letter case is the same node.
    const same = stored(nodeAccount({ imap_host: 'MAIL.example.com' }));
    vi.spyOn(mgr, 'connectAccount').mockResolvedValue(true);
    mgr._noteAuthFailure(same);
    await vi.waitFor(() => expect(setMailboxPassword).toHaveBeenCalledTimes(1));
  });

  it('does not restore a mailbox missing on the node', async () => {
    const acct = stored(nodeAccount());
    getMailbox.mockResolvedValue(null);
    const mgr = newManager();
    const reconnect = vi.spyOn(mgr, 'connectAccount');

    await rejectPoolLogin(acct);
    await vi.waitFor(() => expect(syncErrorWrites(acct.id)).toContain('Password rejected: the mailbox is missing on the mail node'));

    expect(setMailboxPassword).not.toHaveBeenCalled();
    expect(passwordWrites()).toHaveLength(0);
    expect(mgr._authLoginBlocked(acct.id)).toBeTruthy();
    expect(reconnect).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    evictPool(acct.id);
  });

  it('does not restore when the node API fails, reading the mailbox or setting the password', async () => {
    const cases = [
      { setup: () => getMailbox.mockRejectedValueOnce(nodeError('mail_node_unreachable')), detail: 'Password rejected: the mail node API is unreachable' },
      { setup: () => getMailbox.mockRejectedValueOnce(nodeError('mail_node_auth')), detail: 'Password rejected: the mail node refused the API key' },
      { setup: () => setMailboxPassword.mockRejectedValueOnce(nodeError('mail_node_refused')), detail: 'Password rejected: the mail node API failed' },
    ];
    for (const { setup, detail } of cases) {
      const acct = stored(nodeAccount());
      setup();
      const mgr = newManager();
      const reconnect = vi.spyOn(mgr, 'connectAccount');

      await rejectPoolLogin(acct);
      await vi.waitFor(() => expect(syncErrorWrites(acct.id)).toContain(detail));

      expect(passwordWrites()).toHaveLength(0);
      expect(mgr._authLoginBlocked(acct.id)).toBeTruthy();
      expect(reconnect).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
      evictPool(acct.id);
    }
  });

  it('never runs for an OAuth or an ordinary IMAP mailbox', async () => {
    const oauth = stored(nodeAccount({ oauth_provider: 'google', oauth_access_token: 'enc:token', mail_node: true }));
    const plain = stored(nodeAccount({ mail_node: false, imap_host: 'imap.example.net' }));
    const mgr = newManager();

    // The account-wide ladder, armed by each one's own rejected login.
    expect(await mgr.connectAccount(oauth)).toBe(false);
    expect(await mgr.connectAccount(plain)).toBe(false);
    expect(mgr._connectCooldown.get(plain.id)?.authArmed).toBe(true);
    // The secondary ladder, armed while a persistent session is up.
    mgr.connections.set(plain.id, Object.assign(new EventEmitter(), { close: vi.fn() }));
    mgr._armSecondaryAuthCooldown(plain, 'Folder status');
    mgr._noteAuthFailure({ ...oauth, id: 'oauth-direct' });
    await settle();

    expect(getMailNodeConfig).not.toHaveBeenCalled();
    expect(getMailbox).not.toHaveBeenCalled();
    expect(setMailboxPassword).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.startsWith('SELECT id, email_address, imap_host, mail_node'))).toBe(false);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('a sync-tick reconnect the node accepts proves the restored password too', async () => {
    const acct = stored(nodeAccount({ auth_pass: `enc:${NEW_PASSWORD}` }));
    nodePassword = NEW_PASSWORD;
    const mgr = newManager();
    mgr.syncFolders = vi.fn().mockResolvedValue();
    mgr.syncMessages = vi.fn().mockResolvedValue({});
    mgr._syncSpamFolder = vi.fn().mockResolvedValue();
    mgr._nodePasswordRestored.add(acct.id);

    await mgr._syncTick(acct); // no persistent session: the tick reconnects
    expect(logins).toEqual([{ pass: NEW_PASSWORD, ok: true }]);
    expect(mgr._nodePasswordRestored.has(acct.id)).toBe(false);
    await mgr.disconnectAccount(acct.id);
  });

  it('a poll-only login the node accepts proves the restored password too', async () => {
    const acct = stored(nodeAccount({ auth_pass: `enc:${NEW_PASSWORD}` }));
    nodePassword = NEW_PASSWORD;
    const mgr = newManager();
    mgr.syncFolders = vi.fn().mockResolvedValue();
    mgr.syncMessages = vi.fn().mockResolvedValue({});
    mgr._nodePasswordRestored.add(acct.id);

    await mgr._pollOnlyTick(acct);
    expect(logins).toEqual([{ pass: NEW_PASSWORD, ok: true }]);
    expect(mgr._nodePasswordRestored.has(acct.id)).toBe(false);
  });

  it('goes by the stored row: a mailbox disabled in MailExpert or no longer on the node is left alone', async () => {
    const mgr = newManager();
    for (const change of [{ enabled: false }, { mail_node: false }]) {
      const acct = nodeAccount();
      rows.set(acct.id, { ...acct, ...change }); // the copy in memory is older than the row
      mgr._noteAuthFailure(acct);
      await settle();
    }
    getMailNodeConfig.mockResolvedValueOnce(null); // no mail node configured
    mgr._noteAuthFailure(stored(nodeAccount()));
    await settle();

    expect(getMailNodeConfig).toHaveBeenCalledTimes(1);
    expect(getMailbox).not.toHaveBeenCalled();
    expect(setMailboxPassword).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('tries once per ladder window', async () => {
    const acct = stored(nodeAccount());
    getMailbox.mockResolvedValue({ email: acct.email_address, active: false, quotaMb: 5120, usedBytes: 0 });
    const mgr = newManager();

    mgr._noteAuthFailure(acct);
    await settle();
    expect(getMailbox).toHaveBeenCalledTimes(1);

    // More rejections inside the same window: the pool, the status client, the account's own login.
    await mgr._noteSecondaryAuthFailure(acct, dovecotAuthFailure(), 'Folder status');
    mgr._noteAuthFailure(acct);
    await settle();
    expect(getMailbox).toHaveBeenCalledTimes(1);

    // The window runs out and the next rejection opens the next one: one more attempt.
    mgr._connectCooldown.get(acct.id).until = 0;
    mgr._noteAuthFailure(acct);
    await settle();
    expect(getMailbox).toHaveBeenCalledTimes(2);
  });

  it('never runs two attempts for one mailbox at once', async () => {
    const acct = stored(nodeAccount());
    let answer;
    getMailbox.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const mgr = newManager();
    const reconnect = vi.spyOn(mgr, 'connectAccount').mockResolvedValue(true);

    mgr._noteAuthFailure(acct);
    await settle();
    expect(getMailbox).toHaveBeenCalledTimes(1);
    // A new window while the first attempt still waits on the node (both ladders).
    mgr._connectCooldown.get(acct.id).until = 0;
    mgr._noteAuthFailure(acct);
    mgr.connections.set(acct.id, Object.assign(new EventEmitter(), { close: vi.fn() }));
    mgr._armSecondaryAuthCooldown(acct, 'Folder status');
    await settle();
    expect(getMailbox).toHaveBeenCalledTimes(1);

    answer(activeMailbox(acct.email_address));
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledTimes(1));
    expect(setMailboxPassword).toHaveBeenCalledTimes(1);
  });

  it('runs at most two restores at once across all mailboxes; the others wait their turn', async () => {
    const accounts = [stored(nodeAccount()), stored(nodeAccount()), stored(nodeAccount())];
    const answers = [];
    getMailbox.mockImplementation((cfg, email) => new Promise(resolve => { answers.push(() => resolve(activeMailbox(email, { active: false, state: 0 }))); }));
    const mgr = newManager();

    for (const acct of accounts) mgr._noteAuthFailure(acct);
    await settle();
    expect(getMailbox).toHaveBeenCalledTimes(NODE_RESTORE_CONCURRENCY);
    expect(NODE_RESTORE_CONCURRENCY).toBe(2);

    answers[0]();
    await vi.waitFor(() => expect(getMailbox).toHaveBeenCalledTimes(3));
    answers[1]();
    answers[2]();
    for (const acct of accounts) {
      await vi.waitFor(() => expect(syncErrorWrites(acct.id)).toContain('Password rejected: the mailbox is disabled on the mail node'));
    }
  });

  it('does not restore again when the restored password is rejected too, until a login succeeds or a reconnect', async () => {
    const acct = stored(nodeAccount());
    // The node takes the new password but still rejects it (say, a server-side problem).
    setMailboxPassword.mockResolvedValue(NEW_PASSWORD);
    const mgr = newManager();

    expect(await mgr.connectAccount(acct)).toBe(false);
    // The restore reconnects; that login is rejected and arms a fresh window.
    await vi.waitFor(() => expect(logins).toHaveLength(2));
    await settle();
    expect(logins.map(l => l.pass)).toEqual(['old-password', NEW_PASSWORD]);
    expect(mgr._connectCooldown.get(acct.id)?.authArmed).toBe(true);
    expect(setMailboxPassword).toHaveBeenCalledTimes(1);

    // Later windows do not restore again either: no loop of new passwords and rejected logins.
    mgr._connectCooldown.get(acct.id).until = 0;
    expect(await mgr.connectAccount(acct)).toBe(false);
    await settle();
    expect(setMailboxPassword).toHaveBeenCalledTimes(1);
    expect(logins).toHaveLength(3);

    // A manual reconnect (clearConnectCooldown) lets the next rejection restore again.
    mgr.clearConnectCooldown(acct.id);
    expect(await mgr.connectAccount(acct)).toBe(false);
    await vi.waitFor(() => expect(setMailboxPassword).toHaveBeenCalledTimes(2));
    await settle();
  });
});

describe('logins around a restored node password', () => {
  it('a copy of the row read before the restore logs in with the new password', async () => {
    const acct = stored(nodeAccount());
    const mgr = newManager();
    vi.spyOn(mgr, 'connectAccount').mockResolvedValue(true);

    await rejectPoolLogin(acct);
    await vi.waitFor(() => expect(recordAudit).toHaveBeenCalledTimes(1));

    // A job still holding the old row (auth_pass: the old password) opens a pooled session.
    const client = await acquirePooledClient(acct);
    expect(logins.at(-1)).toEqual({ pass: NEW_PASSWORD, ok: true });
    releasePooledClient(acct, client);
    evictPool(acct.id);
  });

  it('a login still running with the old password when the restore lands arms no ladder', async () => {
    const acct = stored(nodeAccount());
    const mgr = newManager();
    vi.spyOn(mgr, 'connectAccount').mockResolvedValue(true);
    let release;
    hold = { count: 1, promise: new Promise(resolve => { release = resolve; }) };

    // Two pooled logins start together with the old password: the first to reach the server is
    // answered late, the other is rejected at once and arms the ladder, which starts the restore.
    const outcomes = [acquirePooledClient(acct), acquirePooledClient(acct)].map(p => p.then(() => 'ok', err => err));
    await vi.waitFor(() => expect(recordAudit).toHaveBeenCalledTimes(1));
    expect(mgr._authLoginBlocked(acct.id)).toBeFalsy();

    // The slow one is rejected only now, after the restore cleared the ladders.
    release();
    const errors = await Promise.all(outcomes);
    expect(errors.map(e => !!e.staleCredential).sort()).toEqual([false, true]);
    await settle();
    expect(mgr._authLoginBlocked(acct.id)).toBeFalsy();
    expect(mgr._connectCooldown.has(acct.id)).toBe(false);
    expect(mgr._secondaryAuthCooldown.has(acct.id)).toBe(false);
    expect(setMailboxPassword).toHaveBeenCalledTimes(1);
    evictPool(acct.id);
  });

  it('a connect still running with the old password is waited out, then the restore reconnects', async () => {
    const acct = stored(nodeAccount());
    const mgr = newManager();
    let release;
    hold = { count: 1, promise: new Promise(resolve => { release = resolve; }) };

    // The persistent connect is on its way with the old password when a pooled login is rejected.
    const connecting = mgr.connectAccount(acct);
    await vi.waitFor(() => expect(logins).toHaveLength(1));
    await rejectPoolLogin(acct);
    await vi.waitFor(() => expect(recordAudit).toHaveBeenCalledTimes(1));
    await settle();
    expect(mgr.connections.has(acct.id)).toBe(false); // the restore waits for that connect

    // It is rejected only now: no ladder from it, and the restore's reconnect goes through.
    release();
    expect(await connecting).toBe(false);
    await vi.waitFor(() => expect(mgr.connections.has(acct.id)).toBe(true), { timeout: 3000 });
    expect(mgr._connectCooldown.get(acct.id)?.authArmed).toBeFalsy();
    expect(logins.filter(l => l.pass === NEW_PASSWORD && l.ok).length).toBeGreaterThanOrEqual(1);
    await mgr.disconnectAccount(acct.id);
  });

  it('the restore evicts the pool, so no session opened with the old password is handed out again', async () => {
    const acct = stored(nodeAccount());
    nodePassword = 'old-password'; // the old password still works at first
    const mgr = newManager();
    vi.spyOn(mgr, 'connectAccount').mockResolvedValue(true);

    const old = await acquirePooledClient(acct);
    releasePooledClient(acct, old); // idle in the pool
    nodePassword = 'changed-on-the-node';
    mgr._noteAuthFailure(acct);
    await vi.waitFor(() => expect(recordAudit).toHaveBeenCalledTimes(1));

    expect(old.close).toHaveBeenCalled();
    const next = await acquirePooledClient(acct);
    expect(next).not.toBe(old);
    expect(logins.at(-1)).toEqual({ pass: NEW_PASSWORD, ok: true });
    releasePooledClient(acct, next);
    evictPool(acct.id);
  });
});
