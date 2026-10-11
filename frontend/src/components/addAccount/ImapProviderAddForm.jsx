import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../utils/api.js';
import { GMAIL_EMAIL_PATTERN, ADD_ACCOUNT_TITLE_KEYS } from '../../utils/addAccount.js';
import { newAttemptId, submitWithReplay } from '../../utils/addAccountFlow.js';
import {
  advancedFromDefaults,
  connectionErrorKey,
  emptyAdvanced,
  isAuthRefusal,
  missingServerFields,
  otherProviderForEmail,
  portProblems,
  providerConnectionPayload,
} from '../../utils/providerConnection.js';
import AdvancedConnectionFields from './AdvancedConnectionFields.jsx';
import AppPasswordHelp from './AppPasswordHelp.jsx';

const NO_POLICY = Object.freeze({ allowPrivateHosts: false, allowNonstandardPorts: false });

// One address, one app password, "Connect": the form of Yahoo, Yandex, Mail.ru and iCloud, and
// (with `provider="other"`) the manual IMAP/SMTP form, which shares everything but the help text
// and the required server values (see ManualAccountAddForm).
//
// The password lives in this component's state only: it is cleared on success and goes away with
// the component on Back, Close and a tile change. It is never put in the flow state, the store, a
// URL or storage. Each press of "Connect" mints a new attempt id (the Idempotency-Key); a lost
// answer is replayed once with the same id. A fixed provider uses the provider route while the
// advanced values equal the catalog's; a changed server value moves the request to the manual
// route and keeps the provider as the label.
//
// Props: `provider` ('yahoo' | 'yandex' | 'mailru' | 'icloud' | 'other'), `catalog` (the status
// API's `mailProviders`, or null), `manualPolicy` (the status API's `manual` booleans), and the
// dialog's `email`, `onEmailChange`, `signal`, `onAttemptStart`, `onConnected`, `onCancel`.
export default function ImapProviderAddForm({
  provider,
  catalog = null,
  manualPolicy = NO_POLICY,
  email = '',
  onEmailChange,
  signal,
  onAttemptStart,
  onConnected,
}) {
  const { t } = useTranslation();
  const isOther = provider === 'other';
  const defaults = useMemo(() => (isOther ? null : catalog?.find((entry) => entry?.id === provider) ?? null), [catalog, provider, isOther]);
  const [password, setPassword] = useState('');
  const [login, setLogin] = useState('');
  const [loginOffered, setLoginOffered] = useState(false);
  const [advanced, setAdvanced] = useState(() => (isOther ? emptyAdvanced() : advancedFromDefaults(defaults)));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [metadata, setMetadata] = useState({ name: '', senderName: '', signature: '', color: '' });
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState(null);
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => { liveRef.current = false; };
  }, []);

  // The catalog can arrive after the form opened: take its values unless the user has begun editing.
  const editedRef = useRef(false);
  useEffect(() => {
    if (!isOther && defaults && !editedRef.current) setAdvanced(advancedFromDefaults(defaults));
  }, [defaults, isOther]);

  const patchAdvanced = (patch) => {
    editedRef.current = true;
    setAdvanced((current) => ({ ...current, ...patch }));
    setErrorKey(null);
  };

  const address = email.trim();
  const missing = isOther ? missingServerFields(advanced) : [];
  const portIssues = portProblems(advanced, manualPolicy);
  const serverIncomplete = isOther && (missing.length > 0 || portIssues.length > 0);
  const fixedPortIssue = !isOther && !!defaults && portIssues.length > 0;
  const valid = GMAIL_EMAIL_PATTERN.test(address) && password.length > 0 && !serverIncomplete && !fixedPortIssue;
  const canSubmit = valid && !busy;
  const otherTile = isOther ? null : otherProviderForEmail(address, provider, catalog);

  const submit = async (event) => {
    event?.preventDefault();
    if (!canSubmit) return;
    // Minted here, in the handler: a new press is a new attempt; a lost answer reuses this id.
    const attemptId = newAttemptId();
    const { mode, body } = providerConnectionPayload({
      provider, email: address, appPassword: password, login, advanced, metadata,
    }, defaults);
    onAttemptStart?.();
    setBusy(true);
    setErrorKey(null);
    try {
      const account = await submitWithReplay(
        (id) => (mode === 'preset'
          ? api.addProviderAccount(body, { signal, requestId: id })
          : api.addAccount(body, { signal, requestId: id })),
        attemptId,
        { signal },
      );
      if (liveRef.current) { setPassword(''); setLogin(''); setBusy(false); }
      onConnected?.({ kind: 'account', account, attemptId });
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError' || !liveRef.current) return;
      setErrorKey(connectionErrorKey(err?.code));
      if (isAuthRefusal(err?.code)) setLoginOffered(true);
      setBusy(false);
    }
  };

  const openServers = () => setAdvancedOpen(true);

  return (
    <form className="add-account-form" onSubmit={submit} noValidate data-provider-form={provider}>
      <div className="add-account-field">
        <label className="add-account-label" htmlFor="imap-add-email">{t('admin.accounts.add.addressLabel')}</label>
        <input
          id="imap-add-email"
          type="email"
          className="add-account-input"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          placeholder={t('admin.accounts.add.addressPh')}
          onChange={(e) => { onEmailChange?.(e.target.value); setErrorKey(null); }}
        />
        {otherTile && (
          <p className="add-account-note" role="status" data-other-tile={otherTile}>
            {t('admin.accounts.add.otherTileHint', { service: t(ADD_ACCOUNT_TITLE_KEYS[otherTile]) })}
          </p>
        )}
      </div>

      <div className="add-account-field">
        <label className="add-account-label" htmlFor="imap-add-password">
          {t(isOther ? 'admin.accounts.add.passwordLabel' : 'admin.accounts.add.appPasswordLabel')}
        </label>
        <input
          id="imap-add-password"
          type="password"
          className="add-account-input"
          autoComplete="new-password"
          autoCapitalize="none"
          spellCheck={false}
          value={password}
          onChange={(e) => { setPassword(e.target.value); setErrorKey(null); }}
        />
      </div>

      {!isOther && <AppPasswordHelp provider={provider} url={defaults?.appPasswordUrl} />}

      {loginOffered && (
        <div className="add-account-field" data-login-offered>
          <label className="add-account-label" htmlFor="imap-add-login">{t('admin.accounts.add.loginLabel')}</label>
          <input
            id="imap-add-login"
            className="add-account-input"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={login}
            onChange={(e) => { setLogin(e.target.value); setErrorKey(null); }}
          />
          <p className="add-account-note">{t('admin.accounts.add.loginAfterRefusalHint')}</p>
        </div>
      )}

      <AdvancedConnectionFields
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        server={isOther || defaults ? {
          values: advanced,
          onChange: patchAdvanced,
          defaults,
          required: isOther,
          showLogins: isOther,
          login,
          onLoginChange: setLogin,
          manualPolicy,
        } : undefined}
        metadata={metadata}
        onMetadataChange={(patch) => setMetadata((current) => ({ ...current, ...patch }))}
      >
        {!isOther && !defaults && <p className="add-account-note">{t('admin.accounts.add.serversUnknownNote')}</p>}
      </AdvancedConnectionFields>

      <div role="status" aria-live="polite">
        {busy && <p className="add-account-success">{t('admin.accounts.add.checking')}</p>}
      </div>
      {errorKey && <p className="add-account-error" role="alert">{t(errorKey)}</p>}

      {serverIncomplete && (
        <div className="add-account-note" data-servers-missing>
          {t('admin.accounts.add.serversMissingHint')}{' '}
          {!advancedOpen && (
            <button type="button" className="add-account-link-button" onClick={openServers}>
              {t('admin.accounts.add.serversShow')}
            </button>
          )}
        </div>
      )}

      <div className="add-account-actions">
        <button type="submit" className="add-account-button" disabled={!canSubmit}>
          {busy ? t('admin.accounts.add.connecting') : t('admin.accounts.add.connect')}
        </button>
      </div>
    </form>
  );
}
