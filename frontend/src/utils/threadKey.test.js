import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { threadCacheKey } from './threadKey.js';

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
