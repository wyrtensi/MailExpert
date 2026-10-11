import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { copyToClipboard, selectElementText } from '../../utils/clipboard.js';

// Under the app-password field of Yahoo, Yandex, Mail.ru and iCloud: where to create the password
// (a link that opens a new tab, a button that copies the same link, a selectable copy of it when
// the clipboard is refused) and a few short, provider-specific steps. The links carry no part of
// the form: no address, password or token.
//
// The steps and the official help pages were checked against the providers' own help on
// 2026-10-12 (see the Task 11 report); a step that could not be verified is not written.

// Official help pages of the providers, the page that explains the app password.
export const APP_PASSWORD_HELP_URLS = Object.freeze({
  yahoo: 'https://help.yahoo.com/kb/SLN15241.html',
  icloud: 'https://support.apple.com/en-us/102654',
  yandex: 'https://yandex.ru/support/id/authorization/app-passwords.html',
  mailru: 'https://help.mail.ru/mail/faq/password/external/',
});

// Spelled out literally so the i18n coverage test finds them.
const STEPS = {
  yahoo: [
    'admin.accounts.add.appPassword.yahoo.step1',
    'admin.accounts.add.appPassword.yahoo.step2',
    'admin.accounts.add.appPassword.yahoo.step3',
    'admin.accounts.add.appPassword.yahoo.note',
  ],
  icloud: [
    'admin.accounts.add.appPassword.icloud.step1',
    'admin.accounts.add.appPassword.icloud.step2',
    'admin.accounts.add.appPassword.icloud.step3',
    'admin.accounts.add.appPassword.icloud.note',
  ],
  yandex: [
    'admin.accounts.add.appPassword.yandex.step1',
    'admin.accounts.add.appPassword.yandex.step2',
    'admin.accounts.add.appPassword.yandex.step3',
    'admin.accounts.add.appPassword.yandex.note',
  ],
  mailru: [
    'admin.accounts.add.appPassword.mailru.step1',
    'admin.accounts.add.appPassword.mailru.step2',
    'admin.accounts.add.appPassword.mailru.step3',
    'admin.accounts.add.appPassword.mailru.note',
  ],
};

const COPIED_VISIBLE_MS = 4000;

export default function AppPasswordHelp({ provider, url }) {
  const { t } = useTranslation();
  const rootRef = useRef(null);
  const urlRef = useRef(null);
  const timerRef = useRef(null);
  const [copy, setCopy] = useState('idle'); // idle | copied | failed
  const steps = STEPS[provider];
  const helpUrl = APP_PASSWORD_HELP_URLS[provider];

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // The copy could not be made: the link is shown as text and selected, so Ctrl+C / long press is
  // one step. Only the selection moves, never the focus.
  useEffect(() => {
    if (copy === 'failed' && urlRef.current) selectElementText(urlRef.current);
  }, [copy]);

  if (!steps || !url) return null;

  const copyLink = async () => {
    clearTimeout(timerRef.current);
    // The scratch field of the legacy copy must live in the dialog: the rest of the page is inert.
    const container = rootRef.current?.closest('[role="dialog"]') ?? undefined;
    const result = await copyToClipboard(url, { container });
    setCopy(result.ok ? 'copied' : 'failed');
    if (result.ok) timerRef.current = setTimeout(() => setCopy('idle'), COPIED_VISIBLE_MS);
  };

  const providerName = t(`admin.accounts.add.${provider}Title`);
  return (
    <div className="add-account-help" ref={rootRef} data-app-password-help={provider}>
      <strong className="add-account-help-title">{t('admin.accounts.add.appPassword.title')}</strong>
      <ol>
        {steps.slice(0, 3).map((key) => <li key={key}>{t(key)}</li>)}
      </ol>
      <p className="add-account-help-note">{t(steps[3])}</p>
      <div className="add-account-actions">
        <a className="add-account-link-button add-account-link-anchor" href={url} target="_blank" rel="noopener noreferrer">
          {t('admin.accounts.add.appPassword.create')}
        </a>
        <button
          type="button"
          className="add-account-link-button"
          onClick={copyLink}
          aria-label={t('admin.accounts.add.appPassword.copyLabel', { service: providerName })}
        >
          {t('admin.accounts.add.appPassword.copy')}
        </button>
      </div>
      <div role="status" aria-live="polite">
        {copy === 'copied' && <p className="add-account-success add-account-help-gap">{t('admin.accounts.add.appPassword.copied')}</p>}
      </div>
      {copy === 'failed' && (
        <div role="alert">
          <p className="add-account-error add-account-help-gap">{t('admin.accounts.add.appPassword.copyFailed')}</p>
          <code ref={urlRef} className="add-account-url" data-copy-fallback>{url}</code>
        </div>
      )}
      <p className="add-account-note">
        <a className="add-account-help-link" href={helpUrl} target="_blank" rel="noopener noreferrer">{t('admin.accounts.add.appPassword.officialHelp', { service: providerName })}</a>
      </p>
    </div>
  );
}
