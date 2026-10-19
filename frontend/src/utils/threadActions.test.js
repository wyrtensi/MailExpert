import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveThreadMessages } from './threadActions.js';

const row = { id: 'row', thread_id: 't1' };
const cached = [{ id: 'a', is_read: false }, { id: 'b', is_read: false }];
const fresh = [...cached, { id: 'c', is_read: false }];   // 'c' arrived after the cache was built
const fetchFresh = () => Promise.resolve({ messages: fresh });

describe('the unread that could not be cleared', () => {
  test('acts on the server truth, not the snapshot taken when the thread was opened', async () => {
    // The bug: a reply arrived after the thread was expanded, so marking the thread read sent
    // only the cached ids. The newer message stayed unread on the server while the UI rendered
    // the row as read, hiding it. The badge then showed an unread nobody could reach.
    const got = await resolveThreadMessages({ message: row, isThreadRow: true, cached, fetchThread: fetchFresh });
    assert.deepEqual(got.map(m => m.id), ['a', 'b', 'c']);
  });

  test('a stale cache is ignored by default, so no caller inherits the bug', async () => {
    let fetched = false;
    await resolveThreadMessages({
      message: row, isThreadRow: true, cached,
      fetchThread: () => { fetched = true; return Promise.resolve({ messages: fresh }); },
    });
    assert.equal(fetched, true, 'the default must reach the server');
  });

  test('destructive actions cannot silently leave the newest messages behind', async () => {
    // A thread-wide delete or move built from a stale list drops whatever arrived since.
    const got = await resolveThreadMessages({ message: row, isThreadRow: true, cached, fetchThread: fetchFresh });
    assert.ok(got.some(m => m.id === 'c'), 'the message that arrived after expansion must be included');
  });
});

describe('resolveThreadMessages: the other paths', () => {
  test('an ordinary row is its own action and never hits the network', async () => {
    let fetched = false;
    const got = await resolveThreadMessages({
      message: row, isThreadRow: false, cached,
      fetchThread: () => { fetched = true; return Promise.resolve({ messages: fresh }); },
    });
    assert.deepEqual(got, [row]);
    assert.equal(fetched, false);
  });

  test('allowCache is honoured when a caller explicitly opts in', async () => {
    let fetched = false;
    const got = await resolveThreadMessages({
      message: row, isThreadRow: true, cached, allowCache: true,
      fetchThread: () => { fetched = true; return Promise.resolve({ messages: fresh }); },
    });
    assert.deepEqual(got.map(m => m.id), ['a', 'b']);
    assert.equal(fetched, false);
  });

  test('an empty or missing cache still fetches even when caching is allowed', async () => {
    for (const c of [undefined, null, [], 'nope']) {
      const got = await resolveThreadMessages({
        message: row, isThreadRow: true, cached: c, allowCache: true, fetchThread: fetchFresh,
      });
      assert.equal(got.length, 3, `cached=${String(c)} must fall through to the server`);
    }
  });
});

describe('resolveThreadMessages: degenerate responses', () => {
  test('an empty thread response falls back to the row rather than acting on nothing', async () => {
    // Reducing a thread action to zero messages would look like a silent no-op to the user.
    for (const bad of [{ messages: [] }, {}, null, undefined]) {
      const got = await resolveThreadMessages({
        message: row, isThreadRow: true, cached, fetchThread: () => Promise.resolve(bad),
      });
      assert.deepEqual(got, [row], `response=${JSON.stringify(bad)} must fall back to the row`);
    }
  });

  test('a rejected fetch propagates, so callers can roll their optimistic update back', async () => {
    await assert.rejects(
      resolveThreadMessages({
        message: row, isThreadRow: true, cached,
        fetchThread: () => Promise.reject(new Error('offline')),
      }),
      /offline/,
    );
  });
});

describe('the draft destroyed by deleting the conversation around it', () => {
  // bulk-delete expunges anything in a Drafts folder instead of moving it to Trash, and the
  // thread endpoint returns every folder, so an unsent reply written in Gmail's web client used
  // to disappear for good when the user deleted the thread it belongs to.
  const withDraft = [{ id: 'a' }, { id: 'draft', is_draft: true }, { id: 'c' }];
  const fetchWithDraft = () => Promise.resolve({ messages: withDraft });

  test('acting on a draft leaves received and sent letters alone', async () => {
    const got = await resolveThreadMessages({ message: withDraft[1], isThreadRow: true,
      excludeDrafts: true, fetchThread: fetchWithDraft });
    assert.deepEqual(got.map(message => message.id), ['draft']);
  });

  test('a thread-wide action leaves the draft alone', async () => {
    const got = await resolveThreadMessages({
      message: row, isThreadRow: true, cached, excludeDrafts: true, fetchThread: fetchWithDraft,
    });
    assert.deepEqual(got.map(m => m.id), ['a', 'c']);
  });

  test('the cached path drops it too, so opting into the snapshot is not a way back in', async () => {
    const got = await resolveThreadMessages({
      message: row, isThreadRow: true, cached: withDraft, allowCache: true, excludeDrafts: true,
      fetchThread: fetchWithDraft,
    });
    assert.deepEqual(got.map(m => m.id), ['a', 'c']);
  });

  test('reading and starring still cover the draft: neither destroys anything', async () => {
    const got = await resolveThreadMessages({
      message: row, isThreadRow: true, cached, fetchThread: fetchWithDraft,
    });
    assert.deepEqual(got.map(m => m.id), ['a', 'draft', 'c']);
  });

  test('a thread of nothing but drafts is the explicit target and is still acted on', async () => {
    const onlyDrafts = [{ id: 'd1', is_draft: true }, { id: 'd2', is_draft: true }];
    const got = await resolveThreadMessages({
      message: row, isThreadRow: true, cached, excludeDrafts: true,
      fetchThread: () => Promise.resolve({ messages: onlyDrafts }),
    });
    assert.deepEqual(got.map(m => m.id), ['d1', 'd2']);
  });

  test('a single draft row is its own action and never reaches the filter', async () => {
    const draftRow = { id: 'draft', is_draft: true };
    const got = await resolveThreadMessages({
      message: draftRow, isThreadRow: false, cached, excludeDrafts: true, fetchThread: fetchWithDraft,
    });
    assert.deepEqual(got, [draftRow]);
  });
});

// A conversation comes back from every folder. Deleting it from the Inbox took its copies already
// in Trash, where a delete expunges for good, and moving it pulled them back out.
describe('resolveThreadMessages: Trash and Spam copies stay where they are', () => {
  const folders = { acc: [{ path: 'Corbeille', special_use: '\\Trash' }, { path: 'Pourriel', special_use: '\\Junk' }, { path: 'INBOX' }] };
  const inThread = [
    { id: 'old', account_id: 'acc', folder: 'Corbeille' },
    { id: 'junk', account_id: 'acc', folder: 'Pourriel' },
    { id: 'new', account_id: 'acc', folder: 'INBOX' },
    { id: 'mine', account_id: 'acc', folder: 'Sent' },
  ];
  const fetchAll = () => Promise.resolve({ messages: inThread });
  const act = (anchor, extra = {}) => resolveThreadMessages({
    message: { id: anchor, thread_id: 't1' }, isThreadRow: true, cached, fetchThread: fetchAll, folders, ...extra,
  });

  test('deleting, moving or archiving from another folder leaves the Trash and Spam copies', async () => {
    const got = await act('new', { excludeDrafts: true });
    assert.deepEqual(got.map(m => m.id), ['new', 'mine']);
  });

  test('acting from Trash or Spam itself still takes the whole conversation', async () => {
    assert.deepEqual((await act('old', { excludeDrafts: true })).map(m => m.id), ['old', 'junk', 'new', 'mine']);
  });

  test('reading and starring still cover every copy', async () => {
    assert.deepEqual((await act('new')).map(m => m.id), ['old', 'junk', 'new', 'mine']);
  });

  test('knows Trash by name when the folder list has not loaded', async () => {
    const list = [{ id: 'old', account_id: 'b', folder: 'Deleted Items' }, { id: 'new', account_id: 'b', folder: 'INBOX' }];
    const got = await resolveThreadMessages({
      message: { id: 'new', thread_id: 't1' }, isThreadRow: true, excludeDrafts: true,
      fetchThread: () => Promise.resolve({ messages: list }),
    });
    assert.deepEqual(got.map(m => m.id), ['new']);
  });

  test('a thread with nothing outside Trash keeps everything, so the action is never empty', async () => {
    const list = [{ id: 'a', account_id: 'acc', folder: 'Corbeille' }, { id: 'b', account_id: 'acc', folder: 'Corbeille' }];
    const got = await resolveThreadMessages({
      message: { id: 'zzz', thread_id: 't1' }, isThreadRow: true, excludeDrafts: true, folders,
      fetchThread: () => Promise.resolve({ messages: list }),
    });
    assert.deepEqual(got.map(m => m.id), ['a', 'b']);
  });
});
