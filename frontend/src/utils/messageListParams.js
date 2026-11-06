// Query for GET /api/mail/messages, one rule for every place the list is read (first page, next
// page, refresh, page jump). A mailbox view sends accountId and folder; the unified inbox neither.
// The category tab applies to a mailbox Inbox only, and never to an alias view, which lists every
// category. aliasId is left out entirely when no alias is open: the server rejects an empty one.
export function messageListParams({
  selectedAccountId, selectedFolder, selectedAliasId, unreadOnly, threaded, categoryActive, activeCategory, limit, offset,
}) {
  const params = { limit, offset };
  if (selectedAccountId) {
    params.accountId = selectedAccountId;
    params.folder = selectedFolder;
    if (selectedAliasId) params.aliasId = selectedAliasId;
  }
  if (unreadOnly) params.unreadOnly = 'true';
  if (threaded) params.threaded = 'true';
  if (selectedFolder === 'INBOX' && categoryActive && !params.aliasId) params.category = activeCategory;
  return params;
}
