import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import RequiredMark from './RequiredMark.jsx';
import {
  advancedFromDefaults,
  isServerChanged,
  missingServerFields,
  portProblems,
} from '../../utils/providerConnection.js';

// The collapsed "Advanced settings" block of every add-account form. It is closed by default and
// only a user click opens it. Inside:
//   - for IMAP forms (`server`): the IMAP/SMTP values, prefilled with the provider's tested route.
//     Changing a server value moves the form to the manual route; Restore returns to the fixed one.
//     "Other" has no fixed route, so its block carries the required values and the logins.
//   - for services whose connection MailExpert owns (`managed`: Gmail, Proton, our own mailbox): a
//     short, safe description of how the connection is made. Servers and the sign-in method are not
//     editable there, and no Bridge password, token or key is ever shown.
//   - optional name, sender name, colour and signature (`metadata`), and any `children` of the form.

export const ACCOUNT_COLORS = Object.freeze([
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#14b8a6',
]);

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function Field({ id, label, children, note, required = false }) {
  return (
    <div className="add-account-field">
      <label className="add-account-label" htmlFor={id}>{label}{required && <RequiredMark />}</label>
      {children}
      {note && <p className="add-account-note">{note}</p>}
    </div>
  );
}

// Spelled out literally so the i18n coverage test finds them.
function ManagedDetails({ kind }) {
  const { t } = useTranslation();
  const rows = {
    gmail: [
      ['admin.accounts.add.managed.methodLabel', 'admin.accounts.add.managed.gmailMethod'],
      ['admin.accounts.add.managed.serversLabel', 'admin.accounts.add.managed.gmailServers'],
      ['admin.accounts.add.managed.secretsLabel', 'admin.accounts.add.managed.gmailSecrets'],
    ],
    proton: [
      ['admin.accounts.add.managed.methodLabel', 'admin.accounts.add.managed.protonMethod'],
      ['admin.accounts.add.managed.serversLabel', 'admin.accounts.add.managed.protonServers'],
      ['admin.accounts.add.managed.secretsLabel', 'admin.accounts.add.managed.protonSecrets'],
    ],
    domain: [
      ['admin.accounts.add.managed.methodLabel', 'admin.accounts.add.managed.domainMethod'],
      ['admin.accounts.add.managed.serversLabel', 'admin.accounts.add.managed.domainServers'],
      ['admin.accounts.add.managed.secretsLabel', 'admin.accounts.add.managed.domainSecrets'],
    ],
  }[kind];
  if (!rows) return null;
  return (
    <div className="add-account-managed" data-managed-details={kind}>
      <dl style={{ margin: 0 }}>
        {rows.map(([labelKey, valueKey]) => (
          <div key={valueKey}>
            <dt>{t(labelKey)}</dt>
            <dd>{t(valueKey)}</dd>
          </div>
        ))}
      </dl>
      <p className="add-account-note">{t('admin.accounts.add.managed.notEditable')}</p>
    </div>
  );
}

function ServerFields({ idBase, server }) {
  const { t } = useTranslation();
  const { values, onChange, defaults, required = false, showLogins = false, manualPolicy } = server;
  const changed = isServerChanged(values, defaults);
  const missing = required ? missingServerFields(values) : [];
  const portIssues = portProblems(values, manualPolicy);
  const set = (key) => (e) => onChange({ [key]: e.target.value });
  const invalid = (key) => missing.includes(key) || portIssues.includes(key);
  const input = (key, extra = {}) => (
    <input
      id={`${idBase}-${key}`}
      className="add-account-input"
      value={values[key] ?? ''}
      onChange={set(key)}
      aria-invalid={invalid(key) ? 'true' : undefined}
      autoComplete="off"
      autoCapitalize="none"
      spellCheck={false}
      required
      {...extra}
    />
  );
  const select = (key, options) => (
    <select id={`${idBase}-${key}`} className="add-account-input" value={values[key]} onChange={set(key)} required>
      {options.map(([value, labelKey]) => <option key={value} value={value}>{t(labelKey)}</option>)}
    </select>
  );
  return (
    <>
      {defaults && !changed && <p className="add-account-note" style={{ marginTop: 0 }}>{t('admin.accounts.add.serversFixedNote')}</p>}
      {defaults && changed && (
        <div role="status" className="add-account-note" style={{ marginTop: 0, color: 'var(--amber)' }}>
          {t('admin.accounts.add.serversChangedNote')}
        </div>
      )}
      {!defaults && <p className="add-account-note" style={{ marginTop: 0 }}>{t('admin.accounts.add.serversRequiredNote')}</p>}

      <fieldset className="add-account-fieldset">
        <legend>{t('admin.accounts.add.imapSection')}</legend>
        <div className="add-account-server-grid">
          <Field id={`${idBase}-imap_host`} label={t('admin.accounts.add.hostLabel')} required>{input('imap_host', { placeholder: t('admin.accounts.imapHostPh') })}</Field>
          <Field id={`${idBase}-imap_port`} label={t('admin.accounts.add.portLabel')} required>{input('imap_port', { inputMode: 'numeric' })}</Field>
          <Field id={`${idBase}-imap_tls_mode`} label={t('admin.accounts.add.securityLabel')} required>
            {select('imap_tls_mode', [['implicit', 'admin.accounts.add.securityImplicit'], ['starttls', 'admin.accounts.add.securityStarttls']])}
          </Field>
        </div>
      </fieldset>

      <fieldset className="add-account-fieldset">
        <legend>{t('admin.accounts.add.smtpSection')}</legend>
        <div className="add-account-server-grid">
          <Field id={`${idBase}-smtp_host`} label={t('admin.accounts.add.hostLabel')} required>{input('smtp_host', { placeholder: t('admin.accounts.smtpHostPh') })}</Field>
          <Field id={`${idBase}-smtp_port`} label={t('admin.accounts.add.portLabel')} required>{input('smtp_port', { inputMode: 'numeric' })}</Field>
          <Field id={`${idBase}-smtp_tls`} label={t('admin.accounts.add.securityLabel')} required>
            {select('smtp_tls', [['SSL', 'admin.accounts.add.securityImplicit'], ['STARTTLS', 'admin.accounts.add.securityStarttls']])}
          </Field>
        </div>
      </fieldset>

      {portIssues.length > 0 && <p className="add-account-error" role="alert">{t('admin.accounts.add.portProblem')}</p>}

      {showLogins && (
        <>
          <Field id={`${idBase}-login`} label={t('admin.accounts.add.loginLabel')} note={t('admin.accounts.add.loginOptionalHint')}>
            <input
              id={`${idBase}-login`}
              className="add-account-input"
              value={server.login ?? ''}
              onChange={(e) => server.onLoginChange?.(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field id={`${idBase}-smtp_login`} label={t('admin.accounts.add.smtpLoginLabel')} note={t('admin.accounts.add.smtpLoginHint')}>
            <input
              id={`${idBase}-smtp_login`}
              className="add-account-input"
              value={values.smtp_login ?? ''}
              onChange={set('smtp_login')}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
        </>
      )}

      {defaults && (
        <div className="add-account-actions">
          <button
            type="button"
            className="add-account-link-button"
            disabled={!changed}
            onClick={() => onChange({ ...advancedFromDefaults(defaults) })}
          >
            {t('admin.accounts.add.serversReset')}
          </button>
        </div>
      )}
    </>
  );
}

function MetadataFields({ idBase, metadata, onChange, hideSenderName }) {
  const { t } = useTranslation();
  const set = (key) => (e) => onChange({ [key]: e.target.value });
  return (
    <>
      <Field id={`${idBase}-name`} label={t('admin.accounts.add.displayNameLabel')} note={t('admin.accounts.add.displayNameHint')}>
        <input id={`${idBase}-name`} className="add-account-input" value={metadata.name ?? ''} onChange={set('name')} maxLength={200} placeholder={t('admin.accounts.displayNamePh')} />
      </Field>
      {!hideSenderName && (
        <Field id={`${idBase}-sender`} label={t('admin.accounts.senderName')}>
          <input id={`${idBase}-sender`} className="add-account-input" value={metadata.senderName ?? ''} onChange={set('senderName')} maxLength={200} placeholder={t('admin.accounts.senderNamePh')} />
        </Field>
      )}
      <div className="add-account-field" role="group" aria-label={t('admin.accounts.color')}>
        <span className="add-account-label">{t('admin.accounts.color')}</span>
        <div className="add-account-swatches">
          {ACCOUNT_COLORS.map((color, i) => (
            <button
              key={color}
              type="button"
              className="add-account-swatch"
              aria-label={`${t('admin.accounts.colorPick')} ${i + 1}`}
              aria-pressed={metadata.color === color}
              onClick={() => onChange({ color: metadata.color === color ? '' : color })}
            >
              <span style={{ background: color }} />
            </button>
          ))}
        </div>
      </div>
      <Field id={`${idBase}-signature`} label={t('admin.accounts.add.signatureLabel')}>
        <textarea id={`${idBase}-signature`} className="add-account-input" value={metadata.signature ?? ''} onChange={set('signature')} maxLength={20000} />
      </Field>
    </>
  );
}

export default function AdvancedConnectionFields({
  server,
  managed,
  metadata,
  onMetadataChange,
  hideSenderName = false,
  open,
  onOpenChange,
  children,
}) {
  const { t } = useTranslation();
  const baseId = useId();
  const [innerOpen, setInnerOpen] = useState(false);
  const isOpen = open ?? innerOpen;
  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  };
  const bodyId = `${baseId}-body`;
  return (
    <section className="add-account-advanced" data-advanced-connection>
      <button type="button" className="add-account-advanced-toggle" aria-expanded={isOpen} aria-controls={bodyId} onClick={toggle}>
        <Chevron />
        <span>{t('admin.accounts.add.advanced')}</span>
      </button>
      {isOpen && (
        <div id={bodyId} className="add-account-advanced-body">
          {managed && <ManagedDetails kind={managed} />}
          {server && <ServerFields idBase={baseId} server={server} />}
          {metadata && <MetadataFields idBase={baseId} metadata={metadata} onChange={onMetadataChange} hideSenderName={hideSenderName} />}
          {children}
        </div>
      )}
    </section>
  );
}
