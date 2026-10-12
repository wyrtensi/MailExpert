import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.js';

// The permanent mobile entry point to the add-account dialog: one 44 x 44 icon button that sits in
// each mobile header (mailbox list, reading pane, contacts), so it is reachable without opening
// the sidebar menu. It only calls store.openAddAccount; nothing else changes.
export default function AddAccountButton() {
  const { t } = useTranslation();
  const openAddAccount = useStore((s) => s.openAddAccount);
  return (
    <button
      type="button"
      data-add-account-trigger
      onClick={openAddAccount}
      aria-label={t('sidebar.addAccount')}
      title={t('sidebar.addAccount')}
      style={{
        background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer',
        padding: 0, borderRadius: 7, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 44,
      }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
        <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <line x1="19" y1="8" x2="19" y2="14" /><line x1="16" y1="11" x2="22" y2="11" />
      </svg>
    </button>
  );
}
