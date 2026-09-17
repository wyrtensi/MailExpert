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

test('demo contacts can enter the edit form and round-trip through create and update', async () => {
  const fixture = await demoRequest('GET', '/contacts/demo-contact-1');

  assert.deepEqual(fixture.emails, [{
    value: 'maya.chen@northstar.example',
    type: 'work',
    primary: true,
  }]);
  assert.deepEqual(fixture.phones, [{
    value: '+1 555 0142',
    type: 'work',
    primary: true,
  }]);

  const editPayload = {
    displayName: fixture.display_name,
    firstName: fixture.first_name,
    lastName: fixture.last_name,
    emails: fixture.emails.filter((email) => email.value.trim()),
    phones: fixture.phones.filter((phone) => phone.value.trim()),
    organization: fixture.organization,
    notes: 'Updated in demo mode',
  };
  const updated = await demoRequest('PATCH', `/contacts/${fixture.id}`, editPayload);

  assert.equal(updated.display_name, 'Maya Chen');
  assert.equal(updated.primary_email, 'maya.chen@northstar.example');
  assert.deepEqual(updated.emails, editPayload.emails);
  assert.deepEqual(updated.phones, editPayload.phones);
  assert.equal(updated.notes, 'Updated in demo mode');

  const created = await demoRequest('POST', '/contacts', {
    ...editPayload,
    displayName: 'Jordan Lee',
    firstName: 'Jordan',
    lastName: 'Lee',
    emails: [{ value: 'JORDAN.LEE@EXAMPLE.COM', type: 'work' }],
    phones: [{ value: '+1 555 0199', type: 'mobile' }],
  });

  assert.equal(created.display_name, 'Jordan Lee');
  assert.equal(created.first_name, 'Jordan');
  assert.equal(created.last_name, 'Lee');
  assert.equal(created.primary_email, 'jordan.lee@example.com');
  assert.deepEqual(created.emails, [{
    value: 'JORDAN.LEE@EXAMPLE.COM',
    type: 'work',
    primary: true,
  }]);
  assert.deepEqual(created.phones, [{
    value: '+1 555 0199',
    type: 'mobile',
    primary: true,
  }]);
});

test('the demo audit log lists entries newest first and applies the mailbox, user and action filters', async () => {
  const all = await demoRequest('GET', '/admin/audit');
  assert.equal(all.nextCursor, null);
  assert.ok(all.entries.length >= 4);
  const times = all.entries.map((entry) => entry.occurredAt);
  assert.deepEqual(times, [...times].sort().reverse());

  const sales = await demoRequest('GET', '/admin/audit?account=demo-sales');
  assert.ok(sales.entries.length > 0);
  assert.ok(sales.entries.every((entry) => entry.accountId === 'demo-sales'));

  const sent = await demoRequest('GET', '/admin/audit?action=message.sent');
  assert.ok(sent.entries.length > 0);
  assert.ok(sent.entries.every((entry) => entry.action === 'message.sent'));

  const nobody = await demoRequest('GET', '/admin/audit?user=someone-else');
  assert.deepEqual(nobody.entries, []);
});
