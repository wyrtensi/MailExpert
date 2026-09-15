import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import LogoMark from './LogoMark.jsx';
import { SIGN_IN_PATH, signInErrorKey } from '../utils/authMode.js';

// Sign-in screen for AUTH_MODE=google. Through Cloudflare Access the user is already signed in
// and never sees it; on a host without Cloudflare it offers Google sign-in.
export default function GoogleLoginPage({ config }) {
  const { t } = useTranslation();
  const [errorKey] = useState(() => signInErrorKey(new URLSearchParams(window.location.search).get('auth_error')));

  return (
    <div style={{
      minHeight: 'var(--app-height, 100svh)', display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: 'var(--bg-primary)', padding: 24,
    }}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ marginBottom: 40, textAlign: 'center' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <LogoMark size={44} />
            <span style={{ display: 'flex', alignItems: 'baseline' }}>
              <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 30, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>Mail</span>
              <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 30, fontWeight: 600, color: 'var(--accent)', letterSpacing: '-0.03em' }}>Expert</span>
            </span>
          </div>
          <p style={{ color: 'var(--text-tertiary)', fontSize: 14, margin: 0 }}>{t('login.tagline')}</p>
        </div>

        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 16, padding: 32 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 500, color: 'var(--text-primary)' }}>
            {t('login.google.title')}
          </h2>
          <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-tertiary)' }}>
            {config?.googleSignIn ? t('login.google.desc') : t('login.google.cloudflareOnly')}
          </p>
          {errorKey && (
            <div style={{
              marginBottom: 16, padding: '10px 14px', background: 'rgba(248,113,113,0.1)',
              border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8, color: 'var(--red)', fontSize: 13,
            }}>{t(errorKey)}</div>
          )}
          {config?.googleSignIn && (
            <a
              href={SIGN_IN_PATH}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '11px 24px', background: 'var(--accent)', borderRadius: 8,
                color: 'var(--accent-text)', fontSize: 14, fontWeight: 500, textDecoration: 'none',
              }}
            >
              {t('login.google.button')}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
