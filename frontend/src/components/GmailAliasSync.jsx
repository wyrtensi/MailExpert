import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { formatDateTime } from '../utils/formatDate.js';

// The "send mail as" sync of a Google mailbox in its alias settings: a button that reads the
// aliases from Gmail now, what the last run changed, and when the mailbox was last synced. Gmail is
// the source of truth, so the result replaces the mailbox's alias list (onSynced).
export default function GmailAliasSync({ account, onSynced }) {
  const { t } = useTranslation();
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState(null);
  const [errorKey, setErrorKey] = useState('');

  const handleSync = async () => {
    setSyncing(true);
    setResult(null);
    setErrorKey('');
    try {
      const res = await api.syncGmailAliases(account.id);
      setResult({ added: res.added?.length ?? 0, updated: res.updated?.length ?? 0, removed: res.removed?.length ?? 0 });
      onSynced({ aliases: res.aliases ?? [], gmail_send_as_synced_at: res.synced_at ?? null });
    } catch (err) {
      // The server's own text is never shown: a lost Google sign-in asks to reconnect, anything
      // else reads as one generic failure.
      setErrorKey(err?.code === 'reconnect_required' ? 'admin.accounts.oauthReconnectRequired' : 'admin.aliases.syncError');
    } finally {
      setSyncing(false);
    }
  };

  const syncedAt = account.gmail_send_as_synced_at ? formatDateTime(account.gmail_send_as_synced_at) : '';

  return (
    <div style={{ marginBottom: 16 }}>
      <button type="button" onClick={handleSync} disabled={syncing} style={{
        padding: '7px 12px', background: 'var(--bg-tertiary)',
        border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-primary)',
        cursor: syncing ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 500,
        opacity: syncing ? 0.7 : 1,
      }}>
        {syncing ? t('admin.aliases.syncing') : t('admin.aliases.syncGmail')}
      </button>
      <div role="status" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
        {result && (
          <div style={{ color: 'var(--text-secondary)' }}>{t('admin.aliases.syncResult', result)}</div>
        )}
        {errorKey && (
          <div style={{ color: 'var(--red)' }}>{t(errorKey)}</div>
        )}
      </div>
      {syncedAt && (
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
          {t('admin.aliases.syncedAt', { date: syncedAt })}
        </div>
      )}
    </div>
  );
}
