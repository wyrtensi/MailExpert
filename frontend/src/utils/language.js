// Interface languages MailExpert ships. A language saved before the others were
// removed (localStorage or synced preferences) falls back to English.
export const LANGUAGES = [
  { code: 'en', nativeName: 'English' },
  { code: 'ru', nativeName: 'Русский' },
];

export function normalizeLanguage(language) {
  return LANGUAGES.some(({ code }) => code === language) ? language : 'en';
}

// The language to highlight on the first-entry picker: the browser's own when MailExpert has it
// (ru-RU -> ru), else English.
export function suggestedLanguage(browserLanguages = []) {
  for (const tag of browserLanguages) {
    const code = String(tag ?? '').toLowerCase().split('-')[0];
    if (LANGUAGES.some((l) => l.code === code)) return code;
  }
  return 'en';
}

// Whether to ask for the language on entry: nobody has chosen one, neither in this browser
// (localStorage) nor in the account's synced preferences. `synced` is the preferences' language,
// or undefined when they are not loaded (demo mode has none to load).
export function needsLanguageChoice({ stored, synced } = {}) {
  return (stored === null || stored === undefined) && !synced;
}
