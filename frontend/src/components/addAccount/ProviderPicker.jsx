import { useTranslation } from 'react-i18next';
import ProviderIcon from './ProviderIcon.jsx';

// The grid of provider tiles shown before a service is chosen. The tiles are navigation buttons,
// not tabs: choosing one replaces the whole grid with that service's form (AddAccountDialog).
// `providers` is the list from addAccountOptions(): { kind, titleKey, enabled, hintKey }. A tile
// of an unavailable service stays selectable; its form explains why. `lastSelected` marks the
// tile the user came back from, in addition to the focus the dialog puts on it.
export default function ProviderPicker({ providers, onSelect, lastSelected = null }) {
  const { t } = useTranslation();
  return (
    <ul className="add-account-grid" data-provider-picker aria-label={t('admin.accounts.add.pickerLabel')}>
      {providers.map((provider) => {
        const unavailable = !provider.enabled && !!provider.hintKey;
        return (
          <li key={provider.kind}>
            <button
              type="button"
              className="add-account-tile"
              data-provider-tile={provider.kind}
              data-last-selected={provider.kind === lastSelected ? 'true' : undefined}
              onClick={() => onSelect(provider.kind)}
            >
              <ProviderIcon kind={provider.kind} />
              <span className="add-account-tile-name">{t(provider.titleKey)}</span>
              {unavailable && <span className="add-account-tile-state">{t('admin.accounts.add.tileUnavailable')}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
