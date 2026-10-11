// The add-account dialog's provider and Proton onboarding, simulated for the demo. Nothing here
// connects anywhere: a password or a challenge answer is read only to check that one was typed and
// is dropped on arrival, and no attempt keeps it. The host (demo/index.js) hands in its own mailbox
// list and helpers, so this module holds the state machine alone.
//
// The address picks the Proton outcome: "bad" is refused, "hv" needs a human check, "2fa" and
// "second" ask a challenge that any non-empty answer satisfies, "smtp" passes the sign-in but
// fails the SMTP check, "offline" meets a Proton service that is switched off, anything else
// connects on the second poll. An address that already has a mailbox answers already_connected.

// The four fixed IMAP providers' safe metadata, as GET /integrations/status lists them.
export const DEMO_MAIL_PROVIDERS = [
  { id: 'yahoo', imap: { host: 'imap.mail.yahoo.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.mail.yahoo.com', port: 587, tls: 'starttls' }, appPasswordUrl: 'https://login.yahoo.com/account/security', publicDomains: ['yahoo.com', 'ymail.com', 'rocketmail.com'], loginAlternatives: { imap: ['full_address'], smtp: ['full_address'] } },
  { id: 'yandex', imap: { host: 'imap.yandex.ru', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.yandex.ru', port: 465, tls: 'implicit' }, appPasswordUrl: 'https://id.yandex.ru/security', publicDomains: ['yandex.ru', 'ya.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'yandex.com.tr'], loginAlternatives: { imap: ['full_address', 'local_part_public_domain'], smtp: ['full_address', 'local_part_public_domain'] } },
  { id: 'mailru', imap: { host: 'imap.mail.ru', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.mail.ru', port: 465, tls: 'implicit' }, appPasswordUrl: 'https://account.mail.ru/user/2-step-auth/passwords/', publicDomains: ['mail.ru', 'bk.ru', 'list.ru', 'inbox.ru', 'internet.ru'], loginAlternatives: { imap: ['full_address'], smtp: ['full_address'] } },
  { id: 'icloud', imap: { host: 'imap.mail.me.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp.mail.me.com', port: 587, tls: 'starttls' }, appPasswordUrl: 'https://account.apple.com/', publicDomains: ['icloud.com', 'me.com', 'mac.com'], loginAlternatives: { imap: ['full_address', 'local_part'], smtp: ['full_address'] } },
];

const TERMINAL = ['connected', 'failed', 'cancelled', 'expired'];
const ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function createProviderDemo({ accounts, clone, demoError, normalizeEmail, mailboxWithEmail, welcomeLetter }) {
  const attempts = new Map();
  let sequence = 1;

  // POST /accounts/provider: a mailbox of a fixed provider, without any connection.
  function createProviderMailbox(body) {
    const provider = DEMO_MAIL_PROVIDERS.find(p => p.id === body?.provider);
    const email = normalizeEmail(body?.email);
    if (!provider || !ADDRESS.test(email) || typeof body?.appPassword !== 'string' || !body.appPassword) {
      throw demoError('invalid_request', 'invalid_request');
    }
    if (mailboxWithEmail(email)) throw demoError('already_connected', 'already_connected');
    const account = {
      ...clone(accounts[0]), id: `demo-${provider.id}-${email}`, name: String(body.name ?? '').trim() || email,
      sender_name: body.senderName || null, email_address: email, color: body.color || '#6366f1',
      imap_host: provider.imap.host, imap_port: provider.imap.port, smtp_host: provider.smtp.host, smtp_port: provider.smtp.port,
      smtp_tls: provider.smtp.tls === 'implicit' ? 'SSL' : 'STARTTLS', imap_tls_mode: provider.imap.tls,
      mail_provider: provider.id, connection_mode: 'preset', can_reconnect_proton: false, proton_status: null, health: 'healthy',
      aliases: [], signature: body.signature || null, sort_order: accounts.length, mail_node: false, thread_mode: 'rfc',
    };
    accounts.push(account);
    welcomeLetter(account);
    return account;
  }

  function status(attempt) {
    return attempt.account
      ? { id: attempt.id, state: attempt.state, account: clone(attempt.account) }
      : { id: attempt.id, state: attempt.state, ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}) };
  }

  // POST /accounts/proton/connect. The attempt id is body.requestId; a replay answers the same attempt.
  function startProton(body) {
    const email = normalizeEmail(body?.email);
    if (!ADDRESS.test(email) || typeof body?.password !== 'string' || !body.password || !body?.requestId) {
      throw demoError('invalid_request', 'invalid_request');
    }
    const replay = [...attempts.values()].find(a => a.requestId === body.requestId);
    if (replay) return status(replay);
    const local = email.split('@')[0];
    if (local.includes('offline')) return { id: `demo-proton-${sequence++}`, state: 'failed', errorCode: 'proton_unavailable' };
    if (mailboxWithEmail(email) && !body.reconnectAccountId) {
      return { id: `demo-proton-${sequence++}`, state: 'failed', errorCode: 'already_connected' };
    }
    const attempt = {
      id: `demo-proton-${sequence++}`, requestId: body.requestId, email, polls: 0, state: 'authenticating',
      challenge: local.includes('2fa') ? '2fa' : local.includes('second') ? 'second_password' : null,
      reconnectAccountId: body.reconnectAccountId || null,
      metadata: { name: body.name, senderName: body.senderName, color: body.color, signature: body.signature },
    };
    attempts.set(attempt.id, attempt);
    return status(attempt);
  }

  function advance(attempt) {
    if (TERMINAL.includes(attempt.state)) return;
    attempt.polls += 1;
    const local = attempt.email.split('@')[0];
    if (local.includes('bad')) { attempt.state = 'failed'; attempt.errorCode = 'invalid_credentials'; return; }
    if (local.includes('hv')) { attempt.state = 'failed'; attempt.errorCode = 'verification_required'; return; }
    if (attempt.challenge && !attempt.answered) { attempt.state = attempt.challenge === '2fa' ? 'needs_2fa' : 'needs_second_password'; return; }
    if (attempt.polls < 2 && !attempt.answered) { attempt.state = 'checking'; return; }
    if (local.includes('smtp')) { attempt.state = 'failed'; attempt.errorCode = 'smtp_unavailable'; return; }
    const existing = attempt.reconnectAccountId ? accounts.find(a => a.id === attempt.reconnectAccountId) : null;
    // A reconnect gives the shared mailbox its session back, whoever of the team signed in again.
    if (existing) Object.assign(existing, { health: 'healthy', proton_status: null, sync_error: null });
    const account = existing || {
      ...clone(accounts[0]), id: `demo-proton-account-${attempt.email}`, name: String(attempt.metadata.name ?? '').trim() || attempt.email,
      sender_name: attempt.metadata.senderName || null, email_address: attempt.email, color: attempt.metadata.color || '#6d4aff',
      imap_host: '127.0.0.1', imap_port: 1993, smtp_host: '127.0.0.1', smtp_port: 1465, smtp_tls: 'SSL', imap_tls_mode: 'implicit',
      mail_provider: 'proton', connection_mode: 'managed', can_reconnect_proton: true, proton_status: null, health: 'healthy',
      aliases: [], signature: attempt.metadata.signature || null, sort_order: accounts.length, mail_node: false, thread_mode: 'rfc',
    };
    if (!existing) { accounts.push(account); welcomeLetter(account); }
    attempt.state = 'connected';
    attempt.account = account;
  }

  // GET /accounts/proton/connect/:id, POST .../continue and POST .../cancel. `action` is '/continue',
  // '/cancel' or undefined; returns undefined for a verb the route does not have.
  function protonAttemptRequest(verb, id, action, body) {
    const attempt = attempts.get(id);
    if (!attempt) throw demoError('not_found', 'not_found');
    if (verb === 'GET' && !action) { advance(attempt); return status(attempt); }
    if (verb === 'POST' && action === '/continue') {
      const expected = attempt.state === 'needs_2fa' ? '2fa' : attempt.state === 'needs_second_password' ? 'second_password' : null;
      if (!expected || body?.challenge !== expected || typeof body?.secret !== 'string' || !body.secret) {
        throw demoError('invalid_challenge', 'invalid_challenge');
      }
      attempt.answered = true;
      attempt.state = 'checking';
      return status(attempt);
    }
    if (verb === 'POST' && action === '/cancel') {
      if (!['connected', 'failed'].includes(attempt.state)) attempt.state = 'cancelled';
      return status(attempt);
    }
    return undefined;
  }

  return { createProviderMailbox, startProton, protonAttemptRequest };
}
