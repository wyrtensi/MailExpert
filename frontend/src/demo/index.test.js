import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

let demoRequest;

beforeEach(async () => {
  ({ demoRequest } = await import(`./index.js?test=${crypto.randomUUID()}`));
});

test('marking an unread demo message as read lowers the unread total by one', async () => {
  const before = await demoRequest('GET', '/mail/unread-counts');

  await demoRequest('POST', '/mail/messages/bulk-read', {
    ids: ['demo-001'],
    read: true,
  });

  const after = await demoRequest('GET', '/mail/unread-counts');
  assert.equal(after.total, before.total - 1);
});

test('advertised demo attachments expose pane fields and resolve to local content', async () => {
  const body = await demoRequest('GET', '/mail/messages/demo-001/body');

  assert.deepEqual(body.attachments, [{
    part: '1',
    filename: 'renewal-order-form.txt',
    type: 'text/plain',
    size: 45,
  }]);
  assert.deepEqual(
    await demoRequest('GET', '/mail/messages/demo-001/attachments/1'),
    {
      filename: 'renewal-order-form.txt',
      type: 'text/plain',
      content: 'Demo attachment: renewal order form preview.\n',
    },
  );
});

test('bulk delete removes Trash and Drafts messages but moves ordinary mail to Trash', async () => {
  const draft = await demoRequest('POST', '/mail/draft', {
    accountId: 'demo-sales',
    subject: 'Temporary draft',
    body: 'Draft body',
  });

  const result = await demoRequest('POST', '/mail/messages/bulk-delete', {
    ids: ['demo-001', 'demo-009', `demo-draft-${draft.uid}`],
  });

  assert.deepEqual(result, { ok: true, deleted: ['demo-001', 'demo-009', `demo-draft-${draft.uid}`] });
  assert.equal((await demoRequest('GET', '/mail/messages/demo-001')).folder, 'Trash');
  assert.deepEqual(await demoRequest('GET', '/mail/messages/demo-009'), {});
  assert.deepEqual(await demoRequest('GET', `/mail/messages/demo-draft-${draft.uid}`), {});
});
