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

test('the demo Access sync keeps the token hidden and reports a manual run', async () => {
  const initial = await demoRequest('GET', '/admin/access-sync');
  assert.equal(initial.googleMode, true);
  assert.equal(initial.config.apiTokenSet, true);
  assert.equal('apiToken' in initial.config, false);
  assert.equal(initial.lastRun.outcome, 'updated');

  const off = await demoRequest('PUT', '/admin/access-sync', { ...initial.config, enabled: false, apiToken: 'demo-token' });
  assert.equal(off.config.enabled, false);
  assert.equal(JSON.stringify(off).includes('demo-token'), false);
  assert.equal((await demoRequest('POST', '/admin/access-sync/run')).result.outcome, 'not_configured');

  await demoRequest('PUT', '/admin/access-sync', { ...initial.config, enabled: true });
  const ran = await demoRequest('POST', '/admin/access-sync/run');
  assert.equal(ran.result.outcome, 'unchanged');
  assert.equal(ran.lastRun.trigger, 'manual');
  assert.deepEqual(ran.config, { ...initial.config, enabled: true });
});

test('the demo audit log shows a stopped Access sync', async () => {
  const { entries } = await demoRequest('GET', '/admin/audit?action=access.sync_aborted');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].actorEmail, 'Cloudflare Access');
  assert.ok(entries[0].details.candidates.length > 0);
});

test('the demo mail node creates a domain mailbox and lists it with its quota', async () => {
  assert.deepEqual((await demoRequest('GET', '/integrations/status')).domainMail, { configured: true });
  const account = await demoRequest('POST', '/accounts', { kind: 'domain', localPart: 'Info', domain: 'demo.mailexpert.local', name: '' });
  assert.equal(account.email_address, 'info@demo.mailexpert.local');
  assert.equal(account.mail_node, true);
  assert.ok((await demoRequest('GET', '/accounts')).some(a => a.id === account.id));
  const { mailboxes, disk } = await demoRequest('GET', '/mail-node/mailboxes');
  assert.equal(mailboxes.find(m => m.accountId === account.id).quotaMb, 5120);
  assert.equal(typeof disk.usedPercent, 'number');
  const { domains } = await demoRequest('GET', '/mail-node/domains');
  assert.equal(domains[0].mailboxes, 2);
  await demoRequest('PUT', `/mail-node/mailboxes/${account.id}/quota`, { quotaMb: 10240 });
  assert.equal((await demoRequest('GET', '/mail-node/mailboxes')).mailboxes.find(m => m.accountId === account.id).quotaMb, 10240);
});

test('the demo sender history lists earlier letters with their direction, and from: search finds them', async () => {
  const history = await demoRequest('GET', '/mail/messages/demo-001/sender-history?limit=5');
  assert.equal(history.correspondent, 'maya@northstar.example');
  assert.deepEqual(history.items.map(i => [i.id, i.direction]), [['demo-005', 'out']]);
  const found = await demoRequest('GET', '/mail/search?q=from%3Amaya%40northstar.example');
  assert.deepEqual(found.messages.map(m => m.id), ['demo-001']);
});

test('the demo threading diagnostics report the reply chain and letter count for a known message', async () => {
  const diagnostics = await demoRequest('GET', '/mail/messages/demo-005/threading');
  assert.equal(diagnostics.inReplyTo, '<demo-001@demo.mailexpert.local>');
  assert.deepEqual(diagnostics.references, ['<demo-001@demo.mailexpert.local>']);
  assert.equal(diagnostics.reason, 'rfc-root');
  assert.equal(diagnostics.conversation.total, 2);
});

test('the demo threading diagnostics reject like the real 404 for an unknown message', async () => {
  await assert.rejects(
    () => demoRequest('GET', '/mail/messages/does-not-exist/threading'),
    /Message not found/,
  );
});
