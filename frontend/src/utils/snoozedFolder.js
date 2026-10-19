// The folders a snoozed letter already sits in. The server answers a snooze from there with 400
// ("already in Snoozed folder"). It creates the folder through ensureMailbox, so the path carries
// the server's namespace: plain `Snoozed`, `Folders/Snoozed` on a managed Proton mailbox, and
// `INBOX.Snoozed` or `INBOX/Snoozed` on a server whose personal namespace sits under INBOX
// (Dovecot, Courier), the delimiter being the server's own. The real casing comes from the server's
// folder list, so the match ignores case. Only the namespace prefixes are accepted before the name:
// a user's own `Folders/Work/Snoozed` or `Archive.Snoozed` is another folder.
const SNOOZED_FOLDER_RE = /^(?:(?:INBOX|Folders)[./])?Snoozed$/i;

export function isSnoozedFolder(folder) {
  return typeof folder === 'string' && SNOOZED_FOLDER_RE.test(folder);
}
