import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageListParams } from './messageListParams.js';

const base = { selectedAccountId: 'acc', selectedFolder: 'INBOX', limit: 50, offset: 0 };

test('mailbox Inbox with categories sends category', () => {
  assert.deepEqual(
    messageListParams({ ...base, categoryActive: true, activeCategory: 'social', unreadOnly: true, threaded: true }),
    { limit: 50, offset: 0, accountId: 'acc', folder: 'INBOX', unreadOnly: 'true', threaded: 'true', category: 'social' },
  );
  assert.equal('category' in messageListParams({ ...base, selectedFolder: 'Sent', categoryActive: true, activeCategory: 'social' }), false);
  assert.equal('category' in messageListParams({ ...base, categoryActive: false, activeCategory: 'social' }), false);
});

test('unified inbox sends no accountId', () => {
  const params = messageListParams({ selectedAccountId: null, selectedFolder: 'INBOX', limit: 50, offset: 0, categoryActive: true, activeCategory: 'primary' });
  // As MessageList does today: the category condition does not look at accountId.
  assert.deepEqual(params, { limit: 50, offset: 0, category: 'primary' });
  assert.deepEqual(messageListParams({ selectedAccountId: null, selectedFolder: 'INBOX', limit: 50, offset: 0 }), { limit: 50, offset: 0 });
});

test('alias view sends aliasId and never category', () => {
  const params = messageListParams({ ...base, selectedAliasId: 'al1', categoryActive: true, activeCategory: 'social' });
  assert.deepEqual(params, { limit: 50, offset: 0, accountId: 'acc', folder: 'INBOX', aliasId: 'al1' });
  assert.equal('aliasId' in messageListParams({ ...base, selectedAliasId: '' }), false);
  assert.equal('aliasId' in messageListParams({ ...base, selectedAliasId: null }), false);
});

test('limit and offset pass through', () => {
  assert.deepEqual(messageListParams({ ...base, limit: 25, offset: 75 }), { limit: 25, offset: 75, accountId: 'acc', folder: 'INBOX' });
});
