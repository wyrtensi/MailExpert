import { useTranslation } from 'react-i18next';

// The first step of "Add account": one card per way to add a mailbox. The options come from
// utils/addAccount.js, which decides what is offered and why an option is inactive.
export default function AddAccountPicker({ options, onPick }) {
  const { t } = useTranslation();
  return (
    <div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
        {t('admin.accounts.add.chooseTitle')}
      </div>
      {options.map((option) => (
        <button
          key={option.kind}
          type="button"
          disabled={!option.enabled}
          onClick={() => option.enabled && onPick(option.kind)}
          style={{
            display: 'block', width: '100%', textAlign: 'left', marginBottom: 10, padding: '12px 14px',
            border: '1px solid var(--border-subtle)', borderRadius: 10, background: 'var(--bg-tertiary)',
            cursor: option.enabled ? 'pointer' : 'not-allowed', opacity: option.enabled ? 1 : 0.6,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>{t(option.titleKey)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>{t(option.descriptionKey)}</div>
          {option.hintKey && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>{t(option.hintKey)}</div>
          )}
        </button>
      ))}
    </div>
  );
}
