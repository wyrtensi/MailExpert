import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  advancedFromDefaults,
  connectionErrorKey,
  connectionNextStepKey,
  emptyAdvanced,
  findReconnectTarget,
  isAuthRefusal,
  isServerChanged,
  missingServerFields,
  otherProviderForEmail,
  portProblems,
  protonErrorKey,
  protonStartBody,
  providerConnectionPayload,
  providerForEmail,
} from './providerConnection.js';

const CATALOG = [
  { id: 'yahoo', imap: { host: 'imap.mail.yahoo.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.mail.yahoo.com', port: 587, tls: 'starttls' }, appPasswordUrl: 'https://login.yahoo.com/account/security', publicDomains: ['yahoo.com', 'ymail.com', 'rocketmail.com'], loginAlternatives: { imap: ['full_address'], smtp: ['full_address'] } },
  { id: 'yandex', imap: { host: 'imap.yandex.ru', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.yandex.ru', port: 465, tls: 'implicit' }, appPasswordUrl: 'https://id.yandex.ru/security', publicDomains: ['yandex.ru', 'ya.ru', 'yandex.com'], loginAlternatives: { imap: ['full_address'], smtp: ['full_address'] } },
  { id: 'mailru', imap: { host: 'imap.mail.ru', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.mail.ru', port: 465, tls: 'implicit' }, appPasswordUrl: 'https://account.mail.ru/user/2-step-auth/passwords/', publicDomains: ['mail.ru', 'bk.ru', 'list.ru', 'inbox.ru', 'internet.ru'], loginAlternatives: { imap: ['full_address'], smtp: ['full_address'] } },
  { id: 'icloud', imap: { host: 'imap.mail.me.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.mail.me.com', port: 587, tls: 'starttls' }, appPasswordUrl: 'https://account.apple.com/', publicDomains: ['icloud.com', 'me.com', 'mac.com'], loginAlternatives: { imap: ['full_address', 'local_part'], smtp: ['full_address'] } },
];
const mailru = CATALOG[2];

describe('providerConnectionPayload', () => {
  it('unchanged_advanced_uses_fixed_provider', () => {
    const advanced = advancedFromDefaults(mailru);
    const payload = providerConnectionPayload({ provider: 'mailru', email: ' team@bk.ru ', appPassword: 'secret-sentinel', advanced }, mailru);
    assert.equal(payload.mode, 'preset');
    assert.deepEqual(payload.body, { provider: 'mailru', email: 'team@bk.ru', appPassword: 'secret-sentinel' });
  });

  it('opening the advanced block without changing a server value does not convert the mode', () => {
    const payload = providerConnectionPayload({
      provider: 'yahoo', email: 'a@yahoo.com', appPassword: 'p',
      advanced: { ...advancedFromDefaults(CATALOG[0]), imap_host: ' IMAP.mail.yahoo.com ', imap_port: '993' },
    }, CATALOG[0]);
    assert.equal(payload.mode, 'preset');
    assert.equal('imap_host' in payload.body, false);
  });

  it('server_edit_switches_to_manual_and_preserves_label', () => {
    const advanced = { ...advancedFromDefaults(mailru), imap_host: 'imap.example.com' };
    const payload = providerConnectionPayload({
      provider: 'mailru', email: 'team@bk.ru', appPassword: 'secret-sentinel', advanced, metadata: { name: 'Support team' },
    }, mailru);
    assert.equal(payload.mode, 'manual');
    assert.equal(payload.body.provider, 'mailru');
    assert.equal(payload.body.email_address, 'team@bk.ru');
    assert.equal(payload.body.imap_host, 'imap.example.com');
    assert.deepEqual(
      { port: payload.body.imap_port, mode: payload.body.imap_tls_mode, smtp: payload.body.smtp_host, smtpPort: payload.body.smtp_port, tls: payload.body.smtp_tls },
      { port: 993, mode: 'implicit', smtp: 'smtp.mail.ru', smtpPort: 465, tls: 'SSL' },
    );
    assert.equal(payload.body.auth_user, 'team@bk.ru');
    assert.equal(payload.body.auth_pass, 'secret-sentinel');
    assert.equal(payload.body.name, 'Support team');
    // The strict manual parser rejects anything outside its field list, and the TLS bypass is not one of them.
    for (const forbidden of ['appPassword', 'email', 'login', 'imap_skip_tls_verify', 'imap_tls', 'protocol']) assert.equal(forbidden in payload.body, false, forbidden);
  });

  it('a port or TLS change alone is a server change, sent as numbers and the server vocabulary', () => {
    const advanced = { ...advancedFromDefaults(CATALOG[0]), smtp_port: '465', smtp_tls: 'SSL' };
    const payload = providerConnectionPayload({ provider: 'yahoo', email: 'a@yahoo.com', appPassword: 'p', advanced }, CATALOG[0]);
    assert.equal(payload.mode, 'manual');
    assert.equal(payload.body.smtp_port, 465);
    assert.equal(payload.body.smtp_tls, 'SSL');
    assert.equal(typeof payload.body.imap_port, 'number');
  });

  it('known_alternate_domains_keep_full_address', () => {
    const payload = providerConnectionPayload({ provider: 'mailru', email: 'team@internet.ru', appPassword: 'p', advanced: advancedFromDefaults(mailru) }, mailru);
    assert.equal(payload.body.email, 'team@internet.ru');
    assert.equal('login' in payload.body, false);
    const icloud = providerConnectionPayload({ provider: 'icloud', email: 'pat@me.com', appPassword: 'p' }, CATALOG[3]);
    assert.equal(icloud.body.email, 'pat@me.com');
    assert.equal('login' in icloud.body, false);
  });

  it('unknown_domain_never_changes_server', () => {
    assert.equal(providerForEmail('someone@corp.example', CATALOG), null);
    assert.equal(providerForEmail('someone@notmail.ru', CATALOG), null);
    assert.equal(providerForEmail('someone@evilmail.ru', CATALOG), null);
    assert.equal(providerForEmail('someone@sub.yahoo.com', CATALOG), null);
    const payload = providerConnectionPayload({ provider: 'yandex', email: 'someone@corp.example', appPassword: 'p', advanced: advancedFromDefaults(CATALOG[1]) }, CATALOG[1]);
    assert.equal(payload.mode, 'preset');
    assert.deepEqual(Object.keys(payload.body).sort(), ['appPassword', 'email', 'provider']);
  });

  it('recognises an exact public domain, case-insensitively, and offers the other tile as a hint only', () => {
    assert.equal(providerForEmail('Team@BK.RU', CATALOG), 'mailru');
    assert.equal(otherProviderForEmail('team@bk.ru', 'yahoo', CATALOG), 'mailru');
    assert.equal(otherProviderForEmail('team@bk.ru', 'mailru', CATALOG), null);
    assert.equal(otherProviderForEmail('team@corp.example', 'yahoo', CATALOG), null);
    assert.equal(otherProviderForEmail('not an address', 'yahoo', CATALOG), null);
  });

  it('sends a separate login only when the user typed one', () => {
    const base = { provider: 'yandex', email: 'ann@ya.ru', appPassword: 'p', advanced: advancedFromDefaults(CATALOG[1]) };
    assert.equal('login' in providerConnectionPayload({ ...base, login: '   ' }, CATALOG[1]).body, false);
    assert.equal(providerConnectionPayload({ ...base, login: ' ann ' }, CATALOG[1]).body.login, 'ann');
    const manual = providerConnectionPayload({ ...base, login: 'ann', advanced: { ...advancedFromDefaults(CATALOG[1]), smtp_host: 'smtp.example.com' } }, CATALOG[1]);
    assert.equal(manual.body.auth_user, 'ann');
  });

  it('carries optional metadata in each route spelling and omits empty values', () => {
    const preset = providerConnectionPayload({
      provider: 'yahoo', email: 'a@yahoo.com', appPassword: 'p',
      metadata: { name: ' Sales ', senderName: 'Ann', signature: '', color: '#112233' },
    }, CATALOG[0]);
    assert.deepEqual(preset.body, { provider: 'yahoo', email: 'a@yahoo.com', appPassword: 'p', name: 'Sales', senderName: 'Ann', color: '#112233' });
    const manual = providerConnectionPayload({
      provider: 'yahoo', email: 'a@yahoo.com', appPassword: 'p', advanced: { ...advancedFromDefaults(CATALOG[0]), imap_host: 'imap.example.com' },
      metadata: { name: 'Sales', senderName: 'Ann', signature: 'Best', color: '#112233' },
    }, CATALOG[0]);
    assert.equal(manual.body.sender_name, 'Ann');
    assert.equal(manual.body.signature, 'Best');
    assert.equal(manual.body.color, '#112233');
  });

  it('Other is always manual, labelled other, with explicit server values and no invented hosts', () => {
    assert.equal(emptyAdvanced().imap_host, '');
    assert.equal(emptyAdvanced().smtp_host, '');
    const advanced = { ...emptyAdvanced(), imap_host: 'imap.example.com', smtp_host: 'smtp.example.com', smtp_login: 'relay-user' };
    const payload = providerConnectionPayload({ provider: 'other', email: 'me@example.com', appPassword: 'p', advanced }, null);
    assert.equal(payload.mode, 'manual');
    assert.equal(payload.body.provider, 'other');
    assert.equal(payload.body.imap_host, 'imap.example.com');
    assert.equal(payload.body.smtp_auth_user, 'relay-user');
    assert.equal(payload.body.auth_user, 'me@example.com');
  });

  it('a fixed provider without catalog defaults sends the fixed-provider body and no server values', () => {
    const payload = providerConnectionPayload({ provider: 'yahoo', email: 'a@yahoo.com', appPassword: 'p', advanced: emptyAdvanced() }, null);
    assert.equal(payload.mode, 'preset');
    assert.deepEqual(Object.keys(payload.body).sort(), ['appPassword', 'email', 'provider']);
  });
});

describe('advanced server values', () => {
  it('detects a change per field and ignores case, spacing and number spelling', () => {
    const base = advancedFromDefaults(CATALOG[1]);
    assert.equal(isServerChanged(base, CATALOG[1]), false);
    assert.equal(isServerChanged({ ...base, imap_host: ' IMAP.Yandex.ru ', imap_port: '993' }, CATALOG[1]), false);
    for (const change of [{ imap_host: 'x.example.com' }, { imap_port: '143' }, { imap_tls_mode: 'starttls' }, { smtp_host: 'x.example.com' }, { smtp_port: '587' }, { smtp_tls: 'STARTTLS' }]) {
      assert.equal(isServerChanged({ ...base, ...change }, CATALOG[1]), true, JSON.stringify(change));
    }
  });

  it('lists the missing server fields of Other', () => {
    assert.deepEqual(missingServerFields(emptyAdvanced()), ['imap_host', 'smtp_host']);
    assert.deepEqual(missingServerFields({ ...emptyAdvanced(), imap_host: 'imap.example.com', smtp_host: 'smtp.example.com' }), []);
    assert.deepEqual(missingServerFields({ ...emptyAdvanced(), imap_host: 'a', smtp_host: 'b', imap_port: '' }), ['imap_port']);
    assert.deepEqual(missingServerFields({ ...emptyAdvanced(), imap_host: ' ', smtp_host: 'b' }), ['imap_host']);
  });

  it('checks ports as integers and, unless the installation allows others, the standard ones', () => {
    const ok = { ...emptyAdvanced(), imap_host: 'a', smtp_host: 'b' };
    assert.deepEqual(portProblems(ok, { allowNonstandardPorts: false }), []);
    assert.deepEqual(portProblems({ ...ok, imap_port: '70000' }, { allowNonstandardPorts: true }), ['imap_port']);
    assert.deepEqual(portProblems({ ...ok, smtp_port: 'abc' }, { allowNonstandardPorts: true }), ['smtp_port']);
    assert.deepEqual(portProblems({ ...ok, imap_port: '2993' }, { allowNonstandardPorts: false }), ['imap_port']);
    assert.deepEqual(portProblems({ ...ok, imap_port: '2993', smtp_port: '2525' }, { allowNonstandardPorts: true }), []);
    assert.deepEqual(portProblems({ ...ok, imap_port: '143', smtp_port: '465' }, { allowNonstandardPorts: false }), []);
  });
});

describe('error codes', () => {
  it('maps every probe, creation and rate code to its own message and the rest to a generic one', () => {
    const codes = ['email_invalid', 'login_invalid', 'imap_auth_failed', 'smtp_auth_failed', 'imap_unavailable', 'smtp_unavailable', 'connection_timeout', 'tls_error', 'connection_cancelled', 'server_refused', 'already_connected', 'idempotency_conflict', 'rate_limited', 'invalid_request'];
    const keys = codes.map((code) => connectionErrorKey(code));
    assert.equal(new Set(keys).size, codes.length);
    for (const key of keys) assert.match(key, /^admin\.accounts\.add\.error\./);
    assert.equal(connectionErrorKey('toString'), connectionErrorKey('nothing_known'));
    assert.equal(connectionErrorKey(undefined), connectionErrorKey('nothing_known'));
  });

  it('only an AUTH refusal asks for a separate login', () => {
    assert.equal(isAuthRefusal('imap_auth_failed'), true);
    assert.equal(isAuthRefusal('smtp_auth_failed'), true);
    for (const code of ['tls_error', 'connection_timeout', 'imap_unavailable', 'server_refused', undefined]) assert.equal(isAuthRefusal(code), false);
  });

  it('maps every Proton code of the connection API to a distinct message', () => {
    const codes = ['invalid_credentials', 'connection', 'verification_required', 'login_busy', 'login_failed', 'proton_unavailable', 'already_connected', 'reconnect_unavailable', 'reconnect_mismatch', 'address_mismatch', 'imap_auth_failed', 'smtp_auth_failed', 'imap_unavailable', 'smtp_unavailable', 'connection_timeout', 'tls_error', 'connection_cancelled', 'server_refused', 'invalid_challenge', 'rate_limited', 'idempotency_conflict', 'invalid_request', 'expired', 'cancelled'];
    const keys = codes.map((code) => protonErrorKey(code));
    assert.equal(new Set(keys).size, codes.length, 'every Proton code has its own key');
    assert.notEqual(protonErrorKey('connection'), protonErrorKey('invalid_credentials'));
    assert.equal(protonErrorKey('toString'), protonErrorKey('nothing_known'));
  });
});

describe('Proton request body and reconnect', () => {
  it('starts with the address, the password and the attempt id in the body', () => {
    const body = protonStartBody({ email: ' Ann@Proton.me ', password: 'secret-sentinel', requestId: 'id-1' });
    assert.deepEqual(body, { email: 'Ann@Proton.me', password: 'secret-sentinel', requestId: 'id-1' });
    const full = protonStartBody({ email: 'a@proton.me', password: 'p', requestId: 'id-1', reconnectAccountId: 'acc-1', metadata: { name: 'N', senderName: 'S', signature: 'G', color: '#fff', empty: '' } });
    assert.deepEqual(full, { email: 'a@proton.me', password: 'p', requestId: 'id-1', reconnectAccountId: 'acc-1', name: 'N', senderName: 'S', signature: 'G', color: '#fff' });
  });

  it('reconnect_seed_requires_capability', () => {
    const accounts = [
      { id: 'a1', email_address: 'ann@proton.me', mail_provider: 'proton', can_reconnect_proton: true },
      { id: 'a2', email_address: 'bob@proton.me', mail_provider: 'proton', can_reconnect_proton: false },
      { id: 'a3', email_address: 'cat@proton.me', mail_provider: 'other', connection_mode: 'manual' },
    ];
    assert.equal(findReconnectTarget(accounts, 'ANN@proton.me')?.id, 'a1');
    assert.equal(findReconnectTarget(accounts, 'bob@proton.me'), null);
    assert.equal(findReconnectTarget(accounts, 'cat@proton.me'), null);
    assert.equal(findReconnectTarget(accounts, 'nobody@proton.me'), null);
    assert.equal(findReconnectTarget(accounts, 'bob@proton.me', accounts[1]), null);
    assert.equal(findReconnectTarget(accounts, 'ann@proton.me', accounts[0])?.id, 'a1');
    // A seed whose address differs from the typed one is not used.
    assert.equal(findReconnectTarget(accounts, 'zed@proton.me', accounts[0]), null);
    // Capability is the server's: a seed claiming it is checked against the list.
    assert.equal(findReconnectTarget(accounts, 'bob@proton.me', { ...accounts[1], can_reconnect_proton: true }), null);
  });
});

describe('connectionNextStepKey', () => {
  it('names the next step of an AUTH refusal per service, and nothing for other codes or services', () => {
    assert.equal(connectionNextStepKey('imap_auth_failed', 'yahoo'), 'admin.accounts.add.error.next.yahooAuth');
    assert.equal(connectionNextStepKey('smtp_auth_failed', 'icloud'), 'admin.accounts.add.error.next.icloudAuth');
    assert.equal(connectionNextStepKey('imap_auth_failed', 'other'), 'admin.accounts.add.error.next.otherAuth');
    assert.equal(connectionNextStepKey('tls_error', 'yahoo'), null);
    assert.equal(connectionNextStepKey('imap_auth_failed', 'gmail'), null);
    assert.equal(connectionNextStepKey('imap_auth_failed', 'toString'), null);
  });
});
