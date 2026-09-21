import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { openOAuthWindow } from '../utils/oauthWindow.js';
import { createLatestRequest } from '../utils/latestRequest.js';
import {
  GOOGLE_LAUNCH_TTL_MS,
  KNOWN_EMAILS_DEBOUNCE_MS,
  SUGGESTION_BADGE_KEYS,
  buildEmailSuggestions,
  canStartGmail,
  exactMailboxMatch,
  gmailStartErrorKey,
  moveSuggestionHighlight,
  pickHighlightedSuggestion,
  shouldFetchKnownEmails,
  suggestionAction,
} from '../utils/addAccount.js';

const inputStyle = {
  width: '100%', padding: '9px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
};
const LIST_ID = 'gmail-add-suggestions';

// "Add account -> Gmail": the user types the address, MailExpert picks the Google app. The start
// answer is a one-time path; the address itself never goes into a MailExpert URL. The callback
// reports back to this window (App.jsx forwards it), and MailApp announces the result.
export default function GmailAddForm({ accounts, onDone }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [known, setKnown] = useState([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState(null);
  const [launchPath, setLaunchPath] = useState(null);
  const knownRequest = useRef(createLatestRequest());

  // Addresses connected before, from the grant journal: from two characters, debounced.
  useEffect(() => {
    const q = email.trim();
    if (!shouldFetchKnownEmails(q)) {
      knownRequest.current.invalidate();
      setKnown([]);
      return undefined;
    }
    const timer = setTimeout(() => {
      knownRequest.current.run(
        () => api.knownGoogleEmails(q).then((data) => data?.emails ?? []).catch(() => []),
        setKnown,
      );
    }, KNOWN_EMAILS_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [email]);

  useEffect(() => {
    const handleMessage = (e) => {
      if (e.origin !== window.location.origin || e.data?.provider !== 'google') return;
      if (e.data?.type === 'oauth_success') {
        setLaunchPath(null);
        onDone();
      } else if (e.data?.type === 'oauth_error') {
        setLaunchPath(null);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onDone]);

  // The fallback link lives as long as the launch key behind it.
  useEffect(() => {
    if (!launchPath) return undefined;
    const timer = setTimeout(() => setLaunchPath(null), GOOGLE_LAUNCH_TTL_MS);
    return () => clearTimeout(timer);
  }, [launchPath]);

  const rows = useMemo(() => buildEmailSuggestions({ query: email, accounts, knownEmails: known }), [email, accounts, known]);
  const exact = useMemo(() => exactMailboxMatch(email, accounts), [email, accounts]);
  const canStart = !busy && canStartGmail(email, accounts);
  const listOpen = open && rows.length > 0;

  const closeList = () => { setOpen(false); setHighlight(-1); };

  const choose = (row) => {
    const action = suggestionAction(row);
    if (!action) return;
    if (action.type === 'fill') {
      setEmail(action.email);
      setErrorKey(null);
      closeList();
    } else {
      openOAuthWindow(action.url);
    }
  };

  const start = async () => {
    if (!canStart) return;
    setBusy(true);
    setErrorKey(null);
    setLaunchPath(null);
    try {
      const { path } = await api.startGoogleOAuth(email.trim());
      // The tab is opened after an await, so a popup blocker may stop it and the page cannot
      // tell: the link below is always offered while the path is valid.
      setLaunchPath(path);
      openOAuthWindow(path);
    } catch (err) {
      setErrorKey(gmailStartErrorKey(err?.code));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      if (listOpen) { e.preventDefault(); closeList(); }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setHighlight((i) => moveSuggestionHighlight(i, e.key, rows.length));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = pickHighlightedSuggestion(rows, highlight, listOpen);
      if (row) choose(row);
      else start();
    }
  };

  const badge = (row) => (
    <span style={{ fontSize: 11, color: row.kind === 'known' ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}>
      {t(SUGGESTION_BADGE_KEYS[row.kind])}
    </span>
  );
  const reconnectButton = (row) => (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => openOAuthWindow(row.reconnectUrl)}
      style={{ padding: '3px 8px', fontSize: 11, borderRadius: 6, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', cursor: 'pointer' }}
    >
      {t('admin.accounts.add.reconnect')}
    </button>
  );

  return (
    <div>
      <label htmlFor="gmail-add-email" style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>
        {t('admin.accounts.add.emailLabel')}
      </label>
      <div style={{ position: 'relative' }}>
        <input
          id="gmail-add-email"
          type="email"
          autoComplete="off"
          role="combobox"
          aria-expanded={listOpen}
          aria-controls={LIST_ID}
          aria-activedescendant={listOpen && highlight >= 0 ? `${LIST_ID}-${highlight}` : undefined}
          value={email}
          placeholder={t('admin.accounts.add.emailPh')}
          onChange={(e) => { setEmail(e.target.value); setOpen(true); setHighlight(-1); setErrorKey(null); }}
          onFocus={() => setOpen(true)}
          onBlur={closeList}
          onKeyDown={onKeyDown}
          style={inputStyle}
        />
        {listOpen && (
          <ul id={LIST_ID} role="listbox" style={{
            position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 5, margin: '4px 0 0', padding: 4, listStyle: 'none',
            background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8,
          }}>
            {rows.map((row, i) => (
              <li
                key={row.email}
                id={`${LIST_ID}-${i}`}
                role="option"
                aria-selected={i === highlight}
                aria-disabled={!suggestionAction(row)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => row.kind === 'known' && choose(row)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6,
                  background: i === highlight ? 'var(--bg-hover)' : 'transparent',
                  cursor: row.kind === 'known' ? 'pointer' : 'default',
                }}
              >
                <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.email}</span>
                {badge(row)}
                {row.kind === 'reconnect' && reconnectButton(row)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {exact && !listOpen && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          {badge(exact)}
          {exact.kind === 'reconnect' && reconnectButton(exact)}
        </div>
      )}
      {errorKey && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{t(errorKey)}</div>}

      <button
        type="button"
        onClick={start}
        disabled={!canStart}
        style={{
          marginTop: 14, padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500, border: 'none',
          background: canStart ? 'var(--accent)' : 'var(--bg-elevated)', color: canStart ? 'var(--accent-text)' : 'var(--text-tertiary)',
          cursor: canStart ? 'pointer' : 'not-allowed',
        }}
      >
        {busy ? t('admin.accounts.add.starting') : t('admin.accounts.add.continue')}
      </button>

      {launchPath && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 12 }}>
          {t('admin.accounts.add.openGoogleNote')}{' '}
          <a href={launchPath} target="_blank" rel="opener" onClick={() => setLaunchPath(null)}>
            {t('admin.accounts.add.openGoogle')}
          </a>
        </div>
      )}
    </div>
  );
}
