import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import DirectionBadge from './DirectionBadge.jsx';
import { formatDay, formatDate } from '../utils/formatDate.js';

const PAGE_SIZE = 20;

// A contact's correspondence across every mailbox (GET /api/contacts/:id/letters), computed
// from cached messages. The received/sent counts and the last-contact date show as soon as
// there is any correspondence; the letters themselves sit behind "Show letters" and page in
// 20 at a time, newest first. Renders nothing for a contact with no correspondence at all.
export default function ContactLetters({ contactId, onOpenLetter, t }) {
  const accounts = useStore((state) => state.accounts);
  const [summary, setSummary] = useState(null);
  const [items, setItems] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setSummary(null);
    setItems([]);
    setExpanded(false);
    setFailed(false);
    if (!contactId) return undefined;
    api.getContactLetters(contactId, { limit: PAGE_SIZE, offset: 0 })
      .then((data) => {
        if (!live) return;
        setSummary(data);
        setItems(data.items || []);
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [contactId]);

  const loadMore = useCallback(() => {
    setLoadingMore(true);
    api.getContactLetters(contactId, { limit: PAGE_SIZE, offset: items.length })
      .then((data) => setItems((prev) => [...prev, ...(data.items || [])]))
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [contactId, items.length]);

  if (failed || !summary || summary.total === 0) return null;

  return (
    <div style={{
      background: 'var(--bg-secondary)', borderRadius: 10,
      border: '1px solid var(--border-subtle)', overflow: 'hidden', marginBottom: 16,
    }}>
      <SummaryRow label={t('contacts.letters.received')}>{summary.received}</SummaryRow>
      <SummaryRow label={t('contacts.letters.sent')}>{summary.sent}</SummaryRow>
      {summary.lastDate && (
        <SummaryRow label={t('contacts.fields.lastContacted')}>{formatDate(summary.lastDate)}</SummaryRow>
      )}

      <div style={{ padding: '10px 16px', borderTop: expanded ? '1px solid var(--border-subtle)' : 'none' }}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--accent)', fontSize: 12, fontWeight: 500,
          }}
        >
          {expanded ? t('contacts.letters.hide') : t('contacts.letters.show')}
        </button>
      </div>

      {expanded && (
        <div>
          {items.map((item) => (
            <LetterRow
              key={`${item.account_id}:${item.id}`}
              item={item}
              account={accounts.find((a) => a.id === item.account_id)}
              onOpen={() => onOpenLetter(item)}
              t={t}
            />
          ))}
          {items.length < summary.total && (
            <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border-subtle)' }}>
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                style={{
                  background: 'none', border: 'none', padding: 0,
                  cursor: loadingMore ? 'default' : 'pointer',
                  color: 'var(--accent)', fontSize: 12, fontWeight: 500,
                  opacity: loadingMore ? 0.6 : 1,
                }}
              >
                {loadingMore ? t('common.loading') : t('contacts.letters.showMore')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryRow({ label, children }) {
  return (
    <div style={{
      display: 'flex', gap: 16, padding: '10px 16px',
      borderBottom: '1px solid var(--border-subtle)', fontSize: 13,
    }}>
      <div style={{ width: 110, flexShrink: 0, color: 'var(--text-tertiary)' }}>{label}</div>
      <div style={{ flex: 1, color: 'var(--text-primary)' }}>{children}</div>
    </div>
  );
}

function LetterRow({ item, account, onOpen, t }) {
  const label = account?.name || account?.email_address || item.account_id;
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
        background: 'transparent', border: 'none', borderBottom: '1px solid var(--border-subtle)',
        padding: '8px 16px', cursor: 'pointer', color: 'var(--text-primary)', fontSize: 12,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <DirectionBadge direction={item.direction} />
      <span style={{ flexShrink: 0, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
        {formatDay(item.date)}
      </span>
      <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '26%', overflow: 'hidden' }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: account?.color || 'var(--text-tertiary)' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      </span>
      <span style={{ flexShrink: 0, maxWidth: '30%', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.subject || t('message.noSubject')}
      </span>
      <span style={{ flex: 1, minWidth: 0, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.snippet || ''}
      </span>
    </button>
  );
}
