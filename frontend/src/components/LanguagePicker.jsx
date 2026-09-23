import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { LANGUAGES, suggestedLanguage } from '../utils/language.js';

// First entry: the interface language, asked once. Every language states the question in itself,
// since the reader's language is what is being asked. Choosing saves it (setLanguage: this
// browser, i18n and the account's preferences) and closes the picker.
export default function LanguagePicker({ onDone }) {
  const { t } = useTranslation();
  const setLanguage = useStore((s) => s.setLanguage);
  const [focus] = useState(() => suggestedLanguage(typeof navigator === 'undefined' ? [] : navigator.languages || [navigator.language]));

  const choose = (code) => {
    setLanguage(code);
    onDone();
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="language-picker-title" style={{
      position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(15,17,22,0.55)', padding: 16,
    }}>
      <div style={{
        width: '100%', maxWidth: 420, background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        borderRadius: 14, padding: '24px 22px', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
      }}>
        <div id="language-picker-title" style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.4 }}>
          {LANGUAGES.map(({ code }) => <div key={code} lang={code}>{t('languagePicker.title', { lng: code })}</div>)}
        </div>
        <div style={{ display: 'grid', gap: 10, marginTop: 18 }}>
          {LANGUAGES.map(({ code, nativeName }) => (
            <button
              key={code}
              type="button"
              lang={code}
              autoFocus={code === focus}
              onClick={() => choose(code)}
              style={{
                textAlign: 'left', padding: '14px 16px', borderRadius: 10, cursor: 'pointer', fontSize: 16, fontWeight: 500,
                background: code === focus ? 'var(--accent-dim)' : 'var(--bg-tertiary)',
                border: `2px solid ${code === focus ? 'var(--accent)' : 'var(--border-subtle)'}`,
                color: 'var(--text-primary)',
              }}
            >
              {nativeName}
              <div style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-secondary)', marginTop: 2 }}>
                {t('languagePicker.hint', { lng: code })}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
