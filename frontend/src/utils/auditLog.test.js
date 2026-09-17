import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT_ACTIONS, auditActionLabelKey, auditDetail, auditQuery } from './auditLog.js';

describe('AUDIT_ACTIONS', () => {
  it('lists every action the server records, each with a label', () => {
    assert.deepEqual(AUDIT_ACTIONS, [
      'mailbox.added', 'mailbox.reconnected', 'mailbox.deleted', 'mailbox.connection_changed',
      'mailbox.enabled', 'mailbox.disabled', 'message.sent', 'message.deleted',
      'user.added', 'user.deleted', 'user.enabled', 'user.disabled', 'user.admin_changed',
    ]);
    assert.equal(auditActionLabelKey('message.sent'), 'admin.audit.actionMessageSent');
    assert.equal(auditActionLabelKey('user.admin_changed'), 'admin.audit.actionUserAdminChanged');
    assert.equal(auditActionLabelKey('message.read'), null);
  });
});

describe('auditQuery', () => {
  it('leaves empty filters out', () => {
    assert.deepEqual(auditQuery({}), {});
    assert.deepEqual(auditQuery({ account: '', user: '', action: '', fromDate: '', toDate: '', before: null }), {});
    assert.deepEqual(auditQuery(), {});
  });

  it('passes the chosen mailbox, user, action and cursor through', () => {
    assert.deepEqual(
      auditQuery({ account: 'acc-1', user: 'user-1', action: 'message.deleted', before: '2026-09-17T10:00:00.123456Z_42' }),
      { account: 'acc-1', user: 'user-1', action: 'message.deleted', before: '2026-09-17T10:00:00.123456Z_42' },
    );
  });

  it('turns local days into an inclusive range: from the start of the first day to the start of the day after the last', () => {
    assert.deepEqual(auditQuery({ fromDate: '2026-09-01', toDate: '2026-09-17' }), {
      from: new Date(2026, 8, 1).toISOString(),
      to: new Date(2026, 8, 18).toISOString(),
    });
    assert.deepEqual(auditQuery({ toDate: '2026-12-31' }), { to: new Date(2027, 0, 1).toISOString() });
  });

  it('ignores a date that is not a calendar day', () => {
    assert.deepEqual(auditQuery({ fromDate: 'yesterday', toDate: '17.09.2026' }), {});
  });
});

describe('auditDetail', () => {
  it('names the OAuth provider of an added or reconnected mailbox', () => {
    assert.deepEqual(
      auditDetail({ action: 'mailbox.added', details: { protocol: 'imap', oauthProvider: 'google' } }),
      { key: 'admin.audit.detailProvider', values: { provider: 'google' } },
    );
    assert.deepEqual(
      auditDetail({ action: 'mailbox.reconnected', details: { oauthProvider: 'microsoft' } }),
      { key: 'admin.audit.detailProvider', values: { provider: 'microsoft' } },
    );
    assert.equal(auditDetail({ action: 'mailbox.added', details: { protocol: 'imap', oauthProvider: null } }), null);
  });

  it('lists changed connection fields', () => {
    assert.deepEqual(
      auditDetail({ action: 'mailbox.connection_changed', details: { fields: ['imap_host', 'auth_pass'] } }),
      { key: 'admin.audit.detailFields', values: { fields: 'imap_host, auth_pass' } },
    );
    assert.equal(auditDetail({ action: 'mailbox.connection_changed', details: { fields: [] } }), null);
  });

  it('lists every recipient of a sent message', () => {
    assert.deepEqual(
      auditDetail({ action: 'message.sent', details: { messageId: '<m@x>', to: ['a@example.com'], cc: ['b@example.com'], bcc: ['c@example.com'] } }),
      { key: 'admin.audit.detailRecipients', values: { recipients: 'a@example.com, b@example.com, c@example.com' } },
    );
  });

  it('tells a move to Trash from a permanent delete', () => {
    assert.deepEqual(
      auditDetail({ action: 'message.deleted', details: { messageId: '<m@x>', folder: 'INBOX', from: 's@example.com', permanent: false } }),
      { key: 'admin.audit.detailMovedToTrash', values: { from: 's@example.com', folder: 'INBOX' } },
    );
    assert.deepEqual(
      auditDetail({ action: 'message.deleted', details: { folder: 'Trash', from: null, permanent: true } }),
      { key: 'admin.audit.detailDeletedForever', values: { from: '', folder: 'Trash' } },
    );
  });

  it('describes user actions by email', () => {
    assert.deepEqual(
      auditDetail({ action: 'user.admin_changed', details: { userId: 'u', email: 'u@example.com', isAdmin: true } }),
      { key: 'admin.audit.detailAdminGranted', values: { email: 'u@example.com' } },
    );
    assert.deepEqual(
      auditDetail({ action: 'user.admin_changed', details: { userId: 'u', email: 'u@example.com', isAdmin: false } }),
      { key: 'admin.audit.detailAdminRevoked', values: { email: 'u@example.com' } },
    );
    assert.deepEqual(auditDetail({ action: 'user.disabled', details: { userId: 'u', email: 'u@example.com', isAdmin: false } }), { text: 'u@example.com' });
    assert.equal(auditDetail({ action: 'user.deleted', details: { userId: 'u', email: null, isAdmin: false } }), null);
  });

  it('shows nothing for actions without details or unknown entries', () => {
    assert.equal(auditDetail({ action: 'mailbox.deleted', details: {} }), null);
    assert.equal(auditDetail({ action: 'mailbox.disabled' }), null);
    assert.equal(auditDetail(null), null);
  });
});
