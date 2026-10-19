import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstance } from 'i18next';
import { lazyLocaleBackend } from './lazyLocales.js';

const EN = { greeting: 'Hello', onlyEnglish: 'Only in English' };
const RU = { greeting: 'Privet' };

function makeI18n(lng, calls = []) {
  const loaders = {
    ru: () => { calls.push('ru'); return Promise.resolve({ default: RU }); },
  };
  const i18n = createInstance();
  const ready = i18n
    .use(lazyLocaleBackend(loaders))
    .init({
      resources: { en: { translation: EN } },
      partialBundledLanguages: true,
      lng,
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
  return { i18n, ready };
}

test('English start does not fetch the Russian file', async () => {
  const calls = [];
  const { i18n, ready } = makeI18n('en', calls);
  await ready;
  assert.equal(i18n.t('greeting'), 'Hello');
  assert.deepEqual(calls, []);
});

test('Russian start resolves ready with Russian strings and English fallback keys', async () => {
  const calls = [];
  const { i18n, ready } = makeI18n('ru', calls);
  await ready;
  assert.deepEqual(calls, ['ru']);
  assert.equal(i18n.language, 'ru');
  assert.equal(i18n.t('greeting'), 'Privet');
  assert.equal(i18n.t('onlyEnglish'), 'Only in English');
});

test('switching at runtime loads Russian once, then back to English', async () => {
  const calls = [];
  const { i18n, ready } = makeI18n('en', calls);
  await ready;
  const changed = [];
  i18n.on('languageChanged', (l) => changed.push([l, i18n.t('greeting')]));
  await i18n.changeLanguage('ru');
  await i18n.changeLanguage('en');
  await i18n.changeLanguage('ru');
  assert.deepEqual(changed, [['ru', 'Privet'], ['en', 'Hello'], ['ru', 'Privet']]);
  assert.deepEqual(calls, ['ru']);
});

test('a failing load still leaves English usable', async () => {
  const i18n = createInstance();
  const ready = i18n
    .use(lazyLocaleBackend({ ru: () => Promise.reject(new Error('offline')) }))
    .init({ resources: { en: { translation: EN } }, partialBundledLanguages: true, lng: 'ru', fallbackLng: 'en' });
  await ready; // i18next resolves; a failed file only leaves the fallback
  assert.equal(i18n.t('greeting'), 'Hello');
});

test('i18n.js bundles English only and loads Russian by dynamic import', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'i18n.js'), 'utf8');
  assert.match(src, /^import en from '\.\/locales\/en\.json';$/m);
  assert.doesNotMatch(src, /^import \w+ from '\.\/locales\/ru\.json'/m);
  assert.match(src, /import\('\.\/locales\/ru\.json'\)/);
  assert.match(src, /export const i18nReady/);
  assert.match(src, /mailexpert_language/);
});
