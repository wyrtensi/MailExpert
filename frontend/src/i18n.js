import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import { normalizeLanguage } from './utils/language.js';
import { setDateLanguage } from './utils/formatDate.js';
import { lazyLocaleBackend } from './utils/lazyLocales.js';

// English is bundled: it is the fallback for any key a translation lacks, so it must be there
// before anything else. Russian is its own chunk, fetched only when it is the language in use
// (at start or after a switch in the settings or the first-entry picker).
const LOCALES = {
  ru: () => import('./locales/ru.json'),
};

const savedLng = normalizeLanguage(localStorage.getItem('mailexpert_language'));

// Resolves once the starting language is in; main.jsx waits for it, so the first screen is not
// drawn with raw keys or in English and then redrawn.
export const i18nReady = i18n
  .use(lazyLocaleBackend(LOCALES))
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    partialBundledLanguages: true,
    lng: savedLng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });

// Dates follow the interface language (utils/formatDate.js).
setDateLanguage(savedLng);
i18n.on('languageChanged', setDateLanguage);

export default i18n;
