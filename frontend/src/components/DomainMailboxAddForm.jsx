import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import {
  domainMailboxFormError,
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

// "Add account -> Mailbox on our domain": the name before @ and a domain of the mail node. The
// server creates the mailbox (or enables it again) with a password only MailExpert knows and
// connects it; `onCreated` gets the new account row.
export default function DomainMailboxAddForm({ onCreated }) {
  const { t } = useTranslation();
  const [domains, setDomains] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [localPart, setLocalPart] = useState('');
  const [domain, setDomain] = useState('');
  const [name, setName] = useState('');
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

  const formError = domainMailboxFormError({ localPart, domain });
  const canCreate = !busy && !formError;

  const create = async (e) => {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const account = await api.addDomainMailbox({ localPart: normalizeLocalPart(localPart), domain, name: name.trim() });
      onCreated(account);
    } catch (err) {
      setError({ key: mailNodeErrorKey(err?.code), detail: mailNodeErrorDetail(err) });
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

  return (
    <form onSubmit={create}>
      <label htmlFor="domain-add-local" style={labelStyle}>{t('admin.accounts.add.domainAddressLabel')}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          id="domain-add-local"
          autoComplete="off"
          value={localPart}
          placeholder={t('admin.accounts.add.domainLocalPartPh')}
          onChange={(e) => { setLocalPart(e.target.value); setError(null); }}
          style={{ ...inputStyle, flex: 1 }}
        />
        <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>@</span>
        <select
          aria-label={t('admin.accounts.add.domainDomainLabel')}
          value={domain}
          onChange={(e) => { setDomain(e.target.value); setError(null); }}
          style={{ ...inputStyle, flex: 1 }}
        >
          {domains.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      {localPart && formError && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-tertiary)' }}>{t(formError)}</div>
      )}

      <label htmlFor="domain-add-name" style={{ ...labelStyle, marginTop: 14 }}>{t('admin.accounts.add.domainNameLabel')}</label>
      <input
        id="domain-add-name"
        value={name}
        placeholder={t('admin.accounts.add.domainNamePh')}
        onChange={(e) => setName(e.target.value)}
        style={inputStyle}
      />
      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
        {t('admin.accounts.add.domainNote')}
      </div>

      <button type="submit" disabled={!canCreate} style={{
        marginTop: 16, padding: '9px 16px', borderRadius: 7, border: 'none', fontSize: 13, fontWeight: 500,
        background: 'var(--accent)', color: 'var(--accent-text)', cursor: canCreate ? 'pointer' : 'default',
        opacity: canCreate ? 1 : 0.5,
      }}>
        {busy ? t('admin.accounts.add.domainCreating') : t('admin.accounts.add.domainCreate')}
      </button>
      {error && errorLine(error)}
    </form>
  );
}
