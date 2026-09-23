// Load check of the panel against a real mailcow (scripts/deploy/test/e2e-mailcow.sh --scenario
// load). Runs in the backend image next to the panel, in phases the shell script sequences:
//
//   PHASE=setup      admin, mail node, one domain, MAILBOXES mailboxes; time until all connected
//   PHASE=delivery   one letter to every mailbox; time until each shows it in MailExpert
//   PHASE=restart    after the script restarted the backend: time until all connected again
//   PHASE=sessions   10 sessions of the shared user: a read flag set in one is seen by the rest
//
// Each phase prints one `RESULT {json}` line. Env: PANEL, MAIL_HOST, API_KEY, MAILBOXES, DOMAIN.
//
// LOAD_KIND=gmail runs the same phases with the mailboxes added the way a Gmail mailbox is: IMAP
// imap.gmail.com:993 and SMTP smtp.gmail.com:587, names the script points at the mailcow node. The
// panel then applies its Gmail rules (provider profile: pool size, background connections per
// host, status on the pool, connect stagger, IMAP_MAX_PERSISTENT_PER_HOST when set). What it cannot
// show: Google's own limits and throttling, OAuth token refresh, X-GM-THRID threading.
import assert from 'node:assert/strict';

const { PANEL, MAIL_HOST, API_KEY, PHASE } = process.env;
const GMAIL = process.env.LOAD_KIND === 'gmail';
const GMAIL_IMAP = 'imap.gmail.com';
const GMAIL_SMTP = 'smtp.gmail.com';
const BOX_PASSWORD = 'e2e-Gmail-like-password-1';
const MAILBOXES = Number(process.env.MAILBOXES || 100);
const DOMAIN = process.env.DOMAIN;
const USER = { username: 'admin', password: 'e2e-admin-password-1' };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const seconds = (ms) => Math.round(ms / 100) / 10;

class Session {
  constructor() { this.cookie = ''; }

  async call(method, path, body) {
    const res = await fetch(`${PANEL}/api${path}`, {
      method,
      headers: {
        'X-Requested-With': 'MailExpert',
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  }

  async login() {
    const r = await this.call('POST', '/auth/login', USER);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return this;
  }
}

function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { p50: at(50), p95: at(95), max: sorted[sorted.length - 1] };
}

// The mailboxes under test: the mail node's, or the Gmail-like ones.
const nodeAccounts = async (s) => (await s.call('GET', '/accounts')).data
  .filter((a) => (GMAIL ? a.imap_host === GMAIL_IMAP : a.mail_node));

// A mailbox created straight in mailcow with a known password, for adding it as a Gmail account.
async function mailcowMailbox(localPart, domain) {
  const res = await fetch(`https://${MAIL_HOST}/api/v1/add/mailbox`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      local_part: localPart, domain, name: localPart, quota: 1024, active: '1',
      password: BOX_PASSWORD, password2: BOX_PASSWORD, force_pw_update: '0', tls_enforce_in: '0', tls_enforce_out: '0',
    }),
  });
  const body = await res.json().catch(() => null);
  const ok = res.ok && Array.isArray(body) && body.every((entry) => entry.type === 'success');
  assert.ok(ok, `mailcow add/mailbox ${localPart}@${domain}: ${res.status} ${JSON.stringify(body)}`);
}

async function addGmailLikeAccount(s, email) {
  return s.call('POST', '/accounts', {
    name: email, email_address: email,
    imap_host: GMAIL_IMAP, imap_port: 993,
    smtp_host: GMAIL_SMTP, smtp_port: 587, smtp_tls: 'STARTTLS',
    auth_user: email, auth_pass: BOX_PASSWORD,
  });
}

// Connected: the row has a first sync and no error. Returns seconds from `since` for each mailbox.
async function waitConnected(s, since, timeoutMs) {
  const done = new Map();
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const a of await nodeAccounts(s)) {
      if (!done.has(a.id) && a.last_sync && !a.sync_error && new Date(a.last_sync).getTime() >= since) {
        done.set(a.id, Date.now() - since);
      }
    }
    if (done.size >= MAILBOXES) break;
    await sleep(1000);
  }
  const errors = (await nodeAccounts(s)).filter((a) => a.sync_error).map((a) => `${a.email_address}: ${a.sync_error}`);
  return { connected: done.size, times: [...done.values()], errors };
}

const result = (data) => console.log(`RESULT ${JSON.stringify({ phase: PHASE, ...data })}`);

// Before anything logs in: the Gmail names must lead to the node, never to the real Gmail.
if (GMAIL) {
  const { resolve4 } = await import('node:dns/promises');
  for (const host of [GMAIL_IMAP, GMAIL_SMTP]) {
    const ips = await resolve4(host);
    assert.deepEqual(ips, [process.env.GMAIL_IP], `${host} resolves to ${ips.join(', ')}, not the node`);
  }
}

if (PHASE === 'setup') {
  const s = new Session();
  let r = await s.call('POST', '/auth/register', USER);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await s.call('PATCH', '/admin/settings', { allow_private_hosts: true });
  assert.equal(r.status, 200);
  r = await s.call('PUT', '/mail-node/config', { mailHost: MAIL_HOST, apiKey: API_KEY, quotaMb: 5120 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await s.call('POST', '/mail-node/domains', { domain: DOMAIN, mailboxes: MAILBOXES + 10 });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const since = Date.now();
  const createMs = [];
  for (let i = 0; i < MAILBOXES; i++) {
    const localPart = `box${String(i).padStart(3, '0')}`;
    if (GMAIL) await mailcowMailbox(localPart, DOMAIN);
    const t0 = Date.now();
    r = GMAIL
      ? await addGmailLikeAccount(s, `${localPart}@${DOMAIN}`)
      : await s.call('POST', '/accounts', { kind: 'domain', localPart, domain: DOMAIN });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    createMs.push(Date.now() - t0);
  }
  const created = Date.now() - since;
  const c = await waitConnected(s, since, 600000);
  result({
    kind: GMAIL ? 'gmail' : 'node',
    mailboxes: MAILBOXES,
    createSeconds: seconds(created),
    createPerMailboxMs: percentiles(createMs),
    connected: c.connected,
    connectSeconds: c.times.length ? percentiles(c.times.map(seconds)) : null,
    errors: c.errors.slice(0, 5),
  });
  assert.equal(c.connected, MAILBOXES, `only ${c.connected} of ${MAILBOXES} connected`);
}

if (PHASE === 'delivery') {
  const s = await new Session().login();
  const accounts = await nodeAccounts(s);
  const sender = accounts[0];
  const subject = `load ${Date.now()}`;
  const recipients = accounts.map((a) => a.email_address);
  const since = Date.now();
  const r = await s.call('POST', '/mail/send', { accountId: sender.id, to: [sender.email_address], bcc: recipients.slice(1), subject, body: 'Load check.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const seen = new Map();
  const end = Date.now() + 600000;
  while (seen.size < accounts.length && Date.now() < end) {
    await Promise.all(accounts.filter((a) => !seen.has(a.id)).map(async (a) => {
      const { data } = await s.call('GET', `/mail/messages?accountId=${a.id}&folder=INBOX&limit=5`);
      if (data?.messages?.some((m) => m.subject === subject)) seen.set(a.id, Date.now() - since);
    }));
    await sleep(1000);
  }
  const listMs = [];
  for (let i = 0; i < 20; i++) {
    const t0 = Date.now();
    await s.call('GET', '/accounts');
    await s.call('GET', '/mail/unread-counts');
    listMs.push(Date.now() - t0);
  }
  result({
    delivered: seen.size,
    of: accounts.length,
    seenAfterSeconds: seen.size ? percentiles([...seen.values()].map(seconds)) : null,
    accountsAndUnreadMs: percentiles(listMs),
  });
  assert.equal(seen.size, accounts.length, `only ${seen.size} of ${accounts.length} showed the letter`);
}

if (PHASE === 'restart') {
  const since = Number(process.env.RESTARTED_AT);
  const s = await new Session().login();
  const c = await waitConnected(s, since, 600000);
  result({
    connected: c.connected,
    reconnectSeconds: c.times.length ? percentiles(c.times.map(seconds)) : null,
    errors: c.errors.slice(0, 5),
  });
  assert.equal(c.connected, MAILBOXES, `only ${c.connected} of ${MAILBOXES} reconnected`);
}

if (PHASE === 'sessions') {
  const sessions = await Promise.all(Array.from({ length: 10 }, () => new Session().login()));
  const [first] = sessions;
  const accounts = await nodeAccounts(first);
  // Each session works in its own mailbox at the same time, like ten managers.
  const perSession = await Promise.all(sessions.map(async (s, i) => {
    const account = accounts[i % accounts.length];
    const { data } = await s.call('GET', `/mail/messages?accountId=${account.id}&folder=INBOX&limit=50`);
    return { account, message: data.messages[0] };
  }));
  // Session 0 marks its letter read; every other session must see it read.
  const target = perSession[0];
  const r = await first.call('POST', '/mail/messages/bulk-read', { ids: [target.message.id], read: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const views = await Promise.all(sessions.slice(1).map(async (s) => {
    const { data } = await s.call('GET', `/mail/messages?accountId=${target.account.id}&folder=INBOX&limit=50`);
    return data.messages.find((m) => m.id === target.message.id)?.is_read;
  }));
  result({ sessions: sessions.length, othersSeeRead: views.filter(Boolean).length });
  assert.equal(views.every(Boolean), true, 'a session did not see the read flag');
}
