// Interface languages MailExpert ships. A language saved before the others were
// removed (localStorage or synced preferences) falls back to English.
export const LANGUAGES = [
  { code: 'en', nativeName: 'English' },
  { code: 'ru', nativeName: 'Русский' },
];

export function normalizeLanguage(language) {
  return LANGUAGES.some(({ code }) => code === language) ? language : 'en';
}
