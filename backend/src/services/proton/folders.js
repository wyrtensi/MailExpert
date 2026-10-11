import { isManagedProtonAccount } from './mailEndpoint.js';

// Proton's IMAP (Bridge) keeps every user folder under "Folders/" and every label under "Labels/";
// a mailbox created at the root is refused (the spike saw HTTP 500 from POST /api/mail/folders).
// MailExpert adapts its own account-aware folder calls for a managed Proton mailbox: a root name
// goes into the Folders namespace, a path already there is kept, and Labels/ is never offered as a
// folder (a label holds copies, not the letter itself). The shared ensureMailbox, Sent, Drafts and
// flags are left alone. Bridge's hierarchy delimiter is "/".

export class ProtonFolderError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProtonFolderError';
    this.code = code;
  }
}

const FOLDERS = 'Folders';
const LABELS = 'Labels';
// Bridge's own mailboxes at the root. They exist already and take no children.
const SYSTEM = new Set(['inbox', 'drafts', 'sent', 'starred', 'archive', 'spam', 'trash', 'all mail']);

// The Proton path for a folder name, optionally under a parent path. Throws ProtonFolderError:
// proton_label_not_folder for anything under Labels/, proton_folder_invalid for an empty segment,
// a namespace root on its own, or a child of a system mailbox.
export function normalizeProtonFolderPath(path, { parent = null } = {}) {
  if (typeof path !== 'string' || (parent != null && typeof parent !== 'string')) throw new ProtonFolderError('proton_folder_invalid');
  const full = parent ? `${parent}/${path}` : path;
  const segments = full.split('/');
  if (segments.some(segment => !segment.trim())) throw new ProtonFolderError('proton_folder_invalid');
  const head = segments[0].toLowerCase();
  if (head === LABELS.toLowerCase()) throw new ProtonFolderError('proton_label_not_folder');
  if (head === FOLDERS.toLowerCase()) {
    if (segments.length < 2) throw new ProtonFolderError('proton_folder_invalid');
    return [FOLDERS, ...segments.slice(1)].join('/');
  }
  if (SYSTEM.has(head)) {
    if (segments.length > 1) throw new ProtonFolderError('proton_folder_invalid');
    return full;
  }
  return [FOLDERS, ...segments].join('/');
}

// The path the engine creates for this mailbox: translated for a managed Proton mailbox only.
export function accountFolderPath(account, path) {
  return isManagedProtonAccount(account) ? normalizeProtonFolderPath(path) : path;
}

// The target of a rename for this mailbox. On a managed Proton mailbox a folder stays in Folders/
// and a label in Labels/; the namespace roots and the system mailboxes are not renamed.
export function accountRenameTarget(account, oldPath, newPath) {
  if (!isManagedProtonAccount(account)) return newPath;
  const oldSegments = String(oldPath).split('/');
  const oldHead = oldSegments[0].toLowerCase();
  if (oldSegments.length < 2 && (oldHead === FOLDERS.toLowerCase() || oldHead === LABELS.toLowerCase() || SYSTEM.has(oldHead))) {
    throw new ProtonFolderError('proton_folder_invalid');
  }
  if (oldHead === LABELS.toLowerCase()) {
    const newSegments = String(newPath).split('/');
    if (newSegments[0].toLowerCase() !== LABELS.toLowerCase() || newSegments.length < 2 || newSegments.some(segment => !segment.trim())) {
      throw new ProtonFolderError('proton_label_not_folder');
    }
    return newPath;
  }
  return normalizeProtonFolderPath(newPath);
}
