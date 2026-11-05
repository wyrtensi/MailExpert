import { useTranslation } from 'react-i18next';

// The alias an incoming letter was addressed to, as a pill next to DirectionBadge in the message
// list: with several aliases on one mailbox the reader sees at once which address a client wrote
// to, and it is the address "Reply" will send from (utils/mailboxBanner.js's recipientAliasFor
// decides it; this component only renders it). `compact` keeps only the local part, for narrow
// rows (mobile, a narrow list column); the full address is always in title and aria-label.
export default function RecipientAliasBadge({ address, compact = false }) {
  const { t } = useTranslation();
  if (!address) return null;
  const text = compact ? address.split('@')[0] : t('message.recipientAlias', { address });

  return (
    <span
      role="img"
      title={address}
      aria-label={address}
      style={{
        display: 'inline-block', flexShrink: 1, minWidth: 0, maxWidth: compact ? 80 : 180,
        overflow: 'hidden', textOverflow: 'ellipsis',
        fontSize: 10, fontWeight: 600, lineHeight: 1, whiteSpace: 'nowrap',
        padding: '2px 6px', borderRadius: 10, color: 'var(--text-secondary)',
        background: 'color-mix(in srgb, var(--text-tertiary) 15%, transparent)',
      }}
    >
      {text}
    </span>
  );
}
