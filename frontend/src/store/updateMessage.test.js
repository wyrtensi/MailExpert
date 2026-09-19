import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { useStore } = await import('./index.js');
globalThis.window = new EventTarget();

// updateMessage resyncs a thread row's aggregate unread state from its cached sub-messages
// when the updated row is itself a sub-message (not in the main list). The cache is keyed by
// mailbox + thread key (threadCacheKey), not by the bare thread id, because two mailboxes can
// carry the same thread key for a conversation delivered to both (#Task 4).
beforeEach(() => {
  useStore.setState({
    messages: [],
    searchResults: [],
    threadMessages: {},
  });
});

test('resyncs the parent thread row when a sub-message is marked read, keyed by mailbox', () => {
  const threadRow = {
    id: 'row-1', account_id: 'acct-a', thread_id: 'thread-1',
    is_read: false, unread_count: 2,
  };
  useStore.getState().setMessages([threadRow]);
  useStore.setState({
    threadMessages: {
      'acct-a:thread-1': [
        { id: 'sub-1', is_read: false },
        { id: 'sub-2', is_read: false },
      ],
    },
  });

  useStore.getState().updateMessage('sub-1', { is_read: true });

  const updatedRow = useStore.getState().messages.find(m => m.id === 'row-1');
  assert.equal(updatedRow.unread_count, 1);
  assert.equal(updatedRow.is_read, false);
});

test('does not resync a thread row from another mailbox that shares the same thread id', () => {
  // Same thread_id in two mailboxes: b's cache must not resync a's row.
  const threadRowA = {
    id: 'row-a', account_id: 'acct-a', thread_id: 'thread-1',
    is_read: false, unread_count: 5,
  };
  useStore.getState().setMessages([threadRowA]);
  useStore.setState({
    threadMessages: {
      // All read under mailbox b's identical thread key -- must not leak into a's row.
      'acct-b:thread-1': [
        { id: 'sub-1', is_read: true },
      ],
    },
  });

  useStore.getState().updateMessage('sub-1', { is_read: true });

  const updatedRow = useStore.getState().messages.find(m => m.id === 'row-a');
  // No cache entry under 'acct-a:thread-1', so the row's aggregate fields are untouched.
  assert.equal(updatedRow.unread_count, 5);
  assert.equal(updatedRow.is_read, false);
});
