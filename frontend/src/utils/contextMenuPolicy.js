// deleteEnabled: false while the panel has deleting letters turned off (utils/deletePolicy.js).
export function getContextMenuPolicy(variant = 'inbox', { deleteEnabled = true } = {}) {
  const gtdSidebar = variant === 'gtdSidebar';
  return {
    select: !gtdSidebar,
    compose: true,
    archive: !gtdSidebar,
    snooze: !gtdSidebar,
    categorize: !gtdSidebar,
    done: gtdSidebar,
    rules: true,
    spam: !gtdSidebar,
    copy: true,
    viewHeaders: true,
    delete: deleteEnabled !== false,
  };
}

export function resolveContextMenuMessage(message, variant, resolveMessage) {
  if (variant !== 'gtdSidebar') return Promise.resolve(message);
  return resolveMessage(message.message_id || message.id, message.account_id);
}
