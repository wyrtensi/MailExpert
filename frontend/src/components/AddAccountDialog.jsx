import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';
import { addAccountOptions } from '../utils/addAccount.js';
import {
  initialAddAccountFlow,
  newAttemptId,
  transitionAddAccountFlow,
  upsertAccountById,
} from '../utils/addAccountFlow.js';
import { reconcileAccounts } from '../utils/accountsReconcile.js';
import ProviderIcon from './addAccount/ProviderIcon.jsx';
import ProviderPicker from './addAccount/ProviderPicker.jsx';
import ImapProviderAddForm from './addAccount/ImapProviderAddForm.jsx';
import ManualAccountAddForm from './addAccount/ManualAccountAddForm.jsx';
import ProtonAddForm from './addAccount/ProtonAddForm.jsx';
import GmailAddForm from './GmailAddForm.jsx';
import DomainMailboxAddForm from './DomainMailboxAddForm.jsx';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// What the manual form may assume before the status API answers (and when it cannot): nothing.
const NO_MANUAL_POLICY = Object.freeze({ allowPrivateHosts: false, allowNonstandardPorts: false });

function DomainForm({ email, onEmailChange, signal, onAttemptStart, onConnected, accounts }) {
  const attemptRef = useRef(null);
  return (
    <DomainMailboxAddForm
      accounts={accounts}
      initialEmail={email}
      onEmailChange={onEmailChange}
      signal={signal}
      onAttemptStart={() => { attemptRef.current = newAttemptId(); onAttemptStart?.(); }}
      onCreated={(account) => onConnected({ kind: 'account', account, attemptId: attemptRef.current ?? newAttemptId() })}
    />
  );
}

function GmailForm({ email, onEmailChange, signal, onAttemptStart, onConnected, accounts }) {
  return (
    <GmailAddForm
      accounts={accounts}
      initialEmail={email}
      onEmailChange={onEmailChange}
      signal={signal}
      onAttemptStart={onAttemptStart}
      onConnected={onConnected}
    />
  );
}

// The four fixed IMAP providers share one form; it takes the provider's metadata from `catalog`.
const imapForm = (provider) => function ImapForm(props) {
  return <ImapProviderAddForm {...props} provider={provider} />;
};

// Every form takes the same props: email, onEmailChange, signal, accounts, catalog, manualPolicy,
// proton, onAttemptStart, onConnected, onCancel.
const FORMS = {
  domain: DomainForm,
  gmail: GmailForm,
  proton: ProtonAddForm,
  yahoo: imapForm('yahoo'),
  yandex: imapForm('yandex'),
  mailru: imapForm('mailru'),
  icloud: imapForm('icloud'),
  other: ManualAccountAddForm,
};

// `forms` is the kind -> form table; tests pass their own to drive the dialog without a backend.
export default function AddAccountDialog({ onClose, forms = FORMS }) {
  const { t } = useTranslation();
  const titleId = useId();
  const accounts = useStore((s) => s.accounts);
  const fontSize = useStore((s) => s.fontSize) || 100;
  const [flow, dispatch] = useReducer(transitionAddAccountFlow, undefined, initialAddAccountFlow);
  const [googleStatus, setGoogleStatus] = useState(null);
  const [domainStatus, setDomainStatus] = useState(null);
  // The safe, shared part of the status the provider forms need: the catalog of the four fixed
  // providers, the manual policy booleans and the state of the managed Proton worker.
  const [formStatus, setFormStatus] = useState({ catalog: null, manualPolicy: NO_MANUAL_POLICY, proton: null });
  // One controller per open form: Back and Close abort it, and every form drops what arrives late.
  const [session, setSession] = useState(null);
  const overlayRef = useRef(null);
  const panelRef = useRef(null);
  const titleRef = useRef(null);
  const openerRef = useRef(null);
  const attemptedRef = useRef(false);
  const lastSelectedRef = useRef(null);
  const closedRef = useRef(false);
  // Off while the dialog goes away, so handing focus back to the opener is not undone by the trap.
  const trapRef = useRef(true);

  const options = useMemo(() => addAccountOptions({ googleStatus, domainStatus }), [googleStatus, domainStatus]);
  const selected = flow.provider ? options.find((option) => option.kind === flow.provider) ?? null : null;

  // Which integrations are configured: decides the state shown on the Gmail and mail-node forms.
  useEffect(() => {
    let live = true;
    api.getIntegrationsStatus()
      .then((data) => {
        if (!live) return;
        setGoogleStatus(data?.google || { configured: false, available: false });
        setDomainStatus(data?.domainMail || { configured: false });
        setFormStatus({
          catalog: Array.isArray(data?.mailProviders) ? data.mailProviders : null,
          manualPolicy: { ...NO_MANUAL_POLICY, ...(data?.manual || {}) },
          proton: data?.proton || null,
        });
      })
      .catch(() => {
        if (!live) return;
        setGoogleStatus({ configured: false, available: false });
        setDomainStatus({ configured: false });
      });
    return () => { live = false; };
  }, []);

  // Leaving a form (Back, Close, unmount) cancels the attempt; when it had already been sent, the
  // server may have finished it first, so the shared list is read again.
  const endAttempt = useCallback(() => {
    session?.abort();
    if (attemptedRef.current) {
      attemptedRef.current = false;
      reconcileAccounts();
    }
  }, [session]);

  const requestClose = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    endAttempt();
    dispatch({ type: 'close' });
    onClose();
  }, [endAttempt, onClose]);

  const select = (provider) => {
    lastSelectedRef.current = provider;
    attemptedRef.current = false;
    setSession(new AbortController());
    dispatch({ type: 'select', provider });
  };
  const back = () => {
    endAttempt();
    setSession(null);
    dispatch({ type: 'back' });
  };

  const handleConnected = useCallback((result) => {
    const aborted = session?.signal.aborted;
    if (result?.kind === 'account' && result.account) {
      // Always applied against the latest list: the server did create it, whatever the form is doing.
      useStore.getState().setAccounts(upsertAccountById(useStore.getState().accounts, result.account));
    } else if (result?.kind === 'oauth') {
      reconcileAccounts();
    }
    attemptedRef.current = false;
    if (aborted || closedRef.current) return; // late: the list is right, the closed form stays closed
    // An OAuth result is announced by MailApp's global listener (every result, whoever started it).
    if (result?.kind !== 'oauth') {
      useStore.getState().addNotification({
        type: 'info',
        title: t('admin.accounts.addTitle'),
        body: t('admin.accounts.add.connectedToast', { email: result?.account?.email_address || flow.email || '' }),
      });
    }
    closedRef.current = true;
    dispatch({ type: 'close' });
    onClose();
  }, [session, flow.email, onClose, t]);

  // Remember what had focus (the button that opened the dialog), lock the page scroll and make
  // everything else inert; restore all three on the way out, to the values found.
  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    trapRef.current = true;
    const body = document.body;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    const restored = [];
    for (const child of Array.from(body.children)) {
      if (child === overlayRef.current) continue;
      restored.push([child, child.hasAttribute('inert')]);
      child.setAttribute('inert', '');
    }
    titleRef.current?.focus();
    return () => {
      trapRef.current = false;
      body.style.overflow = previousOverflow;
      for (const [child, had] of restored) {
        if (!had) child.removeAttribute('inert');
      }
      const opener = openerRef.current;
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  }, []);

  // Unmounted from outside (the native Back closed it through the store): cancel the attempt the
  // same way Close does, and read the list again if the attempt had been sent.
  useEffect(() => () => {
    if (closedRef.current) return;
    session?.abort();
    if (attemptedRef.current) {
      attemptedRef.current = false;
      reconcileAccounts();
    }
  }, [session]);

  // Escape: a child that used it (the suggestion list) has already called preventDefault; otherwise
  // it closes the dialog. Focus that leaves the panel is pulled back in.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      requestClose();
    };
    const onFocusIn = (e) => {
      const panel = panelRef.current;
      if (trapRef.current && panel && !panel.contains(e.target)) (panel.querySelector(FOCUSABLE) ?? panel).focus();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [requestClose]);

  // Screen changes move focus: a form takes it on its title; Back returns it to the tile it left.
  const previousScreen = useRef('picker');
  useEffect(() => {
    if (previousScreen.current === flow.screen) return;
    previousScreen.current = flow.screen;
    if (flow.screen === 'form') {
      titleRef.current?.focus();
    } else {
      const tile = panelRef.current?.querySelector(`[data-provider-tile="${lastSelectedRef.current}"]`);
      (tile ?? titleRef.current)?.focus();
    }
  }, [flow.screen]);

  // The visible viewport shrinks when the on-screen keyboard opens: follow it so the field in
  // use and the connect button stay in view.
  useEffect(() => {
    const vv = window.visualViewport;
    const overlay = overlayRef.current;
    if (!vv || !overlay) return undefined;
    const fit = () => {
      overlay.style.top = `${vv.offsetTop}px`;
      overlay.style.height = `${vv.height}px`;
      overlay.style.bottom = 'auto';
    };
    fit();
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    return () => {
      vv.removeEventListener('resize', fit);
      vv.removeEventListener('scroll', fit);
    };
  }, []);

  const onPanelKeyDown = (e) => {
    if (e.key !== 'Tab') return;
    const items = Array.from(panelRef.current?.querySelectorAll(FOCUSABLE) ?? []);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const Form = flow.screen === 'form' ? forms[flow.provider] : null;
  const inForm = flow.screen === 'form' && selected;

  return createPortal(
    <div
      ref={overlayRef}
      className="add-account-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) e.preventDefault(); }}
    >
      <div
        ref={panelRef}
        className="add-account-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ '--add-account-scale': fontSize / 100 }}
        onKeyDown={onPanelKeyDown}
      >
        <div className="add-account-header">
          {inForm && (
            <button type="button" className="add-account-back" onClick={back}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              {t('common.back')}
            </button>
          )}
          <h2 id={titleId} ref={titleRef} className="add-account-title" tabIndex={-1}>
            {inForm && (
              <span className="add-account-title-icon"><ProviderIcon kind={selected.kind} size={24} /></span>
            )}
            <span>{inForm ? t(selected.titleKey) : t('admin.accounts.addTitle')}</span>
          </h2>
          <button type="button" className="add-account-icon-button" onClick={requestClose} aria-label={t('common.close')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="add-account-body">
          {flow.screen === 'picker' && (
            <>
              <p className="add-account-hint">{t('admin.accounts.add.pickerHint')}</p>
              <ProviderPicker providers={options} onSelect={select} lastSelected={lastSelectedRef.current} />
            </>
          )}
          {Form && inForm && (
            <>
              {selected.enabled && selected.hintKey && <p className="add-account-hint">{t(selected.hintKey)}</p>}
              {selected.enabled || !selected.hintKey
                ? (
                  <Form
                    key={flow.provider}
                    email={flow.email}
                    onEmailChange={(email) => dispatch({ type: 'email', email })}
                    signal={session?.signal}
                    accounts={accounts}
                    catalog={formStatus.catalog}
                    manualPolicy={formStatus.manualPolicy}
                    proton={formStatus.proton}
                    onAttemptStart={() => { attemptedRef.current = true; }}
                    onConnected={handleConnected}
                    onCancel={back}
                  />
                )
                : <p className="add-account-hint" role="status">{t(selected.hintKey)}</p>}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
