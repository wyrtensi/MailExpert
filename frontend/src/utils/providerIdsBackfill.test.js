import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providerIdsBackfillText } from './providerIdsBackfill.js';

const t = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const KEYS = ['notStarted', 'running', 'runningPercent', 'paused', 'done', 'error'];

describe('providerIdsBackfillText', () => {
  it('shows nothing for a mailbox without the backfill', () => {
    assert.equal(providerIdsBackfillText(null, t), null);
    assert.equal(providerIdsBackfillText(undefined, t), null);
    assert.equal(providerIdsBackfillText({ status: 'something-else' }, t), null);
  });

  it('names each state', () => {
    assert.equal(providerIdsBackfillText({ status: 'not_started' }, t), 'admin.accounts.providerIds.notStarted');
    assert.equal(providerIdsBackfillText({ status: 'running', percent: null }, t), 'admin.accounts.providerIds.running');
    assert.equal(providerIdsBackfillText({ status: 'running', percent: 40 }, t), 'admin.accounts.providerIds.runningPercent {"percent":40}');
    assert.equal(providerIdsBackfillText({ status: 'paused' }, t), 'admin.accounts.providerIds.paused');
    assert.equal(providerIdsBackfillText({ status: 'done', percent: 100 }, t), 'admin.accounts.providerIds.done');
    assert.equal(providerIdsBackfillText({ status: 'error', error: 'Command failed' }, t), 'admin.accounts.providerIds.error {"error":"Command failed"}');
  });

  it('has English and Russian texts for every state', () => {
    for (const locale of ['en', 'ru']) {
      const messages = JSON.parse(readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), 'utf8'));
      for (const key of KEYS) {
        assert.equal(typeof messages.admin.accounts.providerIds?.[key], 'string', `${locale} admin.accounts.providerIds.${key}`);
      }
    }
  });
});
