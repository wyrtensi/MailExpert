// Helpers for the admin audit log screen. Actions and details mirror
// backend/src/services/auditLog.js and the entries GET /api/admin/audit returns.

export const AUDIT_ACTION_LABEL_KEYS = Object.freeze({
  'mailbox.added': 'admin.audit.actionMailboxAdded',
  'mailbox.reconnected': 'admin.audit.actionMailboxReconnected',
  'mailbox.deleted': 'admin.audit.actionMailboxDeleted',
  'mailbox.connection_changed': 'admin.audit.actionMailboxConnectionChanged',
  'mailbox.enabled': 'admin.audit.actionMailboxEnabled',
  'mailbox.disabled': 'admin.audit.actionMailboxDisabled',
  'message.sent': 'admin.audit.actionMessageSent',
  'message.deleted': 'admin.audit.actionMessageDeleted',
  'user.added': 'admin.audit.actionUserAdded',
  'user.deleted': 'admin.audit.actionUserDeleted',
  'user.enabled': 'admin.audit.actionUserEnabled',
  'user.disabled': 'admin.audit.actionUserDisabled',
  'user.admin_changed': 'admin.audit.actionUserAdminChanged',
});

export const AUDIT_ACTIONS = Object.freeze(Object.keys(AUDIT_ACTION_LABEL_KEYS));

export function auditActionLabelKey(action) {
  return AUDIT_ACTION_LABEL_KEYS[action] ?? null;
}

// Start of a local calendar day (YYYY-MM-DD from a date input) as an ISO timestamp, moved
// forward by `dayOffset` days. Anything else is not a day and yields null.
function localDayStart(day, dayOffset = 0) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + dayOffset).toISOString();
}

// Query for GET /api/admin/audit. Empty filters are left out. The admin picks both days
// inclusively, while the API's `to` is exclusive, so `to` is the start of the next day.
export function auditQuery({ account, user, action, fromDate, toDate, before } = {}) {
  const query = {};
  if (account) query.account = account;
  if (user) query.user = user;
  if (action) query.action = action;
  const from = localDayStart(fromDate);
  if (from) query.from = from;
  const to = localDayStart(toDate, 1);
  if (to) query.to = to;
  if (before) query.before = before;
  return query;
}

// What the details column shows for an entry: a translation key with its values, plain text,
// or null when there is nothing to add.
export function auditDetail(entry) {
  const details = entry?.details ?? {};
  switch (entry?.action) {
    case 'mailbox.added':
    case 'mailbox.reconnected':
      return details.oauthProvider
        ? { key: 'admin.audit.detailProvider', values: { provider: details.oauthProvider } }
        : null;
    case 'mailbox.connection_changed':
      return Array.isArray(details.fields) && details.fields.length
        ? { key: 'admin.audit.detailFields', values: { fields: details.fields.join(', ') } }
        : null;
    case 'message.sent': {
      const recipients = [...(details.to ?? []), ...(details.cc ?? []), ...(details.bcc ?? [])];
      return recipients.length
        ? { key: 'admin.audit.detailRecipients', values: { recipients: recipients.join(', ') } }
        : null;
    }
    case 'message.deleted': {
      const folder = details.folder ?? '';
      // The backend stores `from: null` when a message had no sender address.
      if (!details.from) {
        return {
          key: details.permanent ? 'admin.audit.detailDeletedForeverNoSender' : 'admin.audit.detailMovedToTrashNoSender',
          values: { folder },
        };
      }
      return {
        key: details.permanent ? 'admin.audit.detailDeletedForever' : 'admin.audit.detailMovedToTrash',
        values: { from: details.from, folder },
      };
    }
    case 'user.admin_changed':
      return {
        key: details.isAdmin ? 'admin.audit.detailAdminGranted' : 'admin.audit.detailAdminRevoked',
        values: { email: details.email ?? '' },
      };
    case 'user.added':
    case 'user.deleted':
    case 'user.enabled':
    case 'user.disabled':
      return details.email ? { text: details.email } : null;
    default:
      return null;
  }
}
