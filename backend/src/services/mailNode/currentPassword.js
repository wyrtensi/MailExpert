// The password a login of a mail node mailbox should send, when MailExpert restored it while this
// process runs (services/mailNode/passwordRestore.js). Jobs, timers, pool callers and rule forwards
// hold rows they read before the restore; their auth_pass is the replaced password, and a login with
// it would only be rejected again (one more strike toward fail2ban on the node).
//
// The override applies only to a mail_node row whose auth_pass is one this process saw replaced. A
// row holding anything else (read after the restore, or written by some other path) is used as it
// is, so the map can never override a newer password.
//
// The map lives in this process only. MailExpert runs as ONE backend process (docker compose
// starts a single backend; docs/operations/mail-node.md), and this relies on it: a second
// replica would keep its own map, log in with the replaced password and restore once more. Running
// several backends would need this state shared first; nothing here coordinates replicas.

// accountId -> { current: encrypted password now stored, superseded: Set of encrypted passwords it replaced }
const restored = new Map();

// Record that `current` replaced `replaced` (both as stored in email_accounts.auth_pass).
export function noteRestoredPassword(accountId, replaced, current) {
  const prev = restored.get(accountId);
  const superseded = new Set(prev?.superseded);
  if (replaced) superseded.add(replaced);
  superseded.delete(current);
  restored.set(accountId, { current, superseded });
}

// The encrypted password to log in with: the restored one for a mail node row that still holds a
// password it replaced, else the row's own.
export function currentAuthPass(account) {
  const entry = account?.mail_node ? restored.get(account.id) : null;
  return entry && entry.superseded.has(account.auth_pass) ? entry.current : account?.auth_pass;
}
