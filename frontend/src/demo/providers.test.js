import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

let demoRequest;
beforeEach(async () => {
  ({ demoRequest } = await import(`./index.js?test=${crypto.randomUUID()}`));
});

const SECRET = 'secret-sentinel';
let counter = 0;
const proton = (email, extra = {}) => demoRequest('POST', '/accounts/proton/connect', {
  email, password: SECRET, requestId: `req-providers-${String(counter += 1).padStart(8, '0')}`, ...extra,
});
const poll = (id) => demoRequest('GET', `/accounts/proton/connect/${id}`);
const connected = async (email, extra) => {
  const started = await proton(email, extra);
  await poll(started.id);
  const done = await poll(started.id);
  assert.equal(done.state, 'connected', email);
  return done.account;
};
const asViewer = async (role, run) => {
  const original = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => role, setItem: () => {} };
  try { return await run(); } finally { globalThis.localStorage = original; }
};

test('demo_all_eight_flows_and_safe_proton_errors: the four fixed providers connect without a connection', async () => {
  const status = await demoRequest('GET', '/integrations/status');
  for (const provider of status.mailProviders) {
    const account = await demoRequest('POST', '/accounts/provider', {
      provider: provider.id, email: `user@${provider.publicDomains[0]}`, appPassword: SECRET,
    });
    assert.equal(account.mail_provider, provider.id);
    assert.equal(account.connection_mode, 'preset');
    assert.equal(account.can_reconnect_proton, false);
  }
  const list = await demoRequest('GET', '/accounts');
  assert.ok(list.filter(a => a.connection_mode === 'preset').length >= 4);
  assert.equal(JSON.stringify(list).includes(SECRET), false);
});

test('Proton: every failure the form handles has a stable code and carries no secret', async () => {
  const outcomes = [
    ['bad-login@proton.me', 'invalid_credentials'],
    ['hv-login@proton.me', 'verification_required'],
    ['smtp-login@proton.me', 'smtp_unavailable'],
  ];
  for (const [email, code] of outcomes) {
    const started = await proton(email);
    let latest = await poll(started.id);
    if (latest.state !== 'failed') latest = await poll(started.id);
    assert.equal(latest.state, 'failed', email);
    assert.equal(latest.errorCode, code, email);
    assert.equal(JSON.stringify(latest).includes(SECRET), false);
  }
  const offline = await proton('offline-login@proton.me');
  assert.deepEqual([offline.state, offline.errorCode], ['failed', 'proton_unavailable']);
});

test('Proton: the same address twice is already_connected; 2FA needs a non-empty answer', async () => {
  await connected('twice@proton.me');
  assert.equal((await proton('twice@proton.me')).errorCode, 'already_connected');
  const challenge = await proton('x-2fa@proton.me');
  assert.equal((await poll(challenge.id)).state, 'needs_2fa');
  await assert.rejects(
    () => demoRequest('POST', `/accounts/proton/connect/${challenge.id}/continue`, { challenge: '2fa', secret: '' }),
    err => err.code === 'invalid_challenge',
  );
  assert.equal((await demoRequest('POST', `/accounts/proton/connect/${challenge.id}/continue`, { challenge: '2fa', secret: '123456' })).state, 'checking');
  assert.equal((await poll(challenge.id)).state, 'connected');
});

test('nothing typed into the connection requests is kept anywhere the demo answers', async () => {
  const account = await connected('keep@proton.me');
  const everything = JSON.stringify([await demoRequest('GET', '/accounts'), await demoRequest('GET', '/integrations/status'), account]);
  assert.equal(everything.includes(SECRET), false);
});

test('demo_employee_other_allowed_put_restricted: an employee adds an Other mailbox but cannot change its connection', async () => {
  await asViewer('user', async () => {
    const created = await demoRequest('POST', '/accounts', {
      email_address: 'employee-other@demo.mailexpert.local', imap_host: 'imap.example.invalid', smtp_host: 'smtp.example.invalid',
      auth_user: 'u', auth_pass: SECRET,
    });
    assert.equal(created.email_address, 'employee-other@demo.mailexpert.local');
    assert.equal(JSON.stringify(created).includes(SECRET), false);
    const renamed = await demoRequest('PUT', `/accounts/${created.id}`, { name: 'Renamed', imap_host: created.imap_host });
    assert.equal(renamed.name, 'Renamed', 'metadata and an unchanged resend go through');
    await assert.rejects(
      () => demoRequest('PUT', `/accounts/${created.id}`, { imap_host: 'imap.elsewhere.invalid' }),
      err => err.status === 403 && err.code === 'connection_admin_only',
    );
  });
});

test('an administrator changes the connection of an ordinary mailbox, never of a managed Proton one', async () => {
  const account = await connected('locked@proton.me');
  await assert.rejects(
    () => demoRequest('PUT', `/accounts/${account.id}`, { imap_host: 'imap.elsewhere.invalid' }),
    err => err.code === 'managed_connection_locked',
  );
  assert.equal((await demoRequest('PUT', `/accounts/${account.id}`, { name: 'Team' })).name, 'Team');
});

test('demo_reconnect_capability_matches_actor: any employee may sign a managed Proton mailbox in again', async () => {
  await asViewer('user', async () => {
    const account = await connected('shared@proton.me');
    const list = await demoRequest('GET', '/accounts');
    assert.equal(list.find(a => a.id === account.id).can_reconnect_proton, true);
    assert.ok(list.filter(a => a.mail_provider !== 'proton').every(a => a.can_reconnect_proton !== true));
    const again = await proton('shared@proton.me', { reconnectAccountId: account.id });
    assert.notEqual(again.errorCode, 'already_connected');
  });
});
