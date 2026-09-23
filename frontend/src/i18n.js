import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ru from './locales/ru.json';
import { normalizeLanguage } from './utils/language.js';
import { setDateLanguage } from './utils/formatDate.js';

const savedLng = normalizeLanguage(localStorage.getItem('mailexpert_language'));

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ru: { translation: ru },
    },
    lng: savedLng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });

// Dates follow the interface language (utils/formatDate.js).
setDateLanguage(i18n.language);
i18n.on('languageChanged', setDateLanguage);

export default i18n;
