import { isTrashOrJunkFolder } from './specialFolders.js';

// Which messages a thread-wide action should actually operate on.
//
// A thread row stands for several messages, so acting on one means resolving the rest. The
// obvious place to get them is the cache populated when the thread was last expanded, and that
// is the trap: the cache is a snapshot, and a thread gains messages while you are looking at it.
//
// The observed failure: a GitHub thread received a reply after the thread was opened. Marking it
// read sent the bulk-read call for the CACHED ids, so the newer message was never included and
// stayed unread on the server. The UI then marked the cached copies read, so the row rendered as
// read with the unread message hidden inside it. The account badge showed 1 unread that could
// not be cleared by any amount of clicking, because the message was unreachable.
//
// The same staleness is worse for the destructive paths. A thread-wide delete or move built from
// a stale list silently leaves the newest messages behind, which is the bug the bulk-delete
// comment in MessageList already describes having fixed once.
//
// So the cache renders; the server decides what to act on. `allowCache` has to be asked for
// explicitly, and nothing currently asks, which is the point: a future caller has to think about
// staleness rather than inherit it by default.

/**
 * @param message      the row the action was invoked on
 * @param isThreadRow  false for an ordinary message row, which is already the whole action
 * @param cached       previously fetched sub-messages, used only when allowCache is true
 * @param fetchThread  () => Promise<{ messages }> — authoritative fetch
 * @param allowCache   opt in to the snapshot; only safe when staleness cannot change the outcome
 * @param excludeDrafts  drop the thread's drafts and, unless the row is itself in Trash or Spam, its Trash
 *                     and Spam copies; for actions that would destroy or relocate them
 * @param folders      folder lists keyed by account id, to recognise Trash and Spam; names are the fallback
 */
export async function resolveThreadMessages({ message, isThreadRow, cached, fetchThread, allowCache = false, excludeDrafts = false, folders }) {
  if (!isThreadRow) return [message];
  if (allowCache && Array.isArray(cached) && cached.length > 0) return withoutDrafts(cached, excludeDrafts, message, folders);
  const data = await fetchThread();
  // An empty or malformed response must not silently reduce the action to nothing: fall back to
  // the row itself, which is the same conservative choice the previous implementation made.
  return data?.messages?.length ? withoutDrafts(data.messages, excludeDrafts, message, folders) : [message];
}

// The ids a drag of a thread row onto a folder moves: what the server says the thread holds, less its
// drafts and its Trash and Spam copies (as for any move), and only the dragged row's account, since a
// folder path is account-specific and the server silently skips messages whose account lacks it.
export async function resolveThreadMoveIds({ row, fetchThread, folders }) {
  const messages = await resolveThreadMessages({ message: row, isThreadRow: true, fetchThread, excludeDrafts: true, folders });
  const ids = [...new Set(messages.filter(m => m?.account_id === row.account_id).map(m => m.id).filter(Boolean))];
  return ids.length ? ids : [row.id];
}

// Deleting a thread expunges its drafts outright — the bulk-delete route permanently deletes
// anything in a Drafts folder instead of moving it to Trash — and moving or archiving a thread
// drags the draft out of Drafts, where it stops being editable as a draft. Neither is what the
// user asked for when they acted on the conversation around it.
//
// A thread that is nothing BUT drafts keeps them: there the drafts are the user's explicit
// target, not collateral. The same holds for a single draft row, which never reaches this
// function because it is not a thread row.
//
// Trash and Spam copies are left alone the same way. The thread route returns a conversation from
// every folder, so deleting one from the Inbox also took its copies already in Trash, where a
// delete expunges for good, and moving it pulled them back out. Acting from Trash or Spam itself
// still takes the whole conversation.
function withoutDrafts(messages, excludeDrafts, anchor, folders) {
  if (!excludeDrafts) return messages;
  const inList = messages.find(msg => msg?.id === anchor?.id);
  const anchorIsDraft = anchor?.is_draft === true || inList?.is_draft === true;
  const anchorBinned = isBinned(inList || anchor, folders);
  const kept = messages.filter(msg => (msg?.is_draft === true) === anchorIsDraft
    && (anchorBinned || !isBinned(msg, folders)));
  return kept.length ? kept : messages;
}

function isBinned(message, folders) {
  if (!message?.folder) return false;
  return isTrashOrJunkFolder(message.folder, folders?.[message.account_id]);
}
