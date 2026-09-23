import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import {
  domainMailboxFormError,
  domainMailboxTaken,
  mailNodeErrorDetail,
  mailNodeErrorKey,
  normalizeLocalPart,
  selectableDomains,
} from '../utils/mailNode.js';

const inputStyle = {
  width: '100%', padding: '9px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
};
const labelStyle = { display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 };
const buttonStyle = (primary, enabled = true) => ({
  padding: '9px 16px', borderRadius: 7, fontSize: 13, fontWeight: 500, cursor: enabled ? 'pointer' : 'default',
  opacity: enabled ? 1 : 0.5,
  ...(primary
    ? { border: 'none', background: 'var(--accent)', color: 'var(--accent-text)' }
    : { border: '1px solid var(--border)', background: 'none', color: 'var(--text-secondary)' }),
});

// "Add account -> Our mailbox": the name before @, a domain of the mail node and the name the
// mailbox shows under. An address that is already a mailbox of the install is refused while it is
// typed; the rest is confirmed on a second step before anything is created. The server creates
// the mailbox (or enables it again) with a password only MailExpert knows and connects it;
// `onCreated` gets the new account row.
export default function DomainMailboxAddForm({ accounts = [], onCreated }) {
  const { t } = useTranslation();
  const [domains, setDomains] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [localPart, setLocalPart] = useState('');
  const [domain, setDomain] = useState('');
  const [name, setName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    api.mailNode.listDomains()
      .then((data) => {
        if (!live) return;
        const list = selectableDomains(data?.domains);
        setDomains(list);
        setDomain((current) => current || list[0] || '');
      })
      .catch((err) => { if (live) setLoadError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) }); });
    return () => { live = false; };
  }, []);

  const taken = domainMailboxTaken({ localPart, domain }, accounts);
  const formError = domainMailboxFormError({ localPart, domain }) ?? (taken ? 'admin.accounts.add.domainErrorExists' : null);
  const canContinue = !busy && !formError;
  const email = `${normalizeLocalPart(localPart)}@${domain}`;

  const edit = (setter) => (e) => { setter(e.target.value); setError(null); };

  const review = (e) => {
    e.preventDefault();
    if (canContinue) setConfirming(true);
  };

  const create = async () => {
    if (!canContinue) return;
    setBusy(true);
    setError(null);
    try {
      const account = await api.addDomainMailbox({ localPart: normalizeLocalPart(localPart), domain, name: name.trim() });
      onCreated(account);
    } catch (err) {
      setError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const errorLine = (err) => (
    <div role="alert" style={{ marginTop: 10, fontSize: 12, color: 'var(--red)' }}>
      {t(err.key)}{err.detail ? ` (${err.detail})` : ''}
    </div>
  );

  if (loadError) return errorLine(loadError);
  if (!domains) return <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('common.loading')}</div>;
  if (!domains.length) return <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.accounts.add.domainNoDomains')}</div>;

  if (confirming) {
    return (
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
          {t('admin.accounts.add.domainConfirmTitle')}
        </div>
        <dl style={{ margin: 0, padding: '12px 14px', borderRadius: 8, background: 'var(--bg-tertiary)', fontSize: 13 }}>
          <dt style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t('admin.accounts.add.domainAddressLabel')}</dt>
          <dd style={{ margin: '2px 0 10px', color: 'var(--text-primary)', fontWeight: 500 }}>{email}</dd>
          <dt style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t('admin.accounts.add.domainConfirmName')}</dt>
          <dd style={{ margin: '2px 0 0', color: 'var(--text-primary)' }}>{name.trim() || email}</dd>
        </dl>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
          {t('admin.accounts.add.domainNote')}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button type="button" onClick={create} disabled={!canContinue} style={buttonStyle(true, canContinue)}>
            {busy ? t('admin.accounts.add.domainCreating') : t('admin.accounts.add.domainCreate')}
          </button>
          <button type="button" onClick={() => setConfirming(false)} disabled={busy} style={buttonStyle(false, !busy)}>
            {t('admin.accounts.add.domainChange')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={review}>
      <label htmlFor="domain-add-local" style={labelStyle}>{t('admin.accounts.add.domainAddressLabel')}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          id="domain-add-local"
          autoComplete="off"
          value={localPart}
          placeholder={t('admin.accounts.add.domainLocalPartPh')}
          aria-invalid={!!(localPart && formError)}
          onChange={edit(setLocalPart)}
          style={{ ...inputStyle, flex: 1 }}
        />
        <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>@</span>
        <select
          aria-label={t('admin.accounts.add.domainDomainLabel')}
          value={domain}
          onChange={edit(setDomain)}
          style={{ ...inputStyle, flex: 1 }}
        >
          {domains.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      {localPart && formError && (
        <div style={{ marginTop: 6, fontSize: 11, color: taken ? 'var(--red)' : 'var(--text-tertiary)' }}>{t(formError)}</div>
      )}

      <label htmlFor="domain-add-name" style={{ ...labelStyle, marginTop: 14 }}>{t('admin.accounts.add.domainNameLabel')}</label>
      <input
        id="domain-add-name"
        value={name}
        placeholder={t('admin.accounts.add.domainNamePh')}
        onChange={(e) => setName(e.target.value)}
        style={inputStyle}
      />

      <button type="submit" disabled={!canContinue} style={{ ...buttonStyle(true, canContinue), marginTop: 16 }}>
        {t('admin.accounts.add.domainNext')}
      </button>
      {error && errorLine(error)}
    </form>
  );
}
