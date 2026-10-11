import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../services/db.js', () => {const query=vi.fn();return {query,pool:{connect:async()=>({query,release(){}})}};});
vi.mock('../services/accounts/connectionProbe.js',()=>({probeConnection:async c=>({imapLogin:c.auth_user,smtpLogin:c.smtp_auth_user})}));
vi.mock('../services/redis.js',()=>({redisClient:{incr:async()=>1,pExpire:async()=>{}}}));
vi.mock('../middleware/auth.js', () => ({
  isAdminRequest: vi.fn(async () => true),
  requireAuth: (req, _res, next) => { req.session = { userId: req.get('x-user-id') || 'user-2' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
vi.mock('../index.js', () => ({
  imapManager: {
    clearConnectCooldown: vi.fn(),
    isConnecting: vi.fn(() => false),
    connectAccount: vi.fn(() => Promise.resolve(true)),
    disconnectAccount: vi.fn(() => Promise.resolve()),
    providerIdBackfillStates: vi.fn(async () => new Map()),
    threadRecomputeStates: vi.fn(async () => new Map()),
  },
}));
vi.mock('../services/encryption.js', () => ({ encrypt: vi.fn((v) => (v ? `enc:${v}` : v)), decrypt: vi.fn() }));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn(async () => null) }));
vi.mock('../services/connectionPolicy.js', () => ({
  getConnectionPolicy: vi.fn().mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false, allowNonstandardPorts: true }),
}));

import express from 'express';
import accountRoutes from './accounts.js';
import { query } from '../services/db.js';
import { imapManager } from '../index.js';
import { isAdminRequest } from '../middleware/auth.js';
import { createRealSchemaDb } from '../services/testing/realSchema.js';

const ID = '66666666-6666-4666-8666-666666666666';

// Mailboxes belong to the install: whoever is signed in lists, changes and deletes all of them,
// and a new mailbox only remembers who added it.
describe('mailboxes are shared by every user', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/accounts', accountRoutes);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    // Schema setup can occupy this test worker longer than Node's default idle socket timeout.
    server.keepAliveTimeout = 60000;
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  beforeEach(() => {
    vi.clearAllMocks();
    isAdminRequest.mockResolvedValue(true);
    query.mockReset().mockImplementation(async () => ({ rows: [{ id: ID, protocol: 'pop3' }] }));
  });

  const ownerFilters = () => query.mock.calls.filter(([sql]) => /user_id/.test(sql));

  it('lists every mailbox', async () => {
    const res = await fetch(`${base}/api/accounts`);
    expect(res.status).toBe(200);
    expect(query.mock.calls[0][0]).toMatch(/FROM email_accounts\s+ORDER BY sort_order, created_at/);
    expect(query.mock.calls[0][1]).toBeUndefined();
    expect(ownerFilters()).toEqual([]);
  });

  it('lists safe provider metadata without internal Proton identities or trust', async () => {
    query.mockResolvedValue({ rows: [{
      id: ID, protocol: 'imap', mail_provider: 'proton', connection_mode: 'managed', imap_tls_mode: 'implicit',
      added_by: 'user-2', proton_managed_link: true,
    }] });
    const res = await fetch(`${base}/api/accounts`);
    const [account] = await res.json();
    expect(account).toMatchObject({ mail_provider: 'proton', connection_mode: 'managed', imap_tls_mode: 'implicit', can_reconnect_proton: true });
    expect(account).not.toHaveProperty('proton_managed_link');
    expect(account).not.toHaveProperty('added_by');
    const sql = query.mock.calls[0][0];
    expect(sql).not.toMatch(/SELECT\s+\*/);
    expect(sql).not.toMatch(/certificate_pem|certificate_fingerprint|tls_servername|creator_user_id|auth_pass/);
  });

  it('allows every approved employee to reconnect real managed links and shares every mailbox', async () => {
    const db = await createRealSchemaDb();
    const creator = '10000000-0000-4000-8000-000000000001';
    const adder = '10000000-0000-4000-8000-000000000002';
    const employee = '10000000-0000-4000-8000-000000000003';
    try {
      await db.exec(`
        INSERT INTO users (id, username, password_hash) VALUES
          ('${creator}', 'creator', 'fixture'), ('${adder}', 'adder', 'fixture'), ('${employee}', 'employee', 'fixture');
        INSERT INTO email_accounts (id, name, email_address, added_by, mail_provider, connection_mode, imap_tls_mode)
          VALUES ('${ID}', 'Second address', 'second@example.com', '${adder}', 'proton', 'managed', 'implicit');
        INSERT INTO email_accounts (name, email_address, added_by, mail_provider, connection_mode)
          VALUES ('Unlinked', 'unlinked@example.com', '${adder}', 'proton', 'managed'),
                 ('Legacy', 'legacy@example.com', '${adder}', NULL, 'manual');
        INSERT INTO proton_users (user_id, creator_user_id) VALUES ('native-fixture', '${creator}');
        INSERT INTO proton_mailbox_links (account_id, user_id, generation, certificate_pem, certificate_fingerprint, tls_servername)
          SELECT '${ID}', user_id, generation, 'secret-sentinel', 'secret-sentinel', 'localhost' FROM proton_users;
      `);
      query.mockImplementation((sql, params) => db.query(sql, params));
      for (const [actor, admin] of [[creator, false], [adder, false], [employee, false], [employee, true]]) {
        isAdminRequest.mockResolvedValue(admin);
        const res = await fetch(`${base}/api/accounts`, { headers: { 'x-user-id': actor } });
        expect(res.status).toBe(200);
        const accounts = await res.json();
        expect(accounts).toHaveLength(3);
        expect(accounts.find(account => account.id === ID).can_reconnect_proton).toBe(true);
        expect(accounts.filter(account => account.id !== ID).every(account => account.can_reconnect_proton === false)).toBe(true);
        expect(accounts.find(account => account.name === 'Legacy').imap_tls_mode).toBeNull();
        expect(JSON.stringify(accounts)).not.toContain('secret-sentinel');
        expect(JSON.stringify(accounts)).not.toContain('native-fixture');
      }
    } finally {
      await db.close();
    }
  });

  it('records who added a mailbox', async () => {
    const db=await createRealSchemaDb();
    const user='10000000-0000-4000-8000-000000000002';
    try {
      await db.query("INSERT INTO users (id,username) VALUES ($1,'employee')",[user]);
      query.mockImplementation((sql,params)=>db.query(sql,params));
      const res=await fetch(`${base}/api/accounts`,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'MailExpert','x-user-id':user,'Idempotency-Key':'10000000-0000-4000-8000-000000000099'},body:JSON.stringify({name:'Team',email_address:'team@example.com',imap_host:'imap.example.com',smtp_host:'smtp.example.com',auth_pass:'secret'})});
      expect(res.status).toBe(200);
      expect((await db.query('SELECT added_by FROM email_accounts')).rows).toEqual([{added_by:user}]);
    } finally {await db.close();}
  });

  it('deletes a mailbox someone else added', async () => {
    const res = await fetch(`${base}/api/accounts/${ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
      'SELECT id, email_address, mail_node, imap_host, oauth_provider, oauth_refresh_token, oauth_access_token FROM email_accounts WHERE id = $1',
      [ID]
    );
    expect(query).toHaveBeenCalledWith('DELETE FROM email_accounts WHERE id = $1', [ID]);
    expect(imapManager.disconnectAccount).toHaveBeenCalledWith(ID);
    expect(ownerFilters()).toEqual([]);
  });

  it('checks aliases against the mailbox only', async () => {
    await fetch(`${base}/api/accounts/${ID}/aliases/${ID}`, { method: 'DELETE' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE a\.id = \$1 AND e\.id = \$2/);
    expect(params).toEqual([ID, ID]);
  });
});
