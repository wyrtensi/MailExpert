import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../utils/api.js';
import { GMAIL_EMAIL_PATTERN } from '../../utils/addAccount.js';
import { newAttemptId, submitWithReplay } from '../../utils/addAccountFlow.js';
import { findReconnectTarget, protonErrorKey, protonStartBody } from '../../utils/providerConnection.js';
import AdvancedConnectionFields from './AdvancedConnectionFields.jsx';

// The attempt is polled once a second while it is active and given up after ten minutes (the
// server's connection lifetime).
export const PROTON_POLL_MS = 1000;
export const PROTON_TTL_MS = 10 * 60 * 1000;
const POLL_FAILURES_LIMIT = 5;

const ACTIVE_STATES = ['authenticating', 'checking', 'needs_2fa', 'needs_second_password'];
const CHALLENGE_OF_STATE = { needs_2fa: '2fa', needs_second_password: 'second_password' };

// Managed Proton: address and Proton password, then (only when Bridge asks) a two-factor code or a
// second password. The main password and every challenge answer live in this component's state, go
// to the server in the request that carries them and are cleared right after; Back, Close and the
// unmount stop the polling and cancel the attempt on the server (explicit cancel as well as the
// aborted request). Nothing secret reaches the flow state, the store, a URL or storage.
//
// Props: `proton` (the status API's { configured, available, code } or null), `accounts` (the
// shared list, to find a managed mailbox that can be reconnected), `seedAccount` (the mailbox the
// user came from, honoured only when the server says it can be reconnected), plus the dialog's
// `email`, `onEmailChange`, `signal`, `onAttemptStart`, `onConnected`. `pollMs` and `ttlMs` are
// for tests.
export default function ProtonAddForm({
  proton = null,
  accounts = [],
  seedAccount = null,
  email = '',
  onEmailChange,
  signal,
  onAttemptStart,
  onConnected,
  pollMs = PROTON_POLL_MS,
  ttlMs = PROTON_TTL_MS,
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState('');
  const [metadata, setMetadata] = useState({ name: '', senderName: '', signature: '', color: '' });
  const [operation, setOperation] = useState(null); // { id, state }
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState(null);
  const attemptRef = useRef(null);
  const operationRef = useRef(null);
  // A wrong code is announced once per answer: the server keeps reporting it until the next one.
  const answersRef = useRef(0);
  const announcedRef = useRef(0);
  const liveRef = useRef(true);
  const onConnectedRef = useRef(onConnected);
  useEffect(() => { onConnectedRef.current = onConnected; }, [onConnected]);

  const address = email.trim();
  const target = useMemo(() => findReconnectTarget(accounts, address, seedAccount), [accounts, address, seedAccount]);
  const unavailable = proton?.available === false;
  const working = !!operation && ACTIVE_STATES.includes(operation.state);
  const challenge = operation ? CHALLENGE_OF_STATE[operation.state] ?? null : null;

  const finish = (nextOperation) => {
    operationRef.current = nextOperation;
    if (liveRef.current) setOperation(nextOperation);
  };

  // Asks the server to drop the attempt it holds (no signal: the attempt's own one is aborted by
  // then). Fire and forget; the server also expires it after ten minutes.
  const cancelOnServer = (id) => {
    if (id) api.cancelProtonConnection(id).catch(() => {});
  };

  // Applies one status answer: connected closes the form, failed shows its code, the rest go on.
  const apply = (status, id) => {
    const state = status?.state;
    if (state === 'connected' && status.account) {
      operationRef.current = null;
      if (liveRef.current) { setOperation(null); setPassword(''); setSecret(''); setBusy(false); }
      onConnectedRef.current?.({ kind: 'account', account: status.account, attemptId: attemptRef.current });
      return;
    }
    if (state === 'failed' || state === 'expired' || state === 'cancelled') {
      operationRef.current = null;
      if (liveRef.current) {
        setOperation(null);
        setSecret('');
        setBusy(false);
        setErrorKey(protonErrorKey(state === 'failed' ? status.errorCode : state));
      }
      return;
    }
    if (status?.errorCode === 'invalid_challenge' && liveRef.current && announcedRef.current !== answersRef.current) {
      announcedRef.current = answersRef.current;
      setErrorKey(protonErrorKey('invalid_challenge'));
    }
    finish({ id: status?.id ?? id, state: ACTIVE_STATES.includes(state) ? state : 'authenticating' });
  };

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      const current = operationRef.current;
      if (current && ACTIVE_STATES.includes(current.state)) cancelOnServer(current.id);
    };
  }, []);

  // Polling: one request at a time, the next one pollMs after the last answer; stops with the
  // attempt, at the ten-minute limit, and when the form goes away.
  const operationId = operation?.id ?? null;
  useEffect(() => {
    if (!operationId || !working) return undefined;
    let stopped = false;
    let timer = null;
    let failures = 0;
    const deadline = Date.now() + ttlMs;
    const expire = () => {
      stopped = true;
      cancelOnServer(operationId);
      operationRef.current = null;
      if (liveRef.current) { setOperation(null); setSecret(''); setErrorKey(protonErrorKey('expired')); }
    };
    const tick = async () => {
      if (stopped) return;
      if (Date.now() >= deadline) { expire(); return; }
      try {
        const status = await api.getProtonConnection(operationId, { signal });
        if (stopped || signal?.aborted) return;
        failures = 0;
        apply(status, operationId);
        if (!ACTIVE_STATES.includes(status?.state)) return;
      } catch (err) {
        if (stopped || signal?.aborted || err?.name === 'AbortError') return;
        failures += 1;
        if (err?.status === 404 || failures >= POLL_FAILURES_LIMIT) {
          stopped = true;
          cancelOnServer(operationId);
          operationRef.current = null;
          if (liveRef.current) { setOperation(null); setSecret(''); setErrorKey(protonErrorKey(err?.status === 404 ? 'expired' : 'proton_unavailable')); }
          return;
        }
      }
      if (!stopped) timer = setTimeout(tick, pollMs);
    };
    timer = setTimeout(tick, pollMs);
    return () => { stopped = true; clearTimeout(timer); };
    // apply and cancelOnServer only touch refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operationId, working, pollMs, ttlMs, signal]);

  const canStart = GMAIL_EMAIL_PATTERN.test(address) && password.length > 0 && !busy && !working && !unavailable;

  const start = async (event) => {
    event?.preventDefault();
    if (!canStart) return;
    // A new press is a new attempt (the server dedupes by this id and replays its answer).
    attemptRef.current = newAttemptId();
    onAttemptStart?.();
    setBusy(true);
    setErrorKey(null);
    try {
      // A lost answer is replayed once with the same id (the server answers the same attempt).
      const status = await submitWithReplay(
        (id) => api.startProtonConnection(protonStartBody({
          email: address, password, requestId: id, reconnectAccountId: target?.id, metadata,
        }), { signal }),
        attemptRef.current,
        { signal },
      );
      if (signal?.aborted) { cancelOnServer(status?.id); return; }
      if (liveRef.current) setPassword('');
      if (liveRef.current) setBusy(false);
      apply(status, status?.id);
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError' || !liveRef.current) return;
      setErrorKey(protonErrorKey(err?.code));
      setBusy(false);
    }
  };

  const answerChallenge = async (event) => {
    event?.preventDefault();
    if (!operation || !challenge || !secret || busy) return;
    const body = { challenge, secret };
    answersRef.current += 1;
    setBusy(true);
    setErrorKey(null);
    try {
      const status = await api.continueProtonConnection(operation.id, body, { signal });
      if (signal?.aborted) return;
      if (liveRef.current) { setSecret(''); setBusy(false); }
      apply(status, operation.id);
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError' || !liveRef.current) return;
      setSecret('');
      setErrorKey(protonErrorKey(err?.code));
      setBusy(false);
    }
  };

  const cancelAttempt = () => {
    if (operation) cancelOnServer(operation.id);
    operationRef.current = null;
    setOperation(null);
    setSecret('');
    setErrorKey(null);
  };

  if (unavailable) {
    return (
      <div className="add-account-form" data-proton-unavailable>
        <p className="add-account-error" role="status">
          {t(proton.configured === false ? 'admin.accounts.add.protonNotConfigured' : 'admin.accounts.add.protonWorkerDown')}
        </p>
        <AdvancedConnectionFields managed="proton" />
      </div>
    );
  }

  return (
    <div className="add-account-form" data-provider-form="proton">
      {!working && (
        <form className="add-account-form" onSubmit={start} noValidate>
          <div className="add-account-field">
            <label className="add-account-label" htmlFor="proton-add-email">{t('admin.accounts.add.addressLabel')}</label>
            <input
              id="proton-add-email"
              type="email"
              className="add-account-input"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              placeholder={t('admin.accounts.add.protonAddressPh')}
              onChange={(e) => { onEmailChange?.(e.target.value); setErrorKey(null); }}
            />
          </div>
          <div className="add-account-field">
            <label className="add-account-label" htmlFor="proton-add-password">{t('admin.accounts.add.protonPasswordLabel')}</label>
            <input
              id="proton-add-password"
              type="password"
              className="add-account-input"
              autoComplete="new-password"
              autoCapitalize="none"
              spellCheck={false}
              value={password}
              onChange={(e) => { setPassword(e.target.value); setErrorKey(null); }}
            />
            <p className="add-account-note">{t('admin.accounts.add.protonPasswordHint')}</p>
          </div>
          {target && <p className="add-account-note" role="status" data-reconnect>{t('admin.accounts.add.protonReconnectNote')}</p>}
          <AdvancedConnectionFields
            managed="proton"
            metadata={metadata}
            onMetadataChange={(patch) => setMetadata((current) => ({ ...current, ...patch }))}
          />
          {busy && <p className="add-account-success" role="status">{t('admin.accounts.add.checking')}</p>}
          {errorKey && <p className="add-account-error" role="alert">{t(errorKey)}</p>}
          <div className="add-account-actions">
            <button type="submit" className="add-account-button" disabled={!canStart}>
              {t(target ? 'admin.accounts.add.protonReconnect' : 'admin.accounts.add.connect')}
            </button>
          </div>
        </form>
      )}

      {working && (
        <div className="add-account-form" data-proton-working={operation.state}>
          <p className="add-account-success" role="status">
            {t(operation.state === 'checking' ? 'admin.accounts.add.checking' : 'admin.accounts.add.protonSigningIn')}
          </p>
          {challenge && (
            <form className="add-account-form" onSubmit={answerChallenge} noValidate data-proton-challenge={challenge}>
              <div className="add-account-field">
                <label className="add-account-label" htmlFor="proton-add-secret">
                  {t(challenge === '2fa' ? 'admin.accounts.add.protonCodeLabel' : 'admin.accounts.add.protonSecondPasswordLabel')}
                </label>
                <input
                  id="proton-add-secret"
                  type={challenge === '2fa' ? 'text' : 'password'}
                  className="add-account-input"
                  inputMode={challenge === '2fa' ? 'numeric' : undefined}
                  autoComplete={challenge === '2fa' ? 'one-time-code' : 'new-password'}
                  autoCapitalize="none"
                  spellCheck={false}
                  value={secret}
                  onChange={(e) => { setSecret(e.target.value); setErrorKey(null); }}
                />
                <p className="add-account-note">
                  {t(challenge === '2fa' ? 'admin.accounts.add.protonCodeHint' : 'admin.accounts.add.protonSecondPasswordHint')}
                </p>
              </div>
              {errorKey && <p className="add-account-error" role="alert">{t(errorKey)}</p>}
              <div className="add-account-actions">
                <button type="submit" className="add-account-button" disabled={!secret || busy}>{t('admin.accounts.add.protonContinue')}</button>
              </div>
            </form>
          )}
          <div className="add-account-actions">
            <button type="button" className="add-account-link-button" onClick={cancelAttempt}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
