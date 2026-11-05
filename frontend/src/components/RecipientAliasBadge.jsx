import { useTranslation } from 'react-i18next';

// The alias an incoming letter was addressed to, as a pill next to DirectionBadge in the message
// list: with several aliases on one mailbox the reader sees at once which address a client wrote
// to (utils/mailboxBanner.js's recipientAliasFor decides it; this component only renders it).
// `active` (amber): a current alias, the address "Reply" will send from. Not active (gray): an
// address on the mailbox's domain that is not a current alias (removed in Gmail, or a neighbour
// mailbox); the reply goes from the mailbox's main address, and title/aria-label say so.
// `compact` keeps only the local part, for narrow rows (mobile, a narrow list column).
export default function RecipientAliasBadge({ address, active = false, compact = false }) {
  const { t } = useTranslation();
  if (!address) return null;
  const text = compact ? address.split('@')[0] : t('message.recipientAlias', { address });
  const label = active ? address : t('message.recipientAliasInactive', { address });

  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      data-alias-state={active ? 'active' : 'inactive'}
      style={{
        display: 'inline-block', flexShrink: 1, minWidth: 0, maxWidth: compact ? 80 : 180,
        overflow: 'hidden', textOverflow: 'ellipsis',
        fontSize: 10, fontWeight: 600, lineHeight: 1, whiteSpace: 'nowrap',
        padding: '2px 6px', borderRadius: 10,
        color: active ? 'var(--amber)' : 'var(--text-secondary)',
        background: `color-mix(in srgb, ${active ? 'var(--amber)' : 'var(--text-tertiary)'} 15%, transparent)`,
      }}
    >
      {text}
    </span>
  );
}
