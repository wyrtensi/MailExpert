import { useTranslation } from 'react-i18next';

// Says, in words, whether a letter was sent from one of our mailboxes, received into one, or is
// still an unsent draft — used everywhere a list shows letters (message list rows, the
// sender-history block under an open letter, a contact's correspondence) so direction is never
// left to color or icon alone. `direction` is 'in' | 'out' | 'draft'; 'in'/'out' come from
// utils/mailboxBanner.js's mailboxBanner() (or the equivalent SQL rule in contactLetters.js —
// same precedence), 'draft' from a message sitting in its mailbox's Drafts folder. This
// component only renders the value, it does not decide it. Any other value (including
// undefined, e.g. no account loaded yet to compute it from) renders nothing rather than
// guessing. `compact` drops the text and keeps only the arrow/icon, for narrow rows (mobile, or
// a narrow message list column) — the label still reaches screen readers and mouse users via
// aria-label/title.
const KIND = {
  in: { labelKey: 'message.direction.received', color: 'var(--green, #22c55e)', mix: 'var(--green, #22c55e)' },
  out: { labelKey: 'message.direction.sent', color: 'var(--accent)', mix: 'var(--accent)' },
  draft: { labelKey: 'message.direction.draft', color: 'var(--text-tertiary)', mix: 'var(--text-tertiary)' },
};

export default function DirectionBadge({ direction, compact = false }) {
  const { t } = useTranslation();
  const kind = KIND[direction];
  if (!kind) return null;
  const label = t(kind.labelKey);

  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0,
        fontSize: 10, fontWeight: 600, lineHeight: 1, whiteSpace: 'nowrap',
        padding: compact ? 2 : '2px 6px',
        borderRadius: 10, color: kind.color,
        background: `color-mix(in srgb, ${kind.mix} 15%, transparent)`,
      }}
    >
      {direction === 'draft' ? (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      ) : (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
          {direction === 'out'
            ? <><line x1="5" y1="19" x2="19" y2="5" /><polyline points="8 5 19 5 19 16" /></>
            : <><line x1="19" y1="5" x2="5" y2="19" /><polyline points="5 8 5 19 16 19" /></>}
        </svg>
      )}
      {!compact && <span>{label}</span>}
    </span>
  );
}
