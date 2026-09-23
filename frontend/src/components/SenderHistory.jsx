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
import { useMobile } from '../hooks/useMobile.js';

const rowButtonStyle = {
  display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left',
  background: 'transparent', border: 'none', borderRadius: 6, padding: '7px 8px', cursor: 'pointer',
  color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit',
};

// "Before this letter" under the header of an open letter: the mailbox's earlier letters from
// the same person and its letters to them, each marked with its direction. Open by default so it
// is seen; renders nothing when there is neither earlier correspondence nor a conversation of
// more than this letter. The "Whole conversation" box stacks every letter of the thread under the
// open letter (ConversationThread); the pane owns that state and resets it on every open.
export default function SenderHistory({ messageId, onOpen, onSearch, conversationCount = 0, showThread = false, onToggleThread }) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const [history, setHistory] = useState(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let live = true;
    setHistory(null);
    setOpen(true);
    if (!messageId) return undefined;
    api.getSenderHistory(messageId, SENDER_HISTORY_LIMIT)
      .then((data) => { if (live) setHistory(data); })
      .catch(() => { if (live) setHistory(null); });
    return () => { live = false; };
  }, [messageId]);

  const hasHistory = hasSenderHistory(history);
  const canShowThread = conversationCount > 1 && typeof onToggleThread === 'function';
  if (!hasHistory && !canShowThread) return null;
  const more = hasHistory ? moreCount(history) : 0;

  return (
    <div className="reading-card" style={{
      marginBottom: 16, border: '1px solid var(--border)', borderLeft: '3px solid var(--accent)',
      borderRadius: 10, background: 'color-mix(in srgb, var(--accent) 5%, var(--bg-primary, #fff))',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: hasHistory ? '4px 10px 4px 4px' : '8px 10px', flexWrap: 'wrap' }}>
        {hasHistory ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            style={{ ...rowButtonStyle, flex: '1 1 220px', width: 'auto', minWidth: 0, padding: '8px 8px', alignItems: 'center', fontSize: 14, fontWeight: 600 }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
              style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0, color: 'var(--accent)' }}>
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t('message.senderHistory.summary', { count: history.total, email: history.correspondent })}
            </span>
          </button>
        ) : null}
        {canShowThread && (
          <label
            title={t('message.senderHistory.showThreadHint')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', flexShrink: 0,
              fontSize: 13, fontWeight: 600, color: showThread ? 'var(--accent)' : 'var(--text-primary)',
              padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border)',
              background: showThread ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--bg-primary, #fff)',
            }}
          >
            <input
              type="checkbox"
              checked={showThread}
              onChange={(e) => onToggleThread(e.target.checked)}
              style={{ margin: 0, accentColor: 'var(--accent)', width: 15, height: 15, cursor: 'pointer' }}
            />
            {t('message.senderHistory.showThread')} ({conversationCount})
          </label>
        )}
      </div>
      {hasHistory && open && (
        <div style={{ padding: '0 6px 8px' }}>
          {history.items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onOpen(item.id)}
              style={rowButtonStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <DirectionBadge direction={item.direction} compact={isMobile} />
              <span style={{ flexShrink: 0, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                {formatDay(item.date)}
              </span>
              <span style={{ flexShrink: 0, maxWidth: '45%', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.subject || t('message.senderHistory.noSubject')}
              </span>
              <span style={{ flex: 1, minWidth: 0, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.snippet || ''}
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => onSearch(senderSearchQuery(history.correspondent))}
            style={{ ...rowButtonStyle, color: 'var(--accent)', fontWeight: 500 }}
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
