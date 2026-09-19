import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { threadModeLabel, threadRecomputeText } from './threadMode.js';

const t = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const KEYS = [
  'title', 'modeRfc', 'modeGmail', 'preview', 'previewResult', 'switchToGmail', 'switchToRfc',
  'running', 'paused', 'done', 'failed', 'blockedNotGmail', 'blockedIndex', 'blockedIds',
];

describe('threadModeLabel', () => {
  it('names the rfc mode', () => {
    assert.equal(threadModeLabel({ thread_mode: 'rfc' }, t), 'admin.accounts.threading.modeRfc');
  });

  it('names the gmail mode', () => {
    assert.equal(threadModeLabel({ thread_mode: 'gmail' }, t), 'admin.accounts.threading.modeGmail');
  });

  it('falls back to rfc for an unknown or missing mode', () => {
    assert.equal(threadModeLabel({ thread_mode: null }, t), 'admin.accounts.threading.modeRfc');
    assert.equal(threadModeLabel({}, t), 'admin.accounts.threading.modeRfc');
  });
});

describe('threadRecomputeText', () => {
  it('shows nothing when idle', () => {
    assert.equal(threadRecomputeText(null, t), null);
    assert.equal(threadRecomputeText(undefined, t), null);
    assert.equal(threadRecomputeText({ status: 'idle', percent: null, changed: null, error: null }, t), null);
  });

  it('shows a plain running line without a percent', () => {
    assert.equal(
      threadRecomputeText({ status: 'running', percent: null, changed: null, error: null }, t),
      'admin.accounts.threading.running'
    );
  });

  it('appends the percent while running', () => {
    assert.equal(
      threadRecomputeText({ status: 'running', percent: 42, changed: 10, error: null }, t),
      'admin.accounts.threading.running 42%'
    );
  });

  it('names a stopped pass, which a later trigger continues', () => {
    assert.equal(
      threadRecomputeText({ status: 'paused', percent: null, changed: 3, error: null }, t),
      'admin.accounts.threading.paused'
    );
  });

  it('names the changed count when done', () => {
    assert.equal(
      threadRecomputeText({ status: 'done', percent: 100, changed: 128, error: null }, t),
      'admin.accounts.threading.done {"changed":128}'
    );
  });

  it('shows the error text on failure', () => {
    assert.equal(
      threadRecomputeText({ status: 'error', percent: null, changed: 5, error: 'Connection closed' }, t),
      'admin.accounts.threading.failed {"error":"Connection closed"}'
    );
  });

  it('has English and Russian texts for every threading key', () => {
    for (const locale of ['en', 'ru']) {
      const messages = JSON.parse(readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), 'utf8'));
      for (const key of KEYS) {
        assert.equal(typeof messages.admin.accounts.threading?.[key], 'string', `${locale} admin.accounts.threading.${key}`);
      }
    }
  });
});
