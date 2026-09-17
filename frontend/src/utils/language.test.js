import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, normalizeLanguage } from './language.js';

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
