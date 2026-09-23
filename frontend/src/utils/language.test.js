import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, needsLanguageChoice, normalizeLanguage, suggestedLanguage } from './language.js';

describe('normalizeLanguage', () => {
  it('keeps English and Russian', () => {
    assert.deepEqual(LANGUAGES.map(({ code }) => code), ['en', 'ru']);
    assert.equal(normalizeLanguage('en'), 'en');
    assert.equal(normalizeLanguage('ru'), 'ru');
  });

  it('falls back to English for removed, unknown and missing languages', () => {
    for (const language of ['de', 'fr', 'es', 'it', 'pl', 'cs', 'zhCN', 'xx', '', null, undefined]) {
      assert.equal(normalizeLanguage(language), 'en');
    }
  });
});

describe('first-entry language choice', () => {
  it('asks only when neither this browser nor the account has a language', () => {
    assert.equal(needsLanguageChoice({ stored: null }), true);
    assert.equal(needsLanguageChoice({ stored: null, synced: undefined }), true);
    assert.equal(needsLanguageChoice({ stored: 'en' }), false);
    assert.equal(needsLanguageChoice({ stored: null, synced: 'ru' }), false);
  });

  it('highlights the browser language when MailExpert has it', () => {
    assert.equal(suggestedLanguage(['ru-RU', 'en-US']), 'ru');
    assert.equal(suggestedLanguage(['de-DE', 'en-GB']), 'en');
    assert.equal(suggestedLanguage(['fr']), 'en');
    assert.equal(suggestedLanguage([]), 'en');
  });
});
