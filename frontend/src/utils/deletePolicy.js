// MAIL_DELETE_ENABLED=false on the server (GET /api/auth/config -> deleteEnabled): the client
// hides every way to delete letters. The server refuses them anyway (403 mail_delete_disabled);
// these helpers keep the controls out of sight so nobody reaches that refusal by accident.
// Pure functions, so they run under `node --test`.

// The server's answer when deleting letters is turned off.
export const MAIL_DELETE_DISABLED_CODE = 'mail_delete_disabled';

// The names the server treats as Trash at the top level (backend/src/utils/mailUtils.js,
// TRASH_FOLDER_SQL).
const TRASH_NAMES = new Set(['trash', 'deleted', 'deleted items', 'deleted messages']);

// Whether a folder entry of GET /api/mail/folders is a Trash folder, as the server resolves it:
// the account's mapped Trash, a \Trash folder, or a top-level folder with a Trash name.
export function isTrashFolderEntry(folder, folderMappings) {
  if (!folder) return false;
  if (folderMappings?.trash) return folder.path === folderMappings.trash;
  if (folder.special_use === '\\Trash') return true;
  const topLevel = !folder.delimiter || !String(folder.path).includes(folder.delimiter);
  return topLevel && TRASH_NAMES.has(String(folder.name ?? folder.path).toLowerCase());
}

// Move destinations a user may pick: no Trash while deleting is off.
export function movableFolders(folders, deleteEnabled, folderMappings) {
  if (deleteEnabled || !Array.isArray(folders)) return folders;
  return folders.filter(f => !isTrashFolderEntry(f, folderMappings));
}

// The hover quick actions to render.
export function allowedHoverActions(keys, deleteEnabled) {
  return deleteEnabled ? keys : keys.filter(k => k !== 'delete');
}

// A swipe action to run: delete becomes nothing while deleting is off.
export function allowedSwipeAction(action, deleteEnabled) {
  return !deleteEnabled && action === 'delete' ? 'disabled' : action;
}

// Choice lists (swipe actions, hover actions, rule actions, cleanup actions, shortcuts): items
// whose id is one of `deleteIds` go while deleting is off.
export function withoutDeleteChoices(items, deleteEnabled, deleteIds = ['delete']) {
  if (deleteEnabled || !Array.isArray(items)) return items;
  return items.filter(item => !deleteIds.includes(typeof item === 'string' ? item : item?.id));
}
