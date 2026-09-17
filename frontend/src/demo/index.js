const ACCOUNT_FIXTURES = [
  {
    id: 'demo-sales',
    name: 'Sales Team',
    sender_name: 'MailExpert Sales',
    email_address: 'sales@demo.mailexpert.local',
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
  bodyText = snippet,
}) {
  const account = ACCOUNT_FIXTURES.find(item => item.id === accountId);
  return {
    id,
    uid: Number(id.replace(/\D/g, '')) || 1,
    message_id: `<${id}@demo.mailexpert.local>`,
    thread_id: threadId,
    thread_key: threadId,
    account_id: account.id,
    account_name: account.name,
    account_email: account.email_address,
    account_color: account.color,
    folder,
    subject,
    from_name: fromName,
    from_email: fromEmail,
    to_addresses: toAddresses || [account.email_address],
    cc_addresses: [],
    date,
    snippet,
    is_read: read,
    is_starred: starred,
    has_attachments: attachments,
    category,
    body_html: `<p>${bodyText}</p>`,
    body_text: bodyText,
  };
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
];

const CONTACT_FIXTURES = [
  {
    id: 'demo-contact-1', uid: 'demo-contact-1', display_name: 'Maya Chen', first_name: 'Maya', last_name: 'Chen',
    primary_email: 'maya.chen@northstar.example',
    emails: [{ value: 'maya.chen@northstar.example', type: 'work', primary: true }],
    phones: [{ value: '+1 555 0142', type: 'work', primary: true }],
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
  if (query) {
    result = result.filter(item => [item.subject, item.from_name, item.from_email, item.snippet, item.body_text]
      .some(value => String(value || '').toLocaleLowerCase().includes(query)));
  }
  result.sort((left, right) => new Date(right.date) - new Date(left.date));
  return { messages: result.slice(offset, offset + limit), total: result.length };
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
    result = result.filter(contact => [contact.display_name, contact.primary_email, contact.organization]
      .some(value => String(value || '').toLocaleLowerCase().includes(query)));
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

  const foldersMatch = pathname.match(/^\/accounts\/([^/]+)\/folders$/);
  if (verb === 'GET' && foldersMatch) return clone(foldersFor(decodeURIComponent(foldersMatch[1])));
  if (verb === 'GET' && /^\/accounts\/[^/]+\/aliases$/.test(pathname)) return [];

  if (verb === 'GET' && pathname === '/mail/unread-counts') return clone(unreadCounts());
  if (verb === 'GET' && pathname === '/mail/messages') return clone(listMessages(url));
  if (verb === 'GET' && (pathname === '/mail/search' || pathname === '/search')) {
    return clone({ ...listMessages(url, true), query: url.searchParams.get('q') || '' });
  }

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
    const result = visibleMessages()
      .filter(item => item.thread_id === threadId || item.thread_key === threadId)
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
  if (verb === 'GET' && pathname === '/integrations/status') return { google: { configured: false }, microsoft: { configured: false } };
  if (verb === 'GET' && pathname === '/update') return { updateAvailable: false };
  if (verb === 'GET' && pathname === '/version') return { version: '3.3.0-demo', sha: 'demo' };
  if ((verb === 'POST' && pathname === '/oauth/microsoft/device')
    || (verb === 'GET' && pathname === '/oauth/microsoft/device/poll')) {
    return { disabled: true, configured: false };
  }
  if (verb === 'GET' && pathname === '/ai/status') return { enabled: false, configured: false };
  if (verb === 'GET' && pathname === '/admin/ai') return { enabled: false, provider: null };
  if (verb === 'GET' && pathname === '/todoist/status') return { connected: false };
  if (verb === 'GET' && pathname === '/todoist/projects') return { projects: [] };
  if (verb === 'GET' && pathname === '/todoist/labels') return { labels: [] };
  if (verb === 'GET' && pathname === '/rules') return [];
  if (verb === 'GET' && pathname === '/block-list') return [];
  if (verb === 'GET' && pathname === '/categories/sources') return [];
  if (verb === 'GET' && pathname === '/gtd/sections') return { sections: [] };
  if (verb === 'GET' && pathname === '/plugins') return [];
  if (verb === 'GET' && pathname.endsWith('/headers')) return { headers: [] };

  return { ok: true, demo: true };
}
