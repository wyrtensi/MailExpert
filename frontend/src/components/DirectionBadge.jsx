import { useTranslation } from 'react-i18next';

// Says, in words, whether a letter was sent from one of our mailboxes or received into one —
// used everywhere a list shows letters (message list rows, the sender-history block under an
// open letter, a contact's correspondence) so direction is never left to color or icon alone.
// `direction` is 'in' | 'out', as computed by utils/mailboxBanner.js's mailboxBanner(); this
// component renders it, it does not decide it. `compact` drops the text and keeps only the
// arrow, for narrow rows (mobile, or a narrow message list column) — the label still reaches
// screen readers and mouse users via aria-label/title.
export default function DirectionBadge({ direction, compact = false }) {
  const { t } = useTranslation();
  const sent = direction === 'out';
  const label = t(sent ? 'message.direction.sent' : 'message.direction.received');
  const color = sent ? 'var(--accent)' : 'var(--green, #22c55e)';
  const background = sent ? 'var(--accent-dim, rgba(124,106,247,0.12))' : 'rgba(34,197,94,0.12)';

  return (
    <span
      title={label}
      aria-label={label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0,
        fontSize: 10, fontWeight: 600, lineHeight: 1, whiteSpace: 'nowrap',
        padding: compact ? 2 : '2px 6px',
        borderRadius: 10, color, background,
      }}
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
        {sent
          ? <><line x1="5" y1="19" x2="19" y2="5" /><polyline points="8 5 19 5 19 16" /></>
          : <><line x1="19" y1="5" x2="5" y2="19" /><polyline points="5 8 5 19 16 19" /></>}
      </svg>
      {!compact && <span>{label}</span>}
    </span>
  );
}
