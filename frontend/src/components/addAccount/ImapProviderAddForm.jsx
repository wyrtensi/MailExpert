import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import RequiredMark from './RequiredMark.jsx';
import { api } from '../../utils/api.js';
import { GMAIL_EMAIL_PATTERN, ADD_ACCOUNT_TITLE_KEYS } from '../../utils/addAccount.js';
import { newAttemptId, submitWithReplay } from '../../utils/addAccountFlow.js';
import { beginMailboxBrowserOAuth, mailboxBrowserOAuthErrorKey } from '../../utils/mailboxBrowserOAuth.js';
import {
  advancedFromDefaults,
  connectionErrorKey,
  connectionNextStepKey,
  emptyAdvanced,
  isAuthRefusal,
  missingServerFields,
  otherProviderForEmail,
  portProblems,
  providerConnectionPayload,
} from '../../utils/providerConnection.js';
import AdvancedConnectionFields from './AdvancedConnectionFields.jsx';
import AppPasswordHelp from './AppPasswordHelp.jsx';
import PasswordField from './PasswordField.jsx';
import useSlowFlag from './useSlowFlag.js';
import useYandexOAuth from './useYandexOAuth.js';
import { useStore } from '../../store/index.js';
import { isDemoMode } from '../../demo/mode.js';

const NO_POLICY = Object.freeze({ allowPrivateHosts: false, allowNonstandardPorts: false });
// The check may take up to 35 s (15 s per protocol); after this long the form says it is still on.
const SLOW_CHECK_MS = 8000;
const focusInput = (input) => { input?.focus(); };

// One address, one app password, "Connect": the form of Yahoo, Yandex, Mail.ru and iCloud, and
// (with `provider="other"`) the manual IMAP/SMTP form, which shares everything but the help text
// and the required server values (see ManualAccountAddForm).
//
// The password lives in this component's state only: it is cleared on success or closing the
// alternative sign-in, and goes away with the component on Back, Close and a tile change. It is
// never put in the flow state, the store, a
// URL or storage. Each press of "Connect" mints a new attempt id (the Idempotency-Key); a lost
// answer is replayed once with the same id. A fixed provider uses the provider route while the
// advanced values equal the catalog's; a changed server value moves the request to the manual
// route and keeps the provider as the label.
//
// Props: `provider` ('yahoo' | 'yandex' | 'mailru' | 'icloud' | 'other'), `catalog` (the status
// API's `mailProviders`, or null), `manualPolicy` (the status API's `manual` booleans), and the
// dialog's `email`, `onEmailChange`, `signal`, `onAttemptStart`, `onConnected`, `onCancel`.
// `slowAfterMs` is for tests.
export default function ImapProviderAddForm({
  provider,
  catalog = null,
  manualPolicy = NO_POLICY,
  oauthConfigured = false,
  yandexBrowserOAuth = false,
  yandexReconnectId = null,
  email = '',
  onEmailChange,
  signal,
  onAttemptStart,
  onConnected,
  slowAfterMs = SLOW_CHECK_MS,
}) {
  const { t } = useTranslation();
  const isOther = provider === 'other';
  const defaults = useMemo(() => (isOther ? null : catalog?.find((entry) => entry?.id === provider) ?? null), [catalog, provider, isOther]);
  const [password, setPassword] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [login, setLogin] = useState('');
  const [loginOffered, setLoginOffered] = useState(false);
  const [advanced, setAdvanced] = useState(() => (isOther ? emptyAdvanced() : advancedFromDefaults(defaults)));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [passwordSelected, setPasswordSelected] = useState(false);
  const [metadata, setMetadata] = useState({ name: '', senderName: '', signature: '', color: '' });
  const [busy, setBusy] = useState(false);
  const [oauthPending, setOauthPending] = useState(false);
  const [errorKey, setErrorKey] = useState(null);
  const [nextStepKey, setNextStepKey] = useState(null);
  const yandex = useYandexOAuth(signal);
  const slow = useSlowFlag(busy, slowAfterMs);
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
    setNextStepKey(null);
  };
  const clearError = () => { setErrorKey(null); setNextStepKey(null); };

  const address = email.trim();
  const serverRequired = isOther || !!defaults;
  const missing = serverRequired ? missingServerFields(advanced) : [];
  const portIssues = portProblems(advanced, manualPolicy);
  const serverIncomplete = serverRequired && (missing.length > 0 || portIssues.length > 0);
  const emailValid = GMAIL_EMAIL_PATTERN.test(address);
  const emailInvalid = emailTouched && address.length > 0 && !emailValid;
  const yandexPending = Boolean(yandex.starting || yandex.flow);
  const blocked = busy || oauthPending || yandexPending;
  const passwordIsAlternative = provider === 'mailru' || provider === 'yandex';
  const showAdvanced = !yandexReconnectId && !yandexPending;
  const showPasswordForm = showAdvanced && (!passwordIsAlternative || (advancedOpen && passwordSelected));
  const canSubmit = showPasswordForm && emailValid && password.length > 0 && !serverIncomplete && !blocked;
  const showMailruOAuth = provider === 'mailru' && oauthConfigured && !passwordSelected;
  const focusMailruAddress = provider === 'mailru' && showPasswordForm;
  const showYandexOAuth = provider === 'yandex' && (oauthConfigured || yandexReconnectId) && !passwordSelected;
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
    clearError();
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
      setNextStepKey(connectionNextStepKey(err?.code, provider));
      if (isAuthRefusal(err?.code)) setLoginOffered(true);
      setBusy(false);
    }
  };

  const openServers = () => setAdvancedOpen(true);

  const toggleAdvanced = (open) => {
    setAdvancedOpen(open);
    if (open || !passwordIsAlternative || !passwordSelected) return;
    setPasswordSelected(false);
    setPassword('');
    setLogin('');
    setLoginOffered(false);
    clearError();
  };

  const selectPassword = () => {
    setPasswordSelected(true);
    clearError();
  };

  const startOAuth = async () => {
    if (blocked || (!showMailruOAuth && !emailValid)) return;
    clearError();
    const target = showMailruOAuth ? { discoverEmail: true }
      : yandexReconnectId ? { accountId: yandexReconnectId } : { email: address };
    if (showYandexOAuth && !yandexBrowserOAuth) {
      onAttemptStart?.();
      await yandex.start(target, (result) => {
        useStore.getState().addNotification({
          type: 'info',
          title: t('admin.integrations.yandex.title'),
          body: t(result === 'updated' ? 'admin.integrations.yandex.updated' : 'admin.integrations.yandex.connected'),
        });
        onConnected?.({ kind: 'oauth' });
      });
      return;
    }
    setOauthPending(true);
    try {
      if (await beginMailboxBrowserOAuth(provider, target, t, signal)) onConnected?.({ kind: 'oauth' });
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError' || !liveRef.current) return;
      setErrorKey(mailboxBrowserOAuthErrorKey(provider, err?.code));
      setOauthPending(false);
    }
  };

  const passwordFields = showPasswordForm && (
    <>
      <div className="add-account-field">
        <label className="add-account-label" htmlFor="imap-add-password">
          {t(isOther ? 'admin.accounts.add.passwordLabel' : 'admin.accounts.add.appPasswordLabel')}
          <RequiredMark />
        </label>
        <PasswordField
          id="imap-add-password"
          ref={passwordIsAlternative && !focusMailruAddress ? focusInput : undefined}
          required
          value={password}
          readOnly={blocked}
          onChange={(e) => { setPassword(e.target.value); clearError(); }}
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
            autoCorrect="off"
            spellCheck={false}
            value={login}
            readOnly={busy}
            aria-describedby="imap-add-login-hint"
            onChange={(e) => { setLogin(e.target.value); clearError(); }}
          />
          <p className="add-account-note" id="imap-add-login-hint">{t('admin.accounts.add.loginAfterRefusalHint')}</p>
        </div>
      )}
    </>
  );

  const passwordOption = passwordIsAlternative && (
    passwordSelected ? passwordFields : (
      <div className="add-account-actions">
        <button type="button" className="add-account-link-button" disabled={blocked} onClick={selectPassword}>
          {t('admin.accounts.add.appPasswordOption')}
        </button>
      </div>
    )
  );

  return (
    <form className="add-account-form" onSubmit={submit} noValidate data-provider-form={provider} aria-busy={busy || oauthPending || yandex.starting}>
      {!showMailruOAuth && (
        <div className="add-account-field">
          <label className="add-account-label" htmlFor="imap-add-email">{t('admin.accounts.add.addressLabel')}<RequiredMark /></label>
          <input
            id="imap-add-email"
            ref={focusMailruAddress ? focusInput : undefined}
            type="email"
            required
            inputMode="email"
            className="add-account-input"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={email}
            readOnly={blocked || Boolean(yandexReconnectId)}
            aria-invalid={emailInvalid ? 'true' : undefined}
            aria-describedby={emailInvalid ? 'imap-add-email-error' : undefined}
            placeholder={t('admin.accounts.add.addressPh')}
            onBlur={() => setEmailTouched(true)}
            onChange={(e) => { onEmailChange?.(e.target.value); clearError(); }}
          />
          {emailInvalid && <p id="imap-add-email-error" className="add-account-error" role="alert" data-email-error>{t('admin.accounts.add.error.emailInvalid')}</p>}
          {otherTile && (
            <p className="add-account-note" role="status" data-other-tile={otherTile}>
              {t('admin.accounts.add.otherTileHint', { service: t(ADD_ACCOUNT_TITLE_KEYS[otherTile]) })}
            </p>
          )}
        </div>
      )}

      {showMailruOAuth && (
        <ol className="add-account-steps">
          <li>
            <a
              className="add-account-button"
              href="https://account.mail.ru/login"
              target="_blank"
              rel="noreferrer"
              aria-describedby="mailru-sign-in-note"
            >
              {t('admin.integrations.mailru.signIn')}
            </a>
            <p className="add-account-note" id="mailru-sign-in-note">{t('admin.integrations.mailru.signInNote')}</p>
          </li>
          <li>
            <a
              className="add-account-button"
              href="https://account.mail.ru/oauth/applications"
              target="_blank"
              rel="noreferrer"
              aria-describedby="mailru-prepare-note"
            >
              {t('admin.integrations.mailru.prepare')}
            </a>
            <p className="add-account-note" id="mailru-prepare-note">{t('admin.integrations.mailru.prepareNote')}</p>
          </li>
          <li>
            <button type="button" className="add-account-button" disabled={blocked} onClick={startOAuth} aria-describedby="mailru-consent-note">
              {t(oauthPending ? 'admin.integrations.mailru.redirecting' : 'admin.integrations.mailru.connect')}
            </button>
            <p className="add-account-note" id="mailru-consent-note">{t('admin.integrations.mailru.consentNote')}</p>
          </li>
        </ol>
      )}

      {showYandexOAuth && (
        <div className="add-account-field">
          {yandex.flow ? (
            <>
              {isDemoMode ? <p className="add-account-note">{t('admin.integrations.yandex.deviceDemo')}</p> : (
                <>
                  <p className="add-account-note">{t('admin.integrations.yandex.deviceInstructions')}</p>
                  <a className="add-account-button" href={yandex.flow.verificationUri} target="_blank" rel="noreferrer">
                    {t('admin.integrations.yandex.deviceOpen')}
                  </a>
                  <code style={{ fontSize: 20, letterSpacing: 2 }}>{yandex.flow.userCode}</code>
                  <p className="add-account-note">{t('admin.integrations.yandex.deviceSafety')}</p>
                </>
              )}
              <p role="status">{t('admin.integrations.yandex.deviceWaiting')}</p>
              <button type="button" className="add-account-link-button" onClick={yandex.cancel}>{t('common.cancel')}</button>
            </>
          ) : (
            <button type="button" className="add-account-button" disabled={!emailValid || blocked} onClick={startOAuth}>
              {t(oauthPending ? 'admin.integrations.yandex.redirecting'
                : yandex.starting ? 'admin.integrations.yandex.starting' : 'admin.integrations.yandex.connect')}
            </button>
          )}
          {yandex.errorKey && <p className="add-account-error" role="alert">{t(yandex.errorKey)}</p>}
        </div>
      )}

      {passwordIsAlternative && showAdvanced && !oauthConfigured && !passwordSelected && (
        <p className="add-account-note">{t('admin.accounts.add.appPasswordWhenOAuthUnavailable')}</p>
      )}

      {!passwordIsAlternative && passwordFields}

      {showAdvanced && (
        <AdvancedConnectionFields
          open={advancedOpen}
          onOpenChange={toggleAdvanced}
          disabled={passwordIsAlternative && blocked}
          beforeFields={passwordOption}
          server={showPasswordForm && (isOther || defaults) ? {
            values: advanced,
            onChange: patchAdvanced,
            defaults,
            required: serverRequired,
            showLogins: isOther,
            login,
            onLoginChange: setLogin,
            manualPolicy,
          } : undefined}
          metadata={showPasswordForm ? metadata : undefined}
          onMetadataChange={(patch) => setMetadata((current) => ({ ...current, ...patch }))}
        >
          {showPasswordForm && !isOther && !defaults && <p className="add-account-note">{t('admin.accounts.add.serversUnknownNote')}</p>}
        </AdvancedConnectionFields>
      )}

      {errorKey && !showPasswordForm && <p className="add-account-error" role="alert">{t(errorKey)}</p>}

      {showPasswordForm && (
        <>
          <div role="status" aria-live="polite">
            {busy && <p className="add-account-success">{t('admin.accounts.add.checking')}</p>}
            {busy && slow && <p className="add-account-note" data-checking-slow>{t('admin.accounts.add.checkingSlow')}</p>}
          </div>
          {errorKey && <p className="add-account-error" role="alert">{t(errorKey)}</p>}
          {errorKey && nextStepKey && <p className="add-account-note" role="status" data-next-step>{t(nextStepKey)}</p>}

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
              {busy ? t('admin.accounts.add.connecting')
                : t(passwordIsAlternative ? 'admin.accounts.add.connectAppPassword' : 'admin.accounts.add.connect')}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
