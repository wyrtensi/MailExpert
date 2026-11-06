// "Display aliases as accounts" in the sidebar: the switch under All inboxes and the alias rows
// after the mailboxes. An alias row looks like a mailbox row (colour dot, name, address, unread
// count); the open one shows its Inbox and, once the owner's Sent folder is known, its Sent. No
// context menu and no pinning: an alias is a view of its mailbox, not a mailbox.
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { unreadBadge } from '../utils/unreadBadge.js';
import { collapsedTooltip } from '../utils/sidebar.js';
import { aliasMailboxRows, aliasSentFolder } from '../utils/aliasMailboxes.js';

const INBOX_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
    <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>
  </svg>
);
const SENT_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <line x1="22" y1="2" x2="11" y2="13"/>
    <polygon points="22 2 15 22 11 13 2 9 22 2"/>
  </svg>
);
const ALIAS_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <circle cx="12" cy="12" r="4"/>
    <path d="M16 8v5a3 3 0 006 0v-1a10 10 0 10-3.92 7.94"/>
  </svg>
);

const hoverOn = (active) => (e) => { if (!active) e.currentTarget.style.background = 'var(--bg-tertiary)'; };
const hoverOff = (active) => (e) => { if (!active) e.currentTarget.style.background = 'transparent'; };

// Shown while some mailbox has an alias row, or while the mode is on (so it can be turned off).
// The caller leaves it out of the collapsed sidebar.
export function AliasesAsAccountsSwitch() {
  const { t } = useTranslation();
  const accounts = useStore(s => s.accounts);
  const enabled = useStore(s => s.aliasesAsAccounts);
  const setEnabled = useStore(s => s.setAliasesAsAccounts);
  if (!enabled && aliasMailboxRows(accounts).length === 0) return null;
  const label = t('sidebar.aliases.toggle');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'default' }}>
      <span style={{ color: 'var(--text-secondary)', display: 'flex', flexShrink: 0 }}>{ALIAS_ICON}</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text-secondary)' }}>{label}</span>
      <button
        onClick={() => setEnabled(!enabled)}
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        title={label}
        style={{
          width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer',
          background: enabled ? 'var(--accent)' : 'var(--bg-tertiary)',
          position: 'relative', transition: 'background 0.2s', flexShrink: 0, padding: 0,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <span style={{
          position: 'absolute', top: 2, width: 16, height: 16, borderRadius: '50%',
          background: 'white', transition: 'left 0.2s',
          left: enabled ? 18 : 2,
        }} />
      </button>
    </div>
  );
}

// `rows` from aliasMailboxRows (already filtered by the caller); `collapsed` is the sidebar's state.
export function AliasMailboxRows({ rows, collapsed }) {
  const { t } = useTranslation();
  const accounts = useStore(s => s.accounts);
  const folders = useStore(s => s.folders);
  const setFolders = useStore(s => s.setFolders);
  const selectedAccountId = useStore(s => s.selectedAccountId);
  const selectedAliasId = useStore(s => s.selectedAliasId);
  const selectedFolder = useStore(s => s.selectedFolder);
  const setSelectedAccount = useStore(s => s.setSelectedAccount);
  const aliasUnreadCounts = useStore(s => s.aliasUnreadCounts);

  return rows.map((row) => {
    const selected = selectedAccountId === row.accountId && selectedAliasId === row.aliasId;
    const badge = unreadBadge({ t, count: aliasUnreadCounts[row.aliasId], max: 999 });
    // Collapsed there is nothing under the row, so the row itself is the open view.
    const rowActive = collapsed && selected;
    const label = collapsedTooltip(`${row.name} — ${row.email}`, collapsed);
    const sentPath = selected
      ? aliasSentFolder(accounts.find(a => a.id === row.accountId), folders[row.accountId])
      : null;

    const openInbox = () => {
      setSelectedAccount(row.accountId, 'INBOX', row.aliasId);
      // The alias's Sent is the owner's Sent folder, so the owner's folder list is needed.
      if (!folders[row.accountId]) {
        api.getFolders(row.accountId).then(f => setFolders(row.accountId, f)).catch(console.error);
      }
    };

    const subRow = (kind, icon, text, active, onClick, count) => (
      <div
        data-nav-row={`alias-folder:${row.key}:${kind}`}
        aria-current={active ? 'true' : undefined}
        onClick={onClick}
        onMouseEnter={hoverOn(active)}
        onMouseLeave={hoverOff(active)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 10px 6px 26px', borderRadius: 7, margin: '1px 0', cursor: 'pointer',
          background: active ? 'var(--bg-hover)' : 'transparent', transition: 'background 0.1s',
        }}
      >
        <span style={{ color: 'var(--text-tertiary)', flexShrink: 0, display: 'flex' }}>{icon}</span>
        <span style={{
          fontSize: 12, color: 'var(--text-secondary)',
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {text}
        </span>
        {count && (
          <span title={count.title} style={{ fontSize: 10, color: 'var(--text-tertiary)', background: 'var(--bg-elevated)', padding: '1px 5px', borderRadius: 8, flexShrink: 0 }}>
            {count.text}
          </span>
        )}
      </div>
    );

    return (
      <div key={row.key}>
        <div
          data-nav-row={`alias:${row.key}`}
          role={collapsed ? 'button' : undefined}
          title={label}
          aria-label={label}
          aria-current={rowActive ? 'true' : undefined}
          onClick={openInbox}
          onMouseEnter={hoverOn(rowActive)}
          onMouseLeave={hoverOff(rowActive)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: collapsed ? '8px' : '7px 10px',
            borderRadius: 7, cursor: 'pointer', margin: '1px 0',
            background: rowActive ? 'var(--bg-hover)' : 'transparent', transition: 'background 0.1s',
            justifyContent: collapsed ? 'center' : 'flex-start',
          }}
        >
          {collapsed ? (
            <div style={{
              width: 28, height: 28, borderRadius: 7,
              background: row.color + '22', border: `1px solid ${row.color}66`,
              flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 600, color: row.color, userSelect: 'none',
            }}>
              {(row.name || row.email || '?').charAt(0).toUpperCase()}
            </div>
          ) : (
            <>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: row.color, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 13, color: 'var(--text-primary)', fontWeight: badge ? 500 : 400,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {row.name}
                </div>
                <div style={{
                  fontSize: 11, color: 'var(--text-tertiary)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {row.email}
                </div>
              </div>
              {badge && (
                <span title={badge.title} style={{
                  fontSize: 11, fontWeight: 600, color: 'white', flexShrink: 0,
                  background: row.color, padding: '1px 6px',
                  borderRadius: 10, minWidth: 20, textAlign: 'center',
                }}>
                  {badge.text}
                </span>
              )}
            </>
          )}
        </div>
        {selected && !collapsed && (
          <>
            {subRow('inbox', INBOX_ICON, t('sidebar.aliases.inbox'), selectedFolder === 'INBOX', openInbox, badge)}
            {sentPath && subRow('sent', SENT_ICON, t('sidebar.aliases.sent'), selectedFolder === sentPath,
              () => setSelectedAccount(row.accountId, sentPath, row.aliasId), null)}
          </>
        )}
      </div>
    );
  });
}
