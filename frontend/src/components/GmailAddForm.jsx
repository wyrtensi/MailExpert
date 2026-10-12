import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { openOAuthWindow } from '../utils/oauthWindow.js';
import { createLatestRequest } from '../utils/latestRequest.js';
import { isDemoMode } from '../demo/mode.js';
import {
  GOOGLE_LAUNCH_TTL_MS,
  GOOGLE_OAUTH_STATE_TTL_MS,
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
import { senderNamesPayload } from '../utils/mailNode.js';
import { isAttemptId, newAttemptId } from '../utils/addAccountFlow.js';
import { appOAuthReturnWatch } from '../utils/appOAuthReturn.js';
import AdvancedConnectionFields from './addAccount/AdvancedConnectionFields.jsx';

const LIST_ID = 'gmail-add-suggestions';

// "Add account -> Gmail": the user types the address, MailExpert picks the Google app. The start
// answer is a one-time path; the address itself never goes into a MailExpert URL. The callback
// reports back to this window (App.jsx forwards it), and MailApp announces the result.
// The demo has no Google: the consent step is a card in the form, and allowing it connects the
// address locally and posts the same success message the callback would.
//
// Props (all optional but `accounts`): `initialEmail` / `onEmailChange` keep the typed address in the
// dialog while the form is open; `signal` is aborted when the dialog leaves the form, after which
// nothing is reported; `onAttemptStart` runs when a start is sent; `onConnected({ kind: 'oauth',
// attemptId })` runs when the callback of THIS form's attempt reports success. Each start the user
// asks for mints its own attempt id (a failed start is retried with the same one); the callback
// hands it back, so the result of an older attempt never closes the form of a newer one. The
// MailApp listener refreshes the mailbox list for every result regardless.
export default function GmailAddForm({
  accounts, initialEmail = '', onEmailChange, signal, onAttemptStart, onConnected, demo = isDemoMode,
}) {
  const { t } = useTranslation();
  const [email, setEmailState] = useState(initialEmail);
  const setEmail = (value) => { setEmailState(value); onEmailChange?.(value); };
  const attemptRef = useRef(null);
  // A start that reached a Google tab hands its id over to the callback; the next start gets a new one.
  const attemptSentRef = useRef(false);
  // The attempt this form waits for (its id): the wait itself, with the launched address and the
  // OAuth state lifetime, lives in the app's return watch and outlives the form.
  const awaitingRef = useRef(null);
  const onConnectedRef = useRef(onConnected);
  useEffect(() => { onConnectedRef.current = onConnected; }, [onConnected]);
  const [known, setKnown] = useState([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState(null);
  const [launchPath, setLaunchPath] = useState(null);
  const [demoConsent, setDemoConsent] = useState(null);
  // Optional here: without them the mailbox sends under the Google profile name.
  const [senderName, setSenderName] = useState('');
  const [senderNameAlt, setSenderNameAlt] = useState('');
  const names = senderNamesPayload({ senderName, senderNameAlt });
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
      if (signal?.aborted) return;
      const mine = !!attemptRef.current && isAttemptId(e.data?.attempt) && e.data.attempt === attemptRef.current;
      if (e.data?.type === 'oauth_success') {
        if (!mine) return;
        appOAuthReturnWatch().forget(attemptRef.current);
        awaitingRef.current = null;
        setLaunchPath(null);
        onConnected?.({ kind: 'oauth', attemptId: attemptRef.current });
      } else if (e.data?.type === 'oauth_error') {
        if (mine) { appOAuthReturnWatch().forget(attemptRef.current); awaitingRef.current = null; setLaunchPath(null); }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onConnected, signal]);

  // Electron (and any browser that opens Google outside this window) never posts a result back:
  // the app's return watch (utils/oauthReturnWatch.js) reads the mailbox list on each return of
  // focus for as long as the server's OAuth state lives (10 minutes, not the 60 s launch link) and
  // finishes this form when the launched address is there. Leaving the form only releases it, so a
  // sign-in completed after the dialog was closed still refreshes the shared list.
  const signalRef = useRef(signal);
  useEffect(() => { signalRef.current = signal; }, [signal]);
  useEffect(() => () => {
    if (awaitingRef.current) appOAuthReturnWatch().release(awaitingRef.current);
  }, []);

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
    // Minted here, in the handler, never during render: a new user-initiated start gets a new id,
    // a start that failed before reaching Google is retried with the one it had.
    if (!attemptRef.current || attemptSentRef.current) {
      // The previous attempt may still finish in another window: it keeps refreshing the list,
      // but no longer finishes this form.
      if (awaitingRef.current) appOAuthReturnWatch().release(awaitingRef.current);
      attemptRef.current = newAttemptId();
      attemptSentRef.current = false;
      awaitingRef.current = null;
    }
    const attemptId = attemptRef.current;
    if (demo) {
      setErrorKey(null);
      setDemoConsent(email.trim());
      return;
    }
    setBusy(true);
    setErrorKey(null);
    setLaunchPath(null);
    onAttemptStart?.();
    try {
      const { path } = await api.startGoogleOAuth(email.trim(), names, attemptId, signal);
      if (signal?.aborted) return;
      attemptSentRef.current = true;
      awaitingRef.current = attemptId;
      appOAuthReturnWatch().watch({
        attemptId,
        email: email.trim(),
        until: Date.now() + GOOGLE_OAUTH_STATE_TTL_MS,
        onFound: () => {
          if (signalRef.current?.aborted || awaitingRef.current !== attemptId) return;
          awaitingRef.current = null;
          setLaunchPath(null);
          onConnectedRef.current?.({ kind: 'oauth', attemptId });
        },
      });
      // The tab is opened after an await, so a popup blocker may stop it and the page cannot
      // tell: the link below is always offered while the path is valid.
      setLaunchPath(path);
      openOAuthWindow(path);
    } catch (err) {
      if (!signal?.aborted) setErrorKey(gmailStartErrorKey(err?.code));
    } finally {
      setBusy(false);
    }
  };

  const allowDemoConsent = async () => {
    setBusy(true);
    setErrorKey(null);
    try {
      const { result } = await api.startGoogleOAuth(demoConsent, names, attemptRef.current);
      attemptSentRef.current = true;
      window.postMessage({ type: 'oauth_success', provider: 'google', result, attempt: attemptRef.current }, window.location.origin);
    } catch (err) {
      setErrorKey(gmailStartErrorKey(err?.code));
      setDemoConsent(null);
    } finally {
      setBusy(false);
    }
  };

  if (demoConsent) {
    return (
      <div className="add-account-help" style={{ padding: '16px 18px' }}>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-tertiary)' }}>
          {t('admin.accounts.add.demoConsentBadge')}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: '6px 0 8px' }}>
          {t('admin.accounts.add.demoConsentTitle', { email: demoConsent })}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          {t('admin.accounts.add.demoConsentBody')}
        </div>
        <div className="add-account-actions" style={{ marginTop: 14 }}>
          <button type="button" className="add-account-button" onClick={allowDemoConsent} disabled={busy}>
            {t('admin.accounts.add.demoConsentAllow')}
          </button>
          <button type="button" className="add-account-link-button" onClick={() => setDemoConsent(null)} disabled={busy}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    );
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      // The open list takes the key: the dialog around the form must not also close.
      if (listOpen) { e.preventDefault(); e.stopPropagation(); closeList(); }
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
  // In a suggestion row the button stays compact (the row itself is the target); under the field,
  // where the exact address is shown on its own, it is a full 44 px button.
  const reconnectButton = (row, compact = true) => (
    <button
      type="button"
      className={compact ? undefined : 'add-account-button'}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => openOAuthWindow(row.reconnectUrl)}
      style={compact ? { padding: '3px 8px', fontSize: 11, borderRadius: 6, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', cursor: 'pointer' } : undefined}
    >
      {t('admin.accounts.add.reconnect')}
    </button>
  );

  return (
    <div className="add-account-form" data-provider-form="gmail">
      <div className="add-account-field">
      <label htmlFor="gmail-add-email" className="add-account-label">
        {t('admin.accounts.add.emailLabel')}
      </label>
      <div style={{ position: 'relative' }}>
        <input
          id="gmail-add-email"
          type="email"
          inputMode="email"
          className="add-account-input"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
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
        <div className="add-account-actions" style={{ marginTop: 6 }}>
          {badge(exact)}
          {exact.kind === 'reconnect' && reconnectButton(exact, false)}
        </div>
      )}
      </div>
      {errorKey && <p className="add-account-error" role="alert">{t(errorKey)}</p>}

      <AdvancedConnectionFields managed="gmail">
        <div className="add-account-field">
          <label htmlFor="gmail-add-sender" className="add-account-label">{t('admin.accounts.add.senderNameLabel')}</label>
          <input
            id="gmail-add-sender"
            className="add-account-input"
            value={senderName}
            maxLength={200}
            placeholder={t('admin.accounts.add.senderNamePh')}
            onChange={(e) => setSenderName(e.target.value)}
          />
          <p className="add-account-note">{t('admin.accounts.add.gmailSenderHint')}</p>
        </div>
        <div className="add-account-field">
          <label htmlFor="gmail-add-sender-alt" className="add-account-label">{t('admin.accounts.add.senderNameAltLabel')}</label>
          <input
            id="gmail-add-sender-alt"
            className="add-account-input"
            value={senderNameAlt}
            maxLength={200}
            placeholder={t('admin.accounts.add.senderNameAltPh')}
            onChange={(e) => setSenderNameAlt(e.target.value)}
          />
          <p className="add-account-note">{t('admin.accounts.add.senderNameAltHint')}</p>
        </div>
      </AdvancedConnectionFields>

      <div className="add-account-actions">
        <button type="button" className="add-account-button" onClick={start} disabled={!canStart}>
          {busy ? t('admin.accounts.add.starting') : t('admin.accounts.add.continue')}
        </button>
      </div>

      {launchPath && (
        <p className="add-account-note" style={{ marginTop: 0 }}>
          {t('admin.accounts.add.openGoogleNote')}{' '}
          <a className="add-account-help-link" href={launchPath} target="_blank" rel="opener" onClick={() => setLaunchPath(null)}>
            {t('admin.accounts.add.openGoogle')}
          </a>
        </p>
      )}
    </div>
  );
}
