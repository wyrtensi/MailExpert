import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isMailboxBusy, mailboxBusyOr, mailboxBusyText, MAILBOX_BUSY_CODE, MAILBOX_AUTH_REJECTED_CODE, MOVE_PENDING_CODE } from './mailboxBusy.js';

const locale = name => JSON.parse(readFileSync(new URL(`../locales/${name}.json`, import.meta.url), 'utf8'));

describe('mailbox busy errors', () => {
  it('recognises only the stable code the server sends', () => {
    assert.equal(MAILBOX_BUSY_CODE, 'mailbox_busy');
    assert.equal(isMailboxBusy(Object.assign(new Error('x'), { code: 'mailbox_busy' })), true);
    assert.equal(isMailboxBusy(new Error('IMAP pool busy, please retry')), false);
    assert.equal(isMailboxBusy(null), false);
    // A partial-success bulk response body carries the same code.
    assert.equal(isMailboxBusy({ ok: true, moved: ['a'], busy: true, code: 'mailbox_busy' }), true);
    assert.equal(isMailboxBusy({ ok: true, moved: ['a'] }), false);
  });

  it('shows the busy text for a busy mailbox and the old message otherwise', () => {
    const t = key => `t:${key}`;
    assert.equal(mailboxBusyOr({ code: 'mailbox_busy' }, t, 'fallback'), 't:common.mailboxBusy');
    assert.equal(mailboxBusyOr(new Error('boom'), t, 'fallback'), 'fallback');
  });

  it('is translated in both languages', () => {
    assert.equal(locale('ru').common.mailboxBusy, 'Ящик занят, попробуйте через несколько секунд');
    assert.equal(locale('en').common.mailboxBusy, 'The mailbox is busy, try again in a few seconds');
  });

  it('tells a rejected password apart: retrying will not help, the mailbox must be checked', () => {
    const t = key => `t:${key}`;
    const rejected = Object.assign(new Error('x'), { code: MAILBOX_AUTH_REJECTED_CODE });
    assert.equal(MAILBOX_AUTH_REJECTED_CODE, 'mailbox_auth_rejected');
    assert.equal(isMailboxBusy(rejected), true);
    assert.equal(mailboxBusyOr(rejected, t, 'fallback'), 't:common.mailboxAuthRejected');
    assert.equal(mailboxBusyText(rejected, t), 't:common.mailboxAuthRejected');
    assert.equal(mailboxBusyText({ code: 'mailbox_busy' }, t), 't:common.mailboxBusy');
    // A partial-success bulk response body carries it too.
    assert.equal(mailboxBusyOr({ ok: true, moved: ['a'], busy: true, code: 'mailbox_auth_rejected' }, t, 'fallback'), 't:common.mailboxAuthRejected');
    // Neutral about where to fix it: a mail-node mailbox cannot change its password in its settings.
    assert.equal(locale('en').common.mailboxAuthRejected, 'The mail server does not accept the sign-in to this mailbox. Ask an administrator to check the mailbox.');
    assert.equal(locale('ru').common.mailboxAuthRejected, 'Почтовый сервер не принимает вход в этот ящик. Попросите администратора проверить ящик.');
  });

  // A letter whose DB-first move has not reached the server: a permanent delete, a snooze or an
  // uncached body waits for it (409 move_pending). A partial bulk delete carries the code too.
  it('says a letter is still being moved, which a retry in a few seconds fixes', () => {
    const t = key => `t:${key}`;
    const pending = Object.assign(new Error('x'), { code: MOVE_PENDING_CODE });
    assert.equal(MOVE_PENDING_CODE, 'move_pending');
    assert.equal(isMailboxBusy(pending), true);
    assert.equal(mailboxBusyText(pending, t), 't:common.movePending');
    assert.equal(mailboxBusyOr({ ok: true, deleted: ['a'], code: 'move_pending' }, t, 'fallback'), 't:common.movePending');
  });
});
