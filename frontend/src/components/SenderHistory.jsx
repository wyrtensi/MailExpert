import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import {
  SENDER_HISTORY_LIMIT,
  hasSenderHistory,
  moreCount,
  senderSearchQuery,
} from '../utils/senderHistory.js';
import { formatDay } from '../utils/formatDate.js';
import DirectionBadge from './DirectionBadge.jsx';

const rowButtonStyle = {
  display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left',
  background: 'transparent', border: 'none', borderRadius: 6, padding: '6px 8px', cursor: 'pointer',
  color: 'var(--text-primary)', fontSize: 12,
};

// "Before this letter" under the header of an open letter: the mailbox's earlier letters from
// the same person and its letters to them, each marked with its direction. Collapsed by default;
// renders nothing when there is no earlier correspondence.
export default function SenderHistory({ messageId, onOpen, onSearch }) {
  const { t } = useTranslation();
  const [history, setHistory] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    setHistory(null);
    setOpen(false);
    if (!messageId) return undefined;
    api.getSenderHistory(messageId, SENDER_HISTORY_LIMIT)
      .then((data) => { if (live) setHistory(data); })
      .catch(() => { if (live) setHistory(null); });
    return () => { live = false; };
  }, [messageId]);

  if (!hasSenderHistory(history)) return null;
  const more = moreCount(history);

  return (
    <div className="reading-card" style={{ marginBottom: 16, border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{ ...rowButtonStyle, padding: '8px 10px', color: 'var(--text-secondary)', alignItems: 'center' }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t('message.senderHistory.summary', { count: history.total, email: history.correspondent })}
        </span>
      </button>
      {open && (
        <div style={{ padding: '0 4px 6px' }}>
          {history.items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onOpen(item.id)}
              style={rowButtonStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <DirectionBadge direction={item.direction} />
              <span style={{ flexShrink: 0, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                {formatDay(item.date)}
              </span>
              <span style={{ flexShrink: 0, maxWidth: '45%', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.subject || t('message.senderHistory.noSubject')}
              </span>
              <span style={{ flex: 1, minWidth: 0, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.snippet || ''}
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => onSearch(senderSearchQuery(history.correspondent))}
            style={{ ...rowButtonStyle, color: 'var(--accent)' }}
          >
            {more > 0
              ? t('message.senderHistory.more', { count: more })
              : t('message.senderHistory.allFrom')}
          </button>
        </div>
      )}
    </div>
  );
}
