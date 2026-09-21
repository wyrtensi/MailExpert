import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { buildGoogleConnectUrl } from '../utils/googleOAuth.js';
import { openOAuthWindow } from '../utils/oauthWindow.js';

const noteBoxStyle = {
  padding: '12px 14px', borderRadius: 8, marginBottom: 12, background: 'rgba(124,106,247,0.06)',
  border: '1px solid rgba(124,106,247,0.15)', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6,
};

// Temporary "Connect Gmail" card for every user. It starts the legacy `GET /oauth/google` flow
// (the backend creates or updates the mailbox of the Google account the user picks). PR 8c
// removes it together with that flow, when the "Add account" dialog takes over. The callback
// result is announced by MailApp.
export default function GmailConnectCard() {
  const { t } = useTranslation();
  const [status, setStatus] = useState(null); // { configured, available }
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    api.getIntegrationsStatus()
      .then((data) => setStatus(data?.google || { configured: false, available: false }))
      .catch(() => setStatus({ configured: false, available: false }));
    const handleMessage = (e) => {
      if (e.origin !== window.location.origin) return;
      if ((e.data?.type === 'oauth_success' || e.data?.type === 'oauth_error') && e.data?.provider === 'google') {
        setConnecting(false);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const available = status?.available === true;
  let noteKey = 'admin.integrations.google.userNoteConfigured';
  if (status && !status.configured) noteKey = 'admin.integrations.google.userNoteNotConfigured';
  else if (status && !available) noteKey = 'admin.integrations.google.errorNoAppCapacity';

  const connect = () => {
    if (!available) return;
    setConnecting(true);
    openOAuthWindow(buildGoogleConnectUrl());
    setTimeout(() => setConnecting(false), 5000);
  };

  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
        {t('admin.integrations.google.title')}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 1, marginBottom: 12 }}>
        {t('admin.integrations.google.description')}
      </div>
      {status && <div style={noteBoxStyle}>{t(noteKey)}</div>}
      <button
        type="button"
        onClick={connect}
        disabled={!available || connecting}
        style={{
          padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
          background: available ? 'var(--accent)' : 'var(--bg-elevated)',
          border: `1px solid ${available ? 'var(--accent)' : 'var(--border)'}`,
          color: available ? 'white' : 'var(--text-tertiary)',
          cursor: available && !connecting ? 'pointer' : 'not-allowed',
          opacity: !available || connecting ? 0.6 : 1,
        }}
      >
        {connecting ? t('admin.integrations.google.redirecting') : t('admin.integrations.google.connect')}
      </button>
    </div>
  );
}
