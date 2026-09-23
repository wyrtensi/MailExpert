import { useTranslation } from 'react-i18next';

// The top of "Add account": one tab per way to add a mailbox, the chosen way's form under it. The
// options come from utils/addAccount.js, which decides what is offered and why an option is
// inactive; an inactive tab can still be opened and says why instead of showing its form.
export default function AddAccountTabs({ options, active, onSelect, renderForm }) {
  const { t } = useTranslation();
  const current = options.find((option) => option.kind === active) ?? options[0];
  if (!current) return null;
  return (
    <div>
      <div role="tablist" aria-label={t('admin.accounts.addTitle')} style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-subtle)', marginBottom: 14 }}>
        {options.map((option) => {
          const selected = option.kind === current.kind;
          return (
            <button
              key={option.kind}
              id={`add-account-tab-${option.kind}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="add-account-panel"
              onClick={() => onSelect(option.kind)}
              style={{
                padding: '8px 14px', marginBottom: -1, background: 'none', border: 'none', cursor: 'pointer',
                borderBottom: `2px solid ${selected ? 'var(--accent)' : 'transparent'}`,
                color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontSize: 13, fontWeight: selected ? 600 : 500, opacity: option.enabled ? 1 : 0.6,
              }}
            >
              {t(option.titleKey)}
            </button>
          );
        })}
      </div>
      <div id="add-account-panel" role="tabpanel" aria-labelledby={`add-account-tab-${current.kind}`}>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 14 }}>{t(current.descriptionKey)}</div>
        {current.enabled
          ? renderForm(current.kind)
          : <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t(current.hintKey || 'common.loading')}</div>}
      </div>
    </div>
  );
}
