// An i18next backend over a map of loaders ({ ru: () => import('../locales/ru.json') }). i18next
// asks it for a language the first time that language is used, and changeLanguage / init resolve
// once the file is in. A language without a loader (the bundled English) yields no resources, so
// what is already bundled stays as it is.
export function lazyLocaleBackend(loaders) {
  return {
    type: 'backend',
    init() {},
    read(language, _namespace, callback) {
      const load = loaders[language];
      if (!load) return callback(null, {});
      load().then((mod) => callback(null, mod.default), (err) => callback(err, null));
    },
  };
}
