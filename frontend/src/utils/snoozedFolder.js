// The folders a snoozed letter already sits in. The server answers a snooze from there with 400
// ("already in Snoozed folder"): the plain folder, and the path of a managed Proton mailbox, whose
// Snoozed folder lives under Folders/ (routes/mail.js resolves it through ensureFolder).
const SNOOZED_FOLDERS = new Set(['Snoozed', 'Folders/Snoozed']);

export function isSnoozedFolder(folder) {
  return typeof folder === 'string' && SNOOZED_FOLDERS.has(folder);
}
