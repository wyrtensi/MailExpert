// The reading pane's toolbar: how many buttons carry their name next to the icon. Pure function,
// so it runs under `node --test`.

// Widths (px of the toolbar) from which the everyday actions, then every button, show a name.
export const PRIMARY_LABELS_FROM = 520;
export const ALL_LABELS_FROM = 900;

// 'all', 'primary' (reply, forward, archive, move, delete) or 'none'. A phone keeps icons: its
// toolbar is narrow and the rest sits in the More menu.
export function toolbarLabelTier(width, isMobile) {
  if (isMobile || !width) return 'none';
  if (width >= ALL_LABELS_FROM) return 'all';
  return width >= PRIMARY_LABELS_FROM ? 'primary' : 'none';
}
