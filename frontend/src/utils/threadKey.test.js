import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { threadCacheKey, pendingDeleteTimerKey } from './threadKey.js';

describe('threadCacheKey', () => {
  it('separates the same thread key in two mailboxes', () => {
    assert.equal(threadCacheKey({ account_id: 'a1', thread_id: 'gmail:17' }), 'a1:gmail:17');
    assert.notEqual(
      threadCacheKey({ account_id: 'a1', thread_id: '<m@example.com>' }),
      threadCacheKey({ account_id: 'a2', thread_id: '<m@example.com>' }),
    );
  });

  it('falls back to the row id when the row has no thread key', () => {
    assert.equal(threadCacheKey({ account_id: 'a1', id: 'row-1' }), 'a1:row-1');
  });
});

describe('pendingDeleteTimerKey', () => {
  it('includes the mailbox, so a pending delete in one mailbox does not guard a same-keyed thread in another', () => {
    const rowInA = { id: 'row-a', account_id: 'a1', thread_id: 'thread-1' };
    const rowInB = { id: 'row-b', account_id: 'a2', thread_id: 'thread-1' };
    assert.notEqual(
      pendingDeleteTimerKey(rowInA, true),
      pendingDeleteTimerKey(rowInB, true),
    );
  });

  it('keys an ordinary (non-thread) row by its own message id', () => {
    const row = { id: 'row-1', account_id: 'a1' };
    assert.equal(pendingDeleteTimerKey(row, false), 'row-1');
  });
});
