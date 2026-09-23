import { fleetAccounts, fleetDomains, fleetLetters } from './fleet.js';

const ACCOUNT_FIXTURES = [
  {
    id: 'demo-sales',
    name: 'Sales Team',
    sender_name: 'MailExpert Sales',
    email_address: 'sales@demo.mailexpert.local',
    imap_host: 'imap.demo.mailexpert.local', imap_port: 993, smtp_host: 'smtp.demo.mailexpert.local', smtp_port: 587, smtp_tls: 'STARTTLS',
    color: '#7c3aed',
    protocol: 'imap',
    enabled: true,
    include_in_unified_inbox: true,
    sort_order: 0,
    folder_mappings: { inbox: 'INBOX', sent: 'Sent', archive: 'Archive', spam: 'Spam', trash: 'Trash', drafts: 'Drafts' },
    signature: '<p>MailExpert Sales</p>',
    categorization_enabled: true,
    health: 'healthy',
    aliases: [],
  },
  {
    id: 'demo-ops',
    name: 'Operations',
    sender_name: 'MailExpert Operations',
    email_address: 'ops@demo.mailexpert.local',
    imap_host: 'imap.demo.mailexpert.local', imap_port: 993, smtp_host: 'smtp.demo.mailexpert.local', smtp_port: 587, smtp_tls: 'STARTTLS',
    color: '#0891b2',
    protocol: 'imap',
    enabled: true,
    include_in_unified_inbox: true,
    sort_order: 1,
    folder_mappings: { inbox: 'INBOX', sent: 'Sent', archive: 'Archive', spam: 'Spam', trash: 'Trash', drafts: 'Drafts' },
    signature: '<p>MailExpert Operations</p>',
    categorization_enabled: true,
    health: 'healthy',
    aliases: [],
  },
];
// 48 generated mailboxes (demo/fleet.js) after the two hand-made ones: 50 in all.
const FLEET_ACCOUNTS = fleetAccounts();
ACCOUNT_FIXTURES.push(...FLEET_ACCOUNTS);

const FOLDER_FIXTURES = [
  { path: 'INBOX', name: 'Inbox', special_use: '\\Inbox' },
  { path: 'Sent', name: 'Sent', special_use: '\\Sent' },
  { path: 'Archive', name: 'Archive', special_use: '\\Archive' },
  { path: 'Spam', name: 'Spam', special_use: '\\Junk' },
  { path: 'Trash', name: 'Trash', special_use: '\\Trash' },
  { path: 'Drafts', name: 'Drafts', special_use: '\\Drafts' },
  { path: 'Projects/Launch', name: 'Launch', special_use: null },
];

function message({
  id,
  accountId,
  folder = 'INBOX',
  subject,
  fromName,
  fromEmail,
  date,
  snippet,
  read = false,
  starred = false,
  attachments = false,
  category = 'primary',
  threadId = id,
  toAddresses,
  ccAddresses = [],
  bodyText = snippet,
  // Generated letters carry their own headers and threading (demo/fleet.js); the hand-made
  // ones below leave these out and read through THREADING_OVERRIDES instead.
  messageId,
  inReplyTo,
  references,
  reason,
  providerThreadId,
  providerMessageId,
}) {
  const account = ACCOUNT_FIXTURES.find(item => item.id === accountId);
  const row = {
    id,
    uid: Number(id.replace(/\D/g, '')) || 1,
    message_id: messageId || `<${id}@demo.mailexpert.local>`,
    thread_id: threadId,
    // Same as the stored column: COALESCE(thread_id, id).
    thread_key: threadId ?? id,
    account_id: account.id,
    account_name: account.name,
    account_email: account.email_address,
    account_color: account.color,
    folder,
    subject,
    from_name: fromName,
    from_email: fromEmail,
    to_addresses: toAddresses || [account.email_address],
    cc_addresses: ccAddresses,
    date,
    snippet,
    is_read: read,
    is_starred: starred,
    has_attachments: attachments,
    category,
    body_html: `<p>${bodyText}</p>`,
    body_text: bodyText,
  };
  if (reason !== undefined) {
    Object.assign(row, {
      in_reply_to: inReplyTo ?? null,
      thread_references: references ?? [],
      threading_reason: reason,
      provider_thread_id: providerThreadId ?? null,
      provider_message_id: providerMessageId ?? null,
    });
  }
  return row;
}

const MESSAGE_FIXTURES = [
  message({
    id: 'demo-001', accountId: 'demo-sales', subject: 'Enterprise renewal approved',
    fromName: 'Maya Chen', fromEmail: 'maya@northstar.example', date: '2026-09-16T08:45:00.000Z',
    snippet: 'The renewal is approved. Please send the final order form.',
    bodyText: 'Great news — our procurement team approved the renewal. Please send the final order form for signature.',
    starred: true, attachments: true, threadId: 'demo-renewal',
  }),
  message({
    id: 'demo-002', accountId: 'demo-ops', subject: 'Incident review: queue latency',
    fromName: 'Noah Williams', fromEmail: 'noah@demo.mailexpert.local', date: '2026-09-16T07:20:00.000Z',
    snippet: 'The post-incident review is ready for comments.',
    bodyText: 'The post-incident review is ready. Please add comments before tomorrow morning.', category: 'automated',
  }),
  message({
    id: 'demo-003', accountId: 'demo-sales', subject: 'September product brief',
    fromName: 'Aster Product News', fromEmail: 'newsletter@aster.example', date: '2026-09-15T16:10:00.000Z',
    snippet: 'A faster workspace, smarter triage, and what is coming next.',
    bodyText: 'This month: a faster workspace, smarter triage, and a preview of what is coming next.', category: 'newsletter',
  }),
  message({
    id: 'demo-004', accountId: 'demo-ops', subject: 'Re: Vendor access checklist',
    fromName: 'Priya Shah', fromEmail: 'priya@vendor.example', date: '2026-09-15T12:30:00.000Z',
    snippet: 'All requested access details are attached.',
    bodyText: 'All requested access details are attached. Let me know if security needs anything else.', read: true, attachments: true,
    threadId: 'demo-vendor-access',
  }),
  message({
    id: 'demo-005', accountId: 'demo-sales', folder: 'Sent', subject: 'Re: Enterprise renewal approved',
    fromName: 'MailExpert Sales', fromEmail: 'sales@demo.mailexpert.local', date: '2026-09-15T09:00:00.000Z',
    snippet: 'Thanks, Maya. The order form is attached.', bodyText: 'Thanks, Maya. The order form is attached for signature.',
    read: true, attachments: true, threadId: 'demo-renewal', toAddresses: ['maya@northstar.example'],
  }),
  message({
    id: 'demo-006', accountId: 'demo-ops', folder: 'Projects/Launch', subject: 'Launch runbook v3',
    fromName: 'Lucas Martin', fromEmail: 'lucas@demo.mailexpert.local', date: '2026-09-14T18:25:00.000Z',
    snippet: 'Updated owners and rollback steps are now in the runbook.',
    bodyText: 'I updated the owners, checkpoints, and rollback steps in the launch runbook.', read: true,
  }),
  message({
    id: 'demo-007', accountId: 'demo-sales', folder: 'Archive', subject: 'Q3 pipeline review notes',
    fromName: 'Elena Rossi', fromEmail: 'elena@demo.mailexpert.local', date: '2026-09-13T11:40:00.000Z',
    snippet: 'Notes and follow-ups from the pipeline review.', bodyText: 'Here are the notes and follow-ups from our Q3 pipeline review.', read: true,
  }),
  message({
    id: 'demo-008', accountId: 'demo-ops', folder: 'Spam', subject: 'You have won a cloud server',
    fromName: 'Cloud Prize Desk', fromEmail: 'winner@suspicious.example', date: '2026-09-12T05:15:00.000Z',
    snippet: 'Claim your prize immediately.', bodyText: 'Claim your prize immediately by following this suspicious link.', category: 'promotion',
  }),
  message({
    id: 'demo-009', accountId: 'demo-sales', folder: 'Trash', subject: 'Old conference invitation',
    fromName: 'Events Team', fromEmail: 'events@conference.example', date: '2026-09-10T14:00:00.000Z',
    snippet: 'Your invitation for the summer conference.', bodyText: 'Your invitation for the summer conference is enclosed.', read: true,
  }),
  ...fleetLetters(FLEET_ACCOUNTS).map(message),
];

const CONTACT_FIXTURES = [
  {
    id: 'demo-contact-1', uid: 'demo-contact-1', display_name: 'Maya Chen', first_name: 'Maya', last_name: 'Chen',
    primary_email: 'maya.chen@northstar.example',
    emails: [{ value: 'maya.chen@northstar.example', type: 'work', primary: true }],
    phones: [{ value: '+1 555 0142', type: 'work', primary: true }],
    urls: [{ value: 'https://northstar.example', type: 'work' }],
    organization: 'Northstar', notes: 'Enterprise renewal contact', is_auto: false, send_count: 8,
    last_sent: '2026-09-15T15:42:00.000Z', etag: 'demo-contact-1-v1', created_at: '2026-08-20T09:00:00.000Z',
    updated_at: '2026-09-15T15:42:00.000Z', has_contact_photo: false,
  },
  {
    id: 'demo-contact-2', uid: 'demo-contact-2', display_name: 'Priya Shah', first_name: 'Priya', last_name: 'Shah',
    primary_email: 'priya@vendor.example',
    emails: [{ value: 'priya@vendor.example', type: 'work', primary: true }],
    phones: [{ value: '+1 555 0102', type: 'work', primary: true }],
    organization: 'Vendor Works', notes: '', is_auto: false, send_count: 5, last_sent: null,
    etag: 'demo-contact-2-v1', created_at: '2026-08-25T09:00:00.000Z', updated_at: '2026-09-12T09:00:00.000Z',
    has_contact_photo: false,
  },
  {
    id: 'demo-contact-3', uid: 'demo-contact-3', display_name: 'Lucas Martin', first_name: 'Lucas', last_name: 'Martin',
    primary_email: 'lucas@demo.mailexpert.local',
    emails: [{ value: 'lucas@demo.mailexpert.local', type: 'work', primary: true }], phones: [],
    organization: 'MailExpert', notes: '', is_auto: true, send_count: 3, last_sent: null,
    etag: 'demo-contact-3-v1', created_at: '2026-09-01T09:00:00.000Z', updated_at: '2026-09-14T18:25:00.000Z',
    has_contact_photo: false,
  },
];

const DEMO_USER = {
  id: 'demo-user',
  username: 'demo@mailexpert.local',
  email: 'demo@mailexpert.local',
  authMode: 'local',
  displayName: 'Demo Administrator',
  avatar: null,
  isAdmin: true,
  totpEnabled: false,
  hasPassword: false,
  hasLockPin: false,
  locked: false,
};

// Audit entries for the admin journal screen, newest first. Times are fixed so the demo reads
// the same on every load.
const AUDIT_FIXTURES = [
  {
    id: '7', occurredAt: '2026-09-17T10:05:00.000Z', actorUserId: null, actorEmail: 'Cloudflare Access',
    accountId: null, accountEmail: null, action: 'access.sync_aborted',
    details: { candidates: ['colleague@demo.mailexpert.local', 'former@demo.mailexpert.local'], activeUsers: 3, maxDisables: 10 },
  },
  {
    id: '6', occurredAt: '2026-09-17T09:40:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: 'demo-sales', accountEmail: 'sales@demo.mailexpert.local', action: 'message.deleted',
    details: { messageId: '<demo-archive@demo.mailexpert.local>', folder: 'INBOX', from: 'newsletter@example.com', permanent: false },
  },
  {
    id: '5', occurredAt: '2026-09-17T09:15:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: 'demo-sales', accountEmail: 'sales@demo.mailexpert.local', action: 'message.sent',
    details: { messageId: '<demo-reply@demo.mailexpert.local>', to: ['buyer@example.com'], cc: [], bcc: [] },
  },
  {
    id: '4', occurredAt: '2026-09-16T16:05:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: 'demo-ops', accountEmail: 'ops@demo.mailexpert.local', action: 'mailbox.connection_changed',
    details: { fields: ['smtp_port'] },
  },
  {
    id: '3', occurredAt: '2026-09-16T12:30:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: null, accountEmail: null, action: 'user.added',
    details: { userId: 'demo-colleague', email: 'colleague@demo.mailexpert.local', isAdmin: false },
  },
  {
    id: '2', occurredAt: '2026-09-15T10:00:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: 'demo-ops', accountEmail: 'ops@demo.mailexpert.local', action: 'mailbox.added',
    details: { protocol: 'imap', oauthProvider: 'google' },
  },
  {
    id: '1', occurredAt: '2026-09-15T09:55:00.000Z', actorUserId: 'demo-user', actorEmail: 'demo@mailexpert.local',
    accountId: 'demo-sales', accountEmail: 'sales@demo.mailexpert.local', action: 'mailbox.added',
    details: { protocol: 'imap', oauthProvider: 'google' },
  },
];

// Cloudflare Access sync settings as an admin sees them. The ids are made up.
const ACCESS_SYNC_FIXTURE = {
  config: {
    enabled: true,
    accountId: '0123456789abcdef0123456789abcdef',
    appId: '11111111-2222-4333-8444-555555555555',
    policyId: '66666666-7777-4888-9999-000000000000',
    apiTokenSet: true,
  },
  lastRun: {
    trigger: 'schedule', startedAt: '2026-09-17T09:00:00.000Z', finishedAt: '2026-09-17T09:00:01.000Z',
    outcome: 'updated', added: 1, removed: 0, disabled: 0, wouldDisable: 0, error: null,
  },
  maxDisables: 10,
  googleMode: true,
};

const DEFAULT_PREFERENCES = {
  theme: 'system',
  language: 'en',
  pageSize: 50,
  threadedView: true,
  categorizationEnabled: true,
  blockRemoteImages: true,
  aiActions: [],
};

let messages = structuredClone(MESSAGE_FIXTURES);
let contacts = structuredClone(CONTACT_FIXTURES);
let preferences = structuredClone(DEFAULT_PREFERENCES);
let nextDraftUid = 1000;
let nextMessageSequence = 10;
let accessSync = structuredClone(ACCESS_SYNC_FIXTURE);

function clone(value) {
  return structuredClone(value);
}

function parsePath(path) {
  return new URL(path, 'https://demo.mailexpert.local');
}

function accountFor(id) {
  return ACCOUNT_FIXTURES.find(account => account.id === id);
}

function visibleMessages() {
  return messages.filter(item => accountFor(item.account_id)?.enabled);
}

function messageById(id) {
  return messages.find(item => item.id === id);
}

function unreadCounts() {
  const byAccount = {};
  const snapshots = {};
  let total = 0;
  for (const account of ACCOUNT_FIXTURES) {
    const inbox = messages.filter(item => item.account_id === account.id && item.folder === 'INBOX');
    const unread = inbox.filter(item => !item.is_read).length;
    byAccount[account.id] = unread;
    snapshots[account.id] = {
      totalCount: inbox.length,
      revision: String(messages.length),
      attemptRevision: String(messages.length),
      observedAt: '2026-09-16T09:00:00.000Z',
      stale: false,
      known: true,
    };
    if (account.include_in_unified_inbox) total += unread;
  }
  return { total, byAccount, snapshots, complete: true };
}

function foldersFor(accountId) {
  return FOLDER_FIXTURES.map((folder, index) => {
    const contents = messages.filter(item => item.account_id === accountId && item.folder === folder.path);
    return {
      id: `${accountId}-${index + 1}`,
      account_id: accountId,
      path: folder.path,
      name: folder.name,
      special_use: folder.special_use,
      delimiter: '/',
      no_select: false,
      total_count: contents.length,
      unread_count: contents.filter(item => !item.is_read).length,
      server_total_count: contents.length,
      server_unread_count: contents.filter(item => !item.is_read).length,
      server_counts_at: '2026-09-16T09:00:00.000Z',
      counts_known: true,
      counts_stale: false,
    };
  });
}

function listMessages(url, forceSearch = false) {
  const accountId = url.searchParams.get('accountId');
  const folder = url.searchParams.get('folder') || (forceSearch ? null : 'INBOX');
  const category = url.searchParams.get('category');
  const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
  const query = (url.searchParams.get('q') || '').trim().toLocaleLowerCase();
  const limit = Math.max(0, Number.parseInt(url.searchParams.get('limit') || '50', 10));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10));
  let result = visibleMessages();
  if (accountId) result = result.filter(item => item.account_id === accountId);
  if (folder) result = result.filter(item => item.folder === folder);
  if (unreadOnly) result = result.filter(item => !item.is_read);
  if (category) result = result.filter(item => (item.category || 'primary') === category);
  // The one search operator the demo understands: from:<address>, as the sender history uses it.
  const fromOnly = query.match(/^from:"?([^"\s]+)"?$/);
  if (fromOnly) {
    result = result.filter(item => String(item.from_email || '').toLocaleLowerCase() === fromOnly[1]);
  } else if (query) {
    result = result.filter(item => [item.subject, item.from_name, item.from_email, item.snippet, item.body_text]
      .some(value => String(value || '').toLocaleLowerCase().includes(query)));
  }
  result.sort((left, right) => new Date(right.date) - new Date(left.date));
  if (url.searchParams.get('threaded') === 'true' && !forceSearch && !query) {
    return threadedPage(result, { accountId, folder, limit, offset });
  }
  return { messages: result.slice(offset, offset + limit), total: result.length };
}

// Threaded list, as the server builds it (messageService.listMessages): one row per mailbox and
// conversation, the newest letter standing for it with the first letter's subject and sender,
// message_count over distinct letters (INBOX only for an inbox view) and unread_count.
function threadedPage(filtered, { accountId, folder, limit, offset }) {
  const groups = new Map();
  for (const item of filtered) {
    const key = `${item.account_id}\u0000${item.thread_key}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const inboxOnly = !accountId || folder === 'INBOX';
  const rows = [...groups.values()].map((group) => {
    const newest = group[0];
    const first = group[group.length - 1];
    const whole = messages.filter(m => m.account_id === newest.account_id && m.thread_key === newest.thread_key
      && (!inboxOnly || m.folder === 'INBOX'));
    return {
      ...newest,
      thread_id: newest.thread_key,
      subject: first.subject,
      from_name: first.from_name,
      from_email: first.from_email,
      message_count: Math.max(1, new Set(whole.map(m => m.message_id)).size),
      unread_count: group.filter(m => !m.is_read).length,
    };
  });
  return { messages: rows.slice(offset, offset + limit), total: rows.length, threaded: true };
}

function updateMessages(ids, updater) {
  const updated = [];
  for (const id of ids || []) {
    const item = messageById(id);
    if (!item) continue;
    updater(item);
    updated.push(id);
  }
  return updated;
}

function moveMessages(ids, folder) {
  return updateMessages(ids, item => { item.folder = folder; });
}

function deleteMessages(ids) {
  const deleted = [];
  const remove = new Set();
  for (const id of ids || []) {
    const item = messageById(id);
    if (!item) continue;
    deleted.push(id);
    if (item.folder === 'Trash' || item.folder === 'Drafts') remove.add(id);
    else item.folder = 'Trash';
  }
  if (remove.size) messages = messages.filter(item => !remove.has(item.id));
  return deleted;
}

function createDraft(body) {
  const account = accountFor(body.accountId) || ACCOUNT_FIXTURES[0];
  const existing = body.existingUid == null
    ? null
    : messages.find(item => item.account_id === account.id && item.uid === Number(body.existingUid));
  const uid = existing?.uid || nextDraftUid++;
  const target = existing || message({
    id: `demo-draft-${uid}`,
    accountId: account.id,
    folder: 'Drafts',
    subject: body.subject || '',
    fromName: account.sender_name,
    fromEmail: account.email_address,
    date: new Date().toISOString(),
    snippet: body.body || '',
    bodyText: body.body || '',
    read: true,
    toAddresses: body.to || [],
  });
  Object.assign(target, {
    uid,
    folder: 'Drafts',
    subject: body.subject || '',
    to_addresses: body.to || [],
    cc_addresses: body.cc || [],
    snippet: String(body.body || '').replace(/<[^>]*>/g, ' ').trim().slice(0, 240),
    body_html: body.bodyIsHtml ? body.body || '' : `<p>${body.body || ''}</p>`,
    body_text: body.bodyIsHtml ? String(body.body || '').replace(/<[^>]*>/g, ' ').trim() : body.body || '',
    date: new Date().toISOString(),
  });
  if (!existing) messages.push(target);
  return { uid, folder: 'Drafts' };
}

function sendMessage(body) {
  const account = accountFor(body.accountId) || ACCOUNT_FIXTURES[0];
  const sequence = nextMessageSequence++;
  const id = `demo-${String(sequence).padStart(3, '0')}`;
  messages.push(message({
    id,
    accountId: account.id,
    folder: 'Sent',
    subject: body.subject || '',
    fromName: account.sender_name,
    fromEmail: account.email_address,
    date: new Date().toISOString(),
    snippet: String(body.body || '').replace(/<[^>]*>/g, ' ').trim().slice(0, 240),
    bodyText: body.bodyIsHtml ? String(body.body || '').replace(/<[^>]*>/g, ' ').trim() : body.body || '',
    read: true,
    attachments: Array.isArray(body.attachments) && body.attachments.length > 0,
    toAddresses: body.to || [],
  }));
  return { ok: true, messageId: id, sentFolder: 'Sent', sentCopySaved: true };
}

function listContacts(url) {
  const query = (url.searchParams.get('q') || '').trim().toLocaleLowerCase();
  const limit = Math.max(0, Number.parseInt(url.searchParams.get('limit') || '50', 10));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10));
  let result = contacts;
  if (query) {
    result = result.filter(contact => [
      contact.display_name, contact.primary_email, contact.organization,
      ...(contact.emails || []).map(entry => entry.value),
      ...(contact.phones || []).map(entry => entry.value),
      ...(contact.urls || []).map(entry => entry.value),
    ].some(value => String(value || '').toLocaleLowerCase().includes(query)));
  }
  return { contacts: result.slice(offset, offset + limit), total: result.length };
}

function contactMethods(values, defaultType) {
  return (Array.isArray(values) ? values : []).map((method, index) => ({
    value: String(method?.value ?? ''),
    type: method?.type || defaultType,
    primary: method?.primary ?? index === 0,
  }));
}

function contactFromPayload(payload, current = {}) {
  const emails = contactMethods(payload.emails ?? current.emails, 'other');
  const phones = contactMethods(payload.phones ?? current.phones, 'mobile');
  const urls = contactMethods(payload.urls ?? current.urls, 'work')
    .map(entry => ({ ...entry, value: /^[a-z][a-z0-9+.-]*:/i.test(entry.value) ? entry.value : `https://${entry.value}` }));
  const primaryEmail = emails[0]?.value?.trim().toLocaleLowerCase() || null;
  const now = new Date().toISOString();
  return {
    ...current,
    display_name: payload.displayName ?? current.display_name ?? '',
    first_name: payload.firstName ?? current.first_name ?? '',
    last_name: payload.lastName ?? current.last_name ?? '',
    primary_email: primaryEmail,
    emails,
    phones,
    urls,
    organization: payload.organization ?? current.organization ?? '',
    notes: payload.notes ?? current.notes ?? '',
    is_auto: current.is_auto ?? false,
    send_count: current.send_count ?? 0,
    last_sent: current.last_sent ?? null,
    etag: `demo-contact-${now}`,
    created_at: current.created_at ?? now,
    updated_at: now,
    has_contact_photo: current.has_contact_photo ?? false,
  };
}

// The mail node as an admin sees it in the demo: its domains, the mailboxes made there, the disk.
let mailNodeDomains = [
  { domain: 'demo.mailexpert.local', active: true, maxMailboxes: 500, mailboxes: 0 },
  ...fleetDomains(FLEET_ACCOUNTS),
];
let mailNodeMailboxes = FLEET_ACCOUNTS.filter(account => account.mail_node).map((account, index) => ({
  accountId: account.id, email: account.email_address, onNode: true, active: true, quotaMb: 5120,
  usedBytes: ((index * 37) % 90 + 3) * 10 * 1048576,
}));

// Addresses Google granted before (the grant journal) that are no mailbox now: the Gmail field
// offers them as "Connected before".
const KNOWN_GOOGLE_EMAILS = ['acme.archive.demo@gmail.com', 'acme.legacy.demo@gmail.com', 'acme.interns.demo@gmail.com'];

function demoError(message, code) {
  return Object.assign(new Error(message), { code });
}

const normalizeEmail = value => String(value ?? '').trim().toLowerCase();
const mailboxWithEmail = email => ACCOUNT_FIXTURES.find(account => normalizeEmail(account.email_address) === normalizeEmail(email));

// A new mailbox is not empty in the demo: one letter says it is ready.
function welcomeLetter(account) {
  const sequence = nextMessageSequence++;
  messages.push(message({
    id: `demo-${String(sequence).padStart(3, '0')}`, accountId: account.id,
    subject: 'Ящик подключён к MailExpert', fromName: 'MailExpert', fromEmail: 'noreply@demo.mailexpert.local',
    date: new Date().toISOString(), snippet: `Письма на ${account.email_address} теперь видны всей команде.`,
    category: 'automated',
  }));
}

// "Mailbox on our domain" in the demo, with the same refusals as POST /api/accounts kind=domain.
function createDomainMailbox(body) {
  const localPart = normalizeEmail(body.localPart);
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(localPart) || localPart.includes('..')) {
    throw demoError('Invalid local part', 'local_part_invalid');
  }
  const domain = mailNodeDomains.find(d => d.domain === normalizeEmail(body.domain) && d.active);
  if (!domain) throw demoError('Unknown domain', 'domain_unknown');
  const email = `${localPart}@${domain.domain}`;
  if (mailboxWithEmail(email)) throw demoError('This mailbox is already in MailExpert', 'mailbox_exists');
  const name = String(body.name ?? '').trim() || email;
  const account = {
    ...clone(ACCOUNT_FIXTURES[0]), id: `demo-node-${email}`, name, sender_name: name,
    imap_host: 'mail.demo.mailexpert.local', smtp_host: 'mail.demo.mailexpert.local',
    email_address: email, color: '#0ea5e9', signature: null, sort_order: ACCOUNT_FIXTURES.length,
    mail_node: true, thread_mode: 'rfc',
  };
  ACCOUNT_FIXTURES.push(account);
  mailNodeMailboxes = [...mailNodeMailboxes, { accountId: account.id, email, onNode: true, active: true, quotaMb: 5120, usedBytes: 0 }];
  mailNodeDomains = mailNodeDomains.map(d => (d.domain === domain.domain ? { ...d, mailboxes: d.mailboxes + 1 } : d));
  welcomeLetter(account);
  return account;
}

// The demo stands in for Google's consent: the Gmail form asks "Allow?" itself and then calls
// start, which here connects the address at once, as the callback would.
function connectGmail(body) {
  const email = normalizeEmail(body.email);
  if (!/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email)) throw demoError('Invalid email', 'email_invalid');
  if (mailboxWithEmail(email)) throw demoError('Already connected', 'already_connected');
  const account = {
    ...clone(ACCOUNT_FIXTURES[0]), id: `demo-gmail-${email}`, name: email, sender_name: email.split('@')[0],
    imap_host: 'imap.gmail.com', smtp_host: 'smtp.gmail.com', email_address: email, color: '#ea4335',
    signature: null, sort_order: ACCOUNT_FIXTURES.length, oauth_provider: 'google', thread_mode: 'gmail',
  };
  ACCOUNT_FIXTURES.push(account);
  welcomeLetter(account);
  return { path: null, demo: true, result: 'created' };
}

function demoSenderHistory(id) {
  const current = messageById(id);
  if (!current) return { correspondent: null, total: 0, items: [] };
  const account = ACCOUNT_FIXTURES.find(item => item.id === current.account_id);
  const own = account?.email_address;
  const other = current.from_email === own ? current.to_addresses[0] : current.from_email;
  const earlier = MESSAGE_FIXTURES
    .filter(m => m.id !== id && m.account_id === current.account_id && m.date < current.date)
    .filter(m => m.from_email === other || (m.from_email === own && m.to_addresses.includes(other)))
    .sort((a, b) => b.date.localeCompare(a.date));
  return {
    correspondent: other || null,
    total: earlier.length,
    items: earlier.slice(0, 5).map(m => ({
      id: m.id, folder: m.folder, subject: m.subject, snippet: m.snippet, date: m.date,
      direction: m.from_email === own ? 'out' : 'in',
    })),
  };
}

function demoMessageIdFor(id) {
  return `<${id}@demo.mailexpert.local>`;
}

// Per-message threading diagnostics (GET /mail/messages/:id/threading), same shape the server
// answers: one fixture is a reply in its chain, one is a provisional ancestor whose root never
// synced, one is an old row with no recorded reason, everything else reads as its own thread.
const THREADING_OVERRIDES = {
  'demo-005': {
    inReplyTo: demoMessageIdFor('demo-001'),
    references: [demoMessageIdFor('demo-001')],
    reason: 'rfc-root',
    threadId: demoMessageIdFor('demo-001'),
  },
  'demo-004': {
    inReplyTo: '<checklist-kickoff@vendor.example>',
    references: ['<checklist-kickoff@vendor.example>'],
    reason: 'rfc-provisional',
    threadId: '<checklist-kickoff@vendor.example>',
  },
  'demo-009': { reason: null, threadIdNull: true },
};

// Full raw headers (GET /mail/messages/:id/headers), built the same way the server falls back
// to buildHeadersFromMessage when it cannot re-fetch the original ones from IMAP. Pre-existing
// gap: the generic demo fallback answered { headers: [] } here, an array MessageHeaderModal's
// headers.split('\n') cannot handle, crashing the modal on every open in demo mode.
// What the diagnostics and headers say about a letter: a generated one carries its own fields,
// a hand-made one reads THREADING_OVERRIDES (anything not listed there is its own root).
function threadingOf(current) {
  if ('threading_reason' in current) {
    return {
      inReplyTo: current.in_reply_to, references: current.thread_references, reason: current.threading_reason,
      threadId: current.thread_id, providerThreadId: current.provider_thread_id, providerMessageId: current.provider_message_id,
    };
  }
  const override = THREADING_OVERRIDES[current.id] || {};
  return {
    inReplyTo: override.inReplyTo ?? null,
    references: override.references ?? [],
    reason: 'reason' in override ? override.reason : 'new-root',
    threadId: override.threadIdNull ? null : (override.threadId ?? current.message_id),
    providerThreadId: null,
    providerMessageId: null,
  };
}

function demoHeaders(id) {
  const current = messageById(id);
  if (!current) return null;
  const override = threadingOf(current);
  const lines = [];
  lines.push(`From: ${current.from_name} <${current.from_email}>`);
  if (current.to_addresses?.length) lines.push(`To: ${current.to_addresses.join(', ')}`);
  if (current.subject) lines.push(`Subject: ${current.subject}`);
  lines.push(`Message-ID: ${current.message_id}`);
  if (current.date) lines.push(`Date: ${new Date(current.date).toUTCString()}`);
  if (override.inReplyTo) lines.push(`In-Reply-To: ${override.inReplyTo}`);
  if (override.references?.length) lines.push(`References: ${override.references.join(' ')}`);
  return { headers: lines.join('\r\n'), subject: current.subject };
}

function demoThreadingDiagnostics(id) {
  const current = messageById(id);
  // The real route answers 404 { error: 'Message not found' } for an unknown id, which the
  // real request() turns into a rejected promise (utils/api.js). Demo mode has no HTTP layer
  // to carry a status code, so it rejects the same way: throwing here makes demoRequest's
  // promise reject with the same message, and MessageHeaderModal's .catch() sees a real failure
  // instead of a silently empty diagnostics object.
  if (!current) throw new Error('Message not found');
  const threading = threadingOf(current);

  // Same grouping the list uses (thread_key), not the display strings above, which only
  // decorate one row.
  const sameThread = messages.filter(m => m.account_id === current.account_id && m.thread_key === current.thread_key);
  const byFolder = new Map();
  for (const m of sameThread) byFolder.set(m.folder, (byFolder.get(m.folder) || 0) + 1);
  const folders = [...byFolder.entries()]
    .map(([folder, count]) => ({ folder, count }))
    .sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));

  return {
    messageId: current.message_id,
    ...threading,
    mode: accountFor(current.account_id)?.thread_mode === 'gmail' ? 'gmail' : 'rfc',
    conversation: { total: new Set(sameThread.map(m => m.message_id)).size, folders },
  };
}

export async function demoRequest(method, path, body = {}) {
  const verb = method.toUpperCase();
  const url = parsePath(path);
  const pathname = url.pathname;

  if (verb === 'GET' && pathname === '/auth/config') return { mode: 'local', cloudflare: false, googleSignIn: false };
  if (verb === 'GET' && pathname === '/auth/me') return { user: clone(DEMO_USER) };
  if (verb === 'GET' && pathname === '/auth/preferences') return clone(preferences);
  if (verb === 'PATCH' && pathname === '/auth/preferences') {
    preferences = { ...preferences, ...clone(body) };
    return { ok: true };
  }
  if (verb === 'GET' && pathname === '/accounts') return clone(ACCOUNT_FIXTURES);
  // "Mailbox on our domain": the demo adds it to the account list for this page session.
  if (verb === 'POST' && pathname === '/accounts' && body?.kind === 'domain') return clone(createDomainMailbox(body));
  if (verb === 'POST' && pathname === '/oauth/google/start') return connectGmail(body);
  if (verb === 'GET' && pathname === '/oauth/google/known-emails') {
    const q = normalizeEmail(url.searchParams.get('q'));
    return { emails: KNOWN_GOOGLE_EMAILS.filter(email => email.includes(q) && !mailboxWithEmail(email)) };
  }

  const foldersMatch = pathname.match(/^\/accounts\/([^/]+)\/folders$/);
  if (verb === 'GET' && foldersMatch) return clone(foldersFor(decodeURIComponent(foldersMatch[1])));
  if (verb === 'GET' && /^\/accounts\/[^/]+\/aliases$/.test(pathname)) return [];

  if (verb === 'GET' && pathname === '/mail/unread-counts') return clone(unreadCounts());
  if (verb === 'GET' && pathname === '/mail/messages') return clone(listMessages(url));
  if (verb === 'GET' && (pathname === '/mail/search' || pathname === '/search')) {
    return clone({ ...listMessages(url, true), query: url.searchParams.get('q') || '' });
  }

  // Earlier letters with the same person in the same mailbox, as the server answers it.
  const historyMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/sender-history$/);
  if (verb === 'GET' && historyMatch) return clone(demoSenderHistory(decodeURIComponent(historyMatch[1])));

  // Why this letter is in its conversation, as the server answers it.
  const threadingMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/threading$/);
  if (verb === 'GET' && threadingMatch) return clone(demoThreadingDiagnostics(decodeURIComponent(threadingMatch[1])));

  const headersMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/headers$/);
  if (verb === 'GET' && headersMatch) return clone(demoHeaders(decodeURIComponent(headersMatch[1])));

  const bodyMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/body$/);
  if (verb === 'GET' && bodyMatch) {
    const item = messageById(decodeURIComponent(bodyMatch[1]));
    return item ? clone({
      html: item.body_html,
      text: item.body_text,
      attachments: item.has_attachments ? [{
        part: '1',
        filename: 'renewal-order-form.txt',
        type: 'text/plain',
        size: 45,
      }] : [],
      hasBlockedRemoteImages: false,
      senderEmail: item.from_email,
      senderName: item.from_name,
    }) : {};
  }

  const attachmentMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/attachments\/([^/]+)$/);
  if (verb === 'GET' && attachmentMatch) {
    const item = messageById(decodeURIComponent(attachmentMatch[1]));
    if (!item?.has_attachments || decodeURIComponent(attachmentMatch[2]) !== '1') return {};
    return {
      filename: 'renewal-order-form.txt',
      type: 'text/plain',
      content: 'Demo attachment: renewal order form preview.\n',
    };
  }

  const starMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/star$/);
  if (verb === 'PATCH' && starMatch) {
    const item = messageById(decodeURIComponent(starMatch[1]));
    if (item) item.is_starred = Boolean(body.starred);
    return { ok: true, is_starred: Boolean(body.starred) };
  }

  const spamMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/(spam|ham)$/);
  if (verb === 'POST' && spamMatch) {
    const folder = spamMatch[2] === 'spam' ? 'Spam' : 'INBOX';
    moveMessages([decodeURIComponent(spamMatch[1])], folder);
    return { ok: true, folder, newUid: null };
  }

  const categoryMatch = pathname.match(/^\/mail\/messages\/([^/]+)\/category$/);
  if (verb === 'PATCH' && categoryMatch) {
    const item = messageById(decodeURIComponent(categoryMatch[1]));
    if (item) item.category = body.category;
    return { ok: true, category: body.category };
  }

  const messageMatch = pathname.match(/^\/mail\/messages\/([^/]+)$/);
  if (verb === 'GET' && messageMatch) return clone(messageById(decodeURIComponent(messageMatch[1])) || {});
  if (verb === 'DELETE' && messageMatch) {
    const id = decodeURIComponent(messageMatch[1]);
    const item = messageById(id);
    if (item?.folder === 'Trash' || item?.folder === 'Drafts') messages = messages.filter(candidate => candidate.id !== id);
    else if (item) item.folder = 'Trash';
    return { ok: true };
  }

  const threadMatch = pathname.match(/^\/mail\/thread\/([^/]+)$/);
  if (verb === 'GET' && threadMatch) {
    const threadId = decodeURIComponent(threadMatch[1]);
    const accountId = url.searchParams.get('accountId');
    const result = visibleMessages()
      .filter(item => (item.thread_id === threadId || item.thread_key === threadId) && (!accountId || item.account_id === accountId))
      .sort((left, right) => new Date(left.date) - new Date(right.date));
    return { messages: clone(result) };
  }

  if (verb === 'GET' && pathname === '/mail/resolve-message') {
    const ref = url.searchParams.get('ref');
    const accountId = url.searchParams.get('accountId');
    const item = visibleMessages().find(candidate =>
      (candidate.id === ref || candidate.message_id === ref) && (!accountId || candidate.account_id === accountId));
    return clone(item || {});
  }

  if (verb === 'POST' && pathname === '/mail/messages/bulk-read') {
    const updated = [];
    for (const id of body.ids || []) {
      const item = messageById(id);
      if (item && item.is_read !== Boolean(body.read)) {
        item.is_read = Boolean(body.read);
        updated.push(id);
      }
    }
    return { ok: true, updated };
  }
  if (verb === 'POST' && pathname === '/mail/messages/bulk-delete') {
    return { ok: true, deleted: deleteMessages(body.ids) };
  }
  if (verb === 'POST' && pathname === '/mail/messages/bulk-move') {
    return { ok: true, moved: moveMessages(body.ids, body.folder) };
  }
  if (verb === 'POST' && pathname === '/mail/messages/bulk-archive') {
    return { ok: true, archived: moveMessages(body.ids, 'Archive'), noArchiveFolder: [] };
  }
  if (verb === 'POST' && pathname === '/mail/mark-all-read') {
    const updated = visibleMessages()
      .filter(item => item.account_id === body.accountId && item.folder === (body.folder || 'INBOX'))
      .map(item => { item.is_read = true; return item.id; });
    return { ok: true, updated };
  }

  if (verb === 'GET' && pathname === '/mail/category-counts') {
    const accountId = url.searchParams.get('accountId');
    const counts = {};
    for (const item of visibleMessages()) {
      if (item.folder !== 'INBOX' || item.is_read || (accountId && item.account_id !== accountId)) continue;
      const category = item.category || 'primary';
      counts[category] = (counts[category] || 0) + 1;
    }
    return { counts };
  }

  if (verb === 'POST' && pathname === '/mail/draft') return createDraft(body);
  const draftMatch = pathname.match(/^\/mail\/draft\/([^/]+)$/);
  if (verb === 'DELETE' && draftMatch) {
    const uid = Number(decodeURIComponent(draftMatch[1]));
    const accountId = url.searchParams.get('accountId');
    messages = messages.filter(item => !(item.uid === uid && item.account_id === accountId && item.folder === 'Drafts'));
    return { ok: true };
  }
  if (verb === 'POST' && pathname === '/mail/send') return sendMessage(body);

  if (verb === 'GET' && pathname === '/contacts') return clone(listContacts(url));
  if (verb === 'POST' && pathname === '/contacts') {
    const id = `demo-contact-${contacts.length + 1}`;
    const contact = contactFromPayload(body, { id, uid: id });
    contacts.push(contact);
    return clone(contact);
  }
  const contactMatch = pathname.match(/^\/contacts\/([^/]+)$/);
  if (verb === 'GET' && contactMatch) return clone(contacts.find(item => item.id === decodeURIComponent(contactMatch[1])) || {});
  if (verb === 'PATCH' && contactMatch) {
    const contact = contacts.find(item => item.id === decodeURIComponent(contactMatch[1]));
    if (contact) Object.assign(contact, contactFromPayload(body, contact));
    return clone(contact || {});
  }
  if (verb === 'DELETE' && contactMatch) {
    contacts = contacts.filter(item => item.id !== decodeURIComponent(contactMatch[1]));
    return { ok: true };
  }
  if (verb === 'GET' && pathname === '/search/contacts') {
    return clone({ contacts: listContacts(url).contacts });
  }

  if (verb === 'GET' && pathname === '/integrations') return {};
  if (verb === 'GET' && pathname === '/integrations/status') {
    return { google: { configured: true, available: true }, microsoft: { configured: false }, domainMail: { configured: true } };
  }
  if (verb === 'GET' && pathname === '/admin/google-apps') return { apps: [] };
  if (verb === 'GET' && pathname === '/mail-node/config') {
    return { configured: true, mailHost: 'mail.demo.mailexpert.local', apiKey: '•'.repeat(8), quotaMb: 5120, diskPingUrl: '' };
  }
  if (verb === 'PUT' && pathname === '/mail-node/config') return { ok: true };
  if (verb === 'GET' && pathname === '/mail-node/domains') return clone({ domains: mailNodeDomains });
  if (verb === 'POST' && pathname === '/mail-node/domains') {
    const domain = String(body?.domain || '').trim().toLowerCase();
    if (domain && !mailNodeDomains.some(d => d.domain === domain)) {
      mailNodeDomains = [...mailNodeDomains, { domain, active: true, maxMailboxes: Number(body?.mailboxes) || 500, mailboxes: 0 }];
    }
    return { ok: true, domain };
  }
  if (verb === 'GET' && pathname === '/mail-node/mailboxes') {
    return clone({ disk: { usedPercent: 41, used: '16G', total: '40G', warn: false }, mailboxes: mailNodeMailboxes });
  }
  const quotaMatch = pathname.match(/^\/mail-node\/mailboxes\/([^/]+)\/quota$/);
  if (verb === 'PUT' && quotaMatch) {
    const id = decodeURIComponent(quotaMatch[1]);
    mailNodeMailboxes = mailNodeMailboxes.map(m => (m.accountId === id ? { ...m, quotaMb: Number(body?.quotaMb) } : m));
    return { ok: true, quotaMb: Number(body?.quotaMb) };
  }
  if (verb === 'GET' && pathname === '/update') return { updateAvailable: false };
  if (verb === 'GET' && pathname === '/version') return { version: '3.3.0-demo', sha: 'demo' };
  if ((verb === 'POST' && pathname === '/oauth/microsoft/device')
    || (verb === 'GET' && pathname === '/oauth/microsoft/device/poll')) {
    return { disabled: true, configured: false };
  }
  if (verb === 'GET' && pathname === '/ai/status') return { enabled: false, configured: false };
  if (verb === 'GET' && pathname === '/admin/audit') {
    const { searchParams } = url;
    const entries = AUDIT_FIXTURES.filter((entry) => (
      (!searchParams.get('account') || entry.accountId === searchParams.get('account'))
      && (!searchParams.get('user') || entry.actorUserId === searchParams.get('user'))
      && (!searchParams.get('action') || entry.action === searchParams.get('action'))
    ));
    return { entries: clone(entries), nextCursor: null };
  }
  if (verb === 'GET' && pathname === '/admin/access-sync') return clone(accessSync);
  if (verb === 'PUT' && pathname === '/admin/access-sync') {
    accessSync.config = {
      enabled: !!body.enabled,
      accountId: String(body.accountId ?? '').trim(),
      appId: String(body.appId ?? '').trim(),
      policyId: String(body.policyId ?? '').trim(),
      apiTokenSet: accessSync.config.apiTokenSet || !!String(body.apiToken ?? '').trim(),
    };
    return clone(accessSync);
  }
  if (verb === 'POST' && pathname === '/admin/access-sync/run') {
    if (!accessSync.config.enabled) return { result: { outcome: 'not_configured' }, ...clone(accessSync) };
    const now = new Date().toISOString();
    accessSync.lastRun = {
      trigger: 'manual', startedAt: now, finishedAt: now, outcome: 'unchanged',
      added: 0, removed: 0, disabled: 0, wouldDisable: 0, error: null,
    };
    return { result: clone(accessSync.lastRun), ...clone(accessSync) };
  }
  if (verb === 'GET' && pathname === '/admin/ai') return { enabled: false, provider: null };
  if (verb === 'GET' && pathname === '/todoist/status') return { connected: false };
  if (verb === 'GET' && pathname === '/todoist/projects') return { projects: [] };
  if (verb === 'GET' && pathname === '/todoist/labels') return { labels: [] };
  if (verb === 'GET' && pathname === '/rules') return [];
  if (verb === 'GET' && pathname === '/block-list') return [];
  if (verb === 'GET' && pathname === '/categories/sources') return [];
  if (verb === 'GET' && pathname === '/gtd/sections') return { sections: [] };
  if (verb === 'GET' && pathname === '/plugins') return [];

  return { ok: true, demo: true };
}
