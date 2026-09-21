import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADD_ACCOUNT_KINDS,
  SUGGESTION_BADGE_KEYS,
  SUGGESTION_LIMIT,
  addAccountOptions,
  buildEmailSuggestions,
  canStartGmail,
  exactMailboxMatch,
  gmailStartErrorKey,
  mailboxSuggestion,
  moveSuggestionHighlight,
  shouldFetchKnownEmails,
  suggestionAction,
} from './addAccount.js';

const mailbox = (email, extra = {}) => ({
  id: `id-${email}`, email_address: email, oauth_provider: 'google', enabled: true,
  oauth_reconnect_required: false, sync_error: null, health: 'healthy', ...extra,
});

describe('addAccountOptions', () => {
  const available = { configured: true, available: true };

  it('offers Gmail and manual setup to an administrator, in that order', () => {
    assert.deepEqual(addAccountOptions({ isAdmin: true, googleStatus: available }), [
      { kind: 'gmail', titleKey: 'admin.accounts.add.gmailTitle', descriptionKey: 'admin.accounts.add.gmailDescription', enabled: true, hintKey: null },
      { kind: 'manual', titleKey: 'admin.accounts.add.manualTitle', descriptionKey: 'admin.accounts.add.manualDescription', enabled: true, hintKey: null },
    ]);
  });

  it('hides manual setup from everyone else', () => {
    assert.deepEqual(addAccountOptions({ isAdmin: false, googleStatus: available }).map((o) => o.kind), ['gmail']);
  });

  it('keeps Gmail listed but inactive, with the reason, while no app can take an address', () => {
    const [notConfigured] = addAccountOptions({ googleStatus: { configured: false, available: false } });
    assert.equal(notConfigured.enabled, false);
    assert.equal(notConfigured.hintKey, 'admin.integrations.google.errorNotConfigured');
    const [full] = addAccountOptions({ googleStatus: { configured: true, available: false } });
    assert.equal(full.enabled, false);
    assert.equal(full.hintKey, 'admin.integrations.google.errorNoAppCapacity');
  });

  it('keeps Gmail inactive without a reason while the status loads', () => {
    const [gmail] = addAccountOptions({ googleStatus: null });
    assert.equal(gmail.enabled, false);
    assert.equal(gmail.hintKey, null);
  });

  it('lists only the kinds this version builds (the domain mailbox comes in PR 9)', () => {
    assert.deepEqual([...ADD_ACCOUNT_KINDS], ['gmail', 'manual']);
  });
});

describe('mailboxSuggestion', () => {
  it('marks a working mailbox as connected', () => {
    assert.deepEqual(mailboxSuggestion(mailbox('A@gmail.com')), { email: 'a@gmail.com', kind: 'connected', reconnectUrl: null });
    assert.equal(mailboxSuggestion(mailbox('a@gmail.com', { health: 'failed' })).kind, 'connected');
    assert.equal(mailboxSuggestion(mailbox('a@gmail.com', { health: 'stale' })).kind, 'connected');
  });

  it('offers a reconnect by id for a mailbox that needs one', () => {
    assert.deepEqual(mailboxSuggestion(mailbox('a@gmail.com', { id: 'acc-1', health: 'oauth_reconnect_required' })),
      { email: 'a@gmail.com', kind: 'reconnect', reconnectUrl: '/oauth/google?account=acc-1' });
  });

  it('marks a mailbox disabled in settings', () => {
    assert.equal(mailboxSuggestion(mailbox('a@gmail.com', { health: 'disabled', enabled: false })).kind, 'disabled');
  });

  it('computes the health when the server did not send it', () => {
    assert.equal(mailboxSuggestion(mailbox('a@gmail.com', { health: undefined, enabled: false })).kind, 'disabled');
    assert.equal(mailboxSuggestion(mailbox('a@gmail.com', { health: undefined, oauth_reconnect_required: true })).kind, 'reconnect');
  });

  it('shows a mailbox without a reconnect route as connected', () => {
    assert.equal(mailboxSuggestion(mailbox('a@corp.example', { oauth_provider: null, health: 'oauth_reconnect_required' })).kind, 'connected');
  });
});

describe('buildEmailSuggestions', () => {
  const accounts = [mailbox('zed@gmail.com'), mailbox('Anna@gmail.com', { health: 'oauth_reconnect_required' }), mailbox('bob@corp.example', { oauth_provider: null })];

  it('matches any part of the address, case-insensitively, mailboxes first then the journal', () => {
    const rows = buildEmailSuggestions({ query: 'GMAIL', accounts, knownEmails: ['old@gmail.com'] });
    assert.deepEqual(rows.map((r) => [r.email, r.kind]), [
      ['anna@gmail.com', 'reconnect'],
      ['zed@gmail.com', 'connected'],
      ['old@gmail.com', 'known'],
    ]);
  });

  it('drops a journal address that is already a mailbox', () => {
    const rows = buildEmailSuggestions({ query: 'zed', accounts, knownEmails: ['ZED@gmail.com'] });
    assert.deepEqual(rows.map((r) => r.kind), ['connected']);
  });

  it('shows nothing for an empty query', () => {
    assert.deepEqual(buildEmailSuggestions({ query: '  ', accounts, knownEmails: ['a@gmail.com'] }), []);
  });

  it('caps the list at eight rows', () => {
    const many = Array.from({ length: 6 }, (_, i) => mailbox(`box${i}@gmail.com`));
    const known = Array.from({ length: 6 }, (_, i) => `old${i}@gmail.com`);
    const rows = buildEmailSuggestions({ query: '@gmail', accounts: many, knownEmails: known });
    assert.equal(SUGGESTION_LIMIT, 8);
    assert.equal(rows.length, 8);
    assert.deepEqual(rows.slice(6).map((r) => r.kind), ['known', 'known']);
  });

  it('has a badge key for every kind', () => {
    for (const kind of ['connected', 'reconnect', 'disabled', 'known']) assert.match(SUGGESTION_BADGE_KEYS[kind], /^admin\.accounts\.add\.badge/);
  });
});

describe('exactMailboxMatch and canStartGmail', () => {
  const accounts = [mailbox('anna@gmail.com')];

  it('finds a mailbox whose address is typed in full, whatever the case and spaces', () => {
    assert.equal(exactMailboxMatch(' Anna@Gmail.com ', accounts)?.kind, 'connected');
    assert.equal(exactMailboxMatch('anna@gmail.co', accounts), null);
  });

  it('starts only for a valid address that is not already a mailbox', () => {
    assert.equal(canStartGmail('new@gmail.com', accounts), true);
    assert.equal(canStartGmail('ANNA@gmail.com', accounts), false);
    assert.equal(canStartGmail('not an email', accounts), false);
    assert.equal(canStartGmail('', accounts), false);
  });
});

describe('shouldFetchKnownEmails', () => {
  it('asks the journal from two characters up to the server limit', () => {
    assert.equal(shouldFetchKnownEmails('a'), false);
    assert.equal(shouldFetchKnownEmails(' ab '), true);
    assert.equal(shouldFetchKnownEmails('x'.repeat(254)), true);
    assert.equal(shouldFetchKnownEmails('x'.repeat(255)), false);
  });
});

describe('moveSuggestionHighlight', () => {
  it('walks down and up with wrap-around', () => {
    assert.equal(moveSuggestionHighlight(-1, 'ArrowDown', 3), 0);
    assert.equal(moveSuggestionHighlight(2, 'ArrowDown', 3), 0);
    assert.equal(moveSuggestionHighlight(-1, 'ArrowUp', 3), 2);
    assert.equal(moveSuggestionHighlight(0, 'ArrowUp', 3), 2);
    assert.equal(moveSuggestionHighlight(1, 'ArrowUp', 3), 0);
  });

  it('stays off the list when it is empty and ignores other keys', () => {
    assert.equal(moveSuggestionHighlight(0, 'ArrowDown', 0), -1);
    assert.equal(moveSuggestionHighlight(1, 'Tab', 3), 1);
  });
});

describe('suggestionAction', () => {
  it('fills a journal address and reconnects a broken mailbox', () => {
    assert.deepEqual(suggestionAction({ email: 'old@gmail.com', kind: 'known', reconnectUrl: null }), { type: 'fill', email: 'old@gmail.com' });
    assert.deepEqual(suggestionAction({ email: 'a@gmail.com', kind: 'reconnect', reconnectUrl: '/oauth/google?account=acc-1' }),
      { type: 'reconnect', url: '/oauth/google?account=acc-1' });
  });

  it('cannot pick a connected or disabled mailbox', () => {
    assert.equal(suggestionAction({ email: 'a@gmail.com', kind: 'connected', reconnectUrl: null }), null);
    assert.equal(suggestionAction({ email: 'a@gmail.com', kind: 'disabled', reconnectUrl: null }), null);
    assert.equal(suggestionAction(null), null);
  });
});

describe('gmailStartErrorKey', () => {
  it('maps the start refusals to their messages', () => {
    assert.equal(gmailStartErrorKey('already_connected'), 'admin.integrations.google.errorAlreadyConnected');
    assert.equal(gmailStartErrorKey('no_app_capacity'), 'admin.integrations.google.errorNoAppCapacity');
    assert.equal(gmailStartErrorKey('not_configured'), 'admin.integrations.google.errorNotConfigured');
    assert.equal(gmailStartErrorKey('email_invalid'), 'admin.accounts.add.errorInvalidEmail');
  });

  it('falls back to the generic message', () => {
    assert.equal(gmailStartErrorKey(undefined), 'admin.integrations.google.errorGeneric');
    assert.equal(gmailStartErrorKey('toString'), 'admin.integrations.google.errorGeneric');
  });
});
