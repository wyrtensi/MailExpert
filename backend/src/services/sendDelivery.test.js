import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// What becomes of a send job when the mail server answers: delivered, retried (certainly nothing
// was delivered and it may pass), failed (certainly nothing was delivered, and it will not pass), or
// needs attention (the letter may have been accepted). The send queue applies the outcome
// (services/jobQueue.js); here the transport is a mock.
vi.mock('./auditLog.js', () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));
vi.mock('./deliveryStatus.js', async (importOriginal) => ({ ...(await importOriginal()), recordOutcomes: vi.fn(async () => 1) }));
import { query } from './db.js';
import { recordOutcomes } from './deliveryStatus.js';
import { createAccountSmtpTransport } from './smtpTransport.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { deliverOutgoingMessage, refusedRecipients } from './sendDelivery.js';

const account = {
  id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: 'microsoft', // non-Gmail OAuth: exercises serverAutoSaves without the Gmail-API send path
  smtp_host: 'smtp.gmail.com', smtp_port: 465,
};
const sendMail = vi.fn();
const markEffectStarted = vi.fn(async () => {});
const onDelivered = vi.fn(async () => {});
const imapManager = { syncFolderOnDemand: vi.fn(async () => {}), findUidByMessageId: vi.fn(async () => null) };

const mail = (recipients = { to: ['you@example.com'] }) => {
  const to = recipients.to ?? [];
  const cc = recipients.cc ?? [];
  const bcc = recipients.bcc ?? [];
  return {
    options: {
      messageId: '<m1@example.com>', from: 'Me <me@example.com>',
      to: to.join(', ') || undefined, cc: cc.join(', ') || undefined, bcc: bcc.join(', ') || undefined,
      subject: 'Test', text: 'Hello',
    },
    meta: { to, cc, bcc, subject: 'Test', fromName: 'Me', fromEmail: 'me@example.com', snippet: 'Hello' },
  };
};
const deliver = (recipients) => deliverOutgoingMessage({ account, mail: mail(recipients), actorUserId: 'u1', imapManager, markEffectStarted, onDelivered });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  query.mockImplementation(async () => ({ rows: [{ id: 'book1' }] }));
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
  sendMail.mockResolvedValue({});
  resolveSentFolder.mockResolvedValue(null);
});

describe('a delivered letter', () => {
  it('marks the effect before handing it over and reports it delivered by its Message-ID', async () => {
    sendMail.mockImplementation(async () => {
      expect(markEffectStarted).toHaveBeenCalledOnce();
      expect(onDelivered).not.toHaveBeenCalled();
      return {};
    });
    const result = await deliver();
    expect(onDelivered).toHaveBeenCalledWith('<m1@example.com>', { rejected: [] });
    expect(result).toEqual({ messageId: '<m1@example.com>', rejected: [], sentFolder: null, sentCopySaved: null });
    expect(recordOutcomes).not.toHaveBeenCalled();
  });

  it('stays delivered, with a Sent-copy warning, after a post-delivery failure', async () => {
    resolveSentFolder.mockRejectedValueOnce(new Error('database unavailable'));
    const result = await deliver();
    expect(result.sentCopySaved).toBe(false);
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it('stays delivered when recording the delivery fails', async () => {
    onDelivered.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(deliver()).resolves.toMatchObject({ messageId: '<m1@example.com>' });
  });

  it('sends a message addressed only in Bcc without an empty To header', async () => {
    await deliver({ to: [], bcc: ['hidden@example.com'] });
    const options = sendMail.mock.calls[0][0];
    expect(options.to).toBeUndefined();
    expect(options.bcc).toContain('hidden@example.com');
  });
});

// The server took the letter but refused some recipients at RCPT (upstream maathimself/mailflow#518):
// nodemailer resolves, with the refusals in info.rejected / info.rejectedErrors.
describe('recipients the server refused while it took the letter', () => {
  const refusal = (recipient, response, responseCode = 550) => Object.assign(new Error(`Recipient command failed: ${response}`), {
    code: 'EENVELOPE', command: 'RCPT TO', recipient, response, responseCode,
  });

  it('delivers to the others and reports, records and logs the refused ones', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendMail.mockResolvedValueOnce({
      accepted: ['you@example.com'],
      rejected: ['Gone@Example.com'],
      rejectedErrors: [refusal('Gone@Example.com', '550 5.1.1 <Gone@Example.com>: Recipient address rejected: User unknown')],
    });
    const result = await deliver({ to: ['you@example.com', 'Gone <Gone@Example.com>'] });
    expect(onDelivered).toHaveBeenCalledWith('<m1@example.com>', { rejected: ['gone@example.com'] });
    expect(result.rejected).toEqual(['gone@example.com']);
    expect(recordOutcomes).toHaveBeenCalledWith('a1', '<m1@example.com>', 'submission', [{
      recipient: 'gone@example.com', state: 'failed', at: expect.any(String), statusCode: '5.1.1',
      diagnostic: '550 5.1.1 <Gone@Example.com>: Recipient address rejected: User unknown',
      details: { reply: '550 5.1.1 <Gone@Example.com>: Recipient address rejected: User unknown', responseCode: 550 },
    }]);
    // The log names the codes, never the server's reply (it repeats the address unredacted).
    const line = console.warn.mock.calls.map(c => c.join(' ')).find(l => l.includes('SMTP refused'));
    expect(line).toContain('5.1.1');
    expect(line).not.toContain('Gone@Example.com');
    expect(line).not.toContain('gone@example.com');
    // Only the accepted recipient is learned as a contact.
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    const learned = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO contacts')).map(([, params]) => params[5]);
    expect(learned).toContain('you@example.com');
    expect(learned).not.toContain('gone@example.com');
  });

  it('stays delivered when recording the refusals fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    recordOutcomes.mockRejectedValueOnce(new Error('database unavailable'));
    sendMail.mockResolvedValueOnce({ rejected: ['gone@example.com'], rejectedErrors: [refusal('gone@example.com', '550 No such user')] });
    await expect(deliver()).resolves.toMatchObject({ messageId: '<m1@example.com>', rejected: ['gone@example.com'] });
  });
});

describe('refusedRecipients', () => {
  it('pairs each refused address with its reply, and falls back to the basic code', () => {
    expect(refusedRecipients({
      rejected: ['a@example.com', 'b@example.com', 'a@example.com'],
      rejectedErrors: [{ recipient: 'b@example.com', response: '554 Relay access denied', responseCode: 554 }],
    })).toEqual([
      { recipient: 'a@example.com', statusCode: null, diagnostic: null, responseCode: null },
      { recipient: 'b@example.com', statusCode: '554', diagnostic: '554 Relay access denied', responseCode: 554 },
    ]);
  });

  it('finds nothing in a send without refusals, or in the Gmail API answer', () => {
    expect(refusedRecipients({})).toEqual([]);
    expect(refusedRecipients(undefined)).toEqual([]);
    expect(refusedRecipients({ via: 'api', messageId: '<m@x>' })).toEqual([]);
  });
});

describe('a failure that certainly delivered nothing', () => {
  it('fails on an SMTP rejection', async () => {
    // nodemailer puts the server's reply code on the error; a reply means DATA was not accepted.
    sendMail.mockRejectedValueOnce(Object.assign(new Error('Message failed: 550 rejected'), { code: 'EMESSAGE', responseCode: 550, command: 'DATA' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'fail', code: 'smtp_rejected', message: 'Message was rejected by the mail server.' });
    expect(onDelivered).not.toHaveBeenCalled();
  });

  it('retries a temporary SMTP reply', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('451 4.7.1 Greylisted, try again later'), { code: 'EENVELOPE', responseCode: 451, command: 'RCPT TO' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'retry', code: 'smtp_temporary' });
  });

  it('retries when the server could not be reached, with a specific host:port error', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:587'), { code: 'ESOCKET', command: 'CONN' }));
    await expect(deliver()).rejects.toMatchObject({
      jobOutcome: 'retry', code: 'smtp_connection_failed',
      message: "Could not connect to smtp.gmail.com:465 (connection refused). The server's network may block outgoing mail ports.",
    });
  });

  it('retries when connecting times out, or DNS or TLS fails', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT', command: 'CONN' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'retry', code: 'smtp_connection_failed', message: expect.stringContaining('(timed out)') });
    sendMail.mockRejectedValueOnce(Object.assign(new Error('getaddrinfo ENOTFOUND smtp.gmail.com'), { code: 'EDNS', command: 'CONN' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'retry', message: expect.stringContaining('(host not found)') });
    sendMail.mockRejectedValueOnce(Object.assign(new Error('Error initiating TLS - self signed certificate'), { code: 'ETLS', command: 'CONN' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'retry', message: expect.stringContaining('(TLS handshake failed)') });
  });

  it('fails on an auth rejection with the generic message', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('Invalid login: 535 5.7.8 authentication failed'), { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'fail', code: 'smtp_auth_failed', message: 'Authentication failed. Check your email account credentials.' });
  });
});

describe('a failure that may have delivered the letter', () => {
  it('needs attention when the connection breaks with no server reply', async () => {
    // nodemailer tags a mid-session close as CONN too, so it may come after DATA was accepted.
    sendMail.mockRejectedValueOnce(Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION', command: 'CONN' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'needs_attention', code: 'send_uncertain' });
    expect(markEffectStarted).toHaveBeenCalledOnce();
  });
});

describe('OAuth reconnect-required on send', () => {
  it('fails before the effect when the transport cannot be set up', async () => {
    createAccountSmtpTransport.mockResolvedValueOnce({
      status: 409, code: 'oauth_reconnect_required',
      error: 'Access to this account was revoked or has expired. Reconnect the account to send mail.',
    });
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'fail', code: 'oauth_reconnect_required' });
    expect(markEffectStarted).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('fails when a forced refresh during the send needs a reconnect', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('OAuth access was revoked or expired — reconnect the account'), { name: 'OAuthTokenError', code: 'oauth_reconnect_required' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'fail', code: 'oauth_reconnect_required' });
  });

  it('retries a transient refresh failure during the send', async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error('OAuth token refresh failed: oauth_refresh_failed'), { name: 'OAuthTokenError', code: 'oauth_refresh_failed' }));
    await expect(deliver()).rejects.toMatchObject({ jobOutcome: 'retry', code: 'oauth_refresh_failed' });
  });
});

// Bridge files the Sent copy of a letter sent through it (the spike saw exactly one), so a managed
// Proton mailbox skips the APPEND. Only the database link proves the mailbox is managed: the
// provider columns of the row alone do not.
describe('the Sent copy of a managed Proton mailbox', () => {
  const PROTON_ID = '71000000-0000-4000-8000-000000000001';
  const protonAccount = {
    id: PROTON_ID, email_address: 'box@proton.me', name: 'Box', mail_provider: 'proton', connection_mode: 'managed',
    smtp_host: '127.0.0.1', smtp_port: 1465, imap_host: '127.0.0.1', imap_port: 1993,
  };
  const appendToSent = vi.fn(async () => ({ uid: null }));
  const protonImap = { ...imapManager, appendToSent, upsertSentMessageRecord: vi.fn(async () => {}) };
  const sendAs = (sender, linked) => {
    query.mockImplementation(async (sql) => (/proton_mailbox_links/.test(sql) ? { rows: linked ? [{ linked: 1 }] : [] } : { rows: [{ id: 'book1' }] }));
    createAccountSmtpTransport.mockResolvedValue({ account: sender, transport: { sendMail } });
    return deliverOutgoingMessage({ account: sender, mail: mail(), actorUserId: 'u1', imapManager: protonImap, markEffectStarted, onDelivered });
  };
  const linkQueries = () => query.mock.calls.filter(([sql]) => /proton_mailbox_links/.test(sql));

  beforeEach(() => {
    // Only the post-send timers (Sent sync, APPEND bound); nodemailer's stream needs the real queue.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    resolveSentFolder.mockResolvedValue('Sent');
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('managed_proton_sent_is_single_copy', async () => {
    const result = await sendAs(protonAccount, true);
    expect(sendMail).toHaveBeenCalledOnce();
    expect(appendToSent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sentFolder: 'Sent', sentCopySaved: null });
    expect(linkQueries()).toHaveLength(1);
    expect(linkQueries()[0][1]).toEqual([PROTON_ID]);
    // The link is checked before the letter goes out.
    expect(query.mock.invocationCallOrder[query.mock.calls.indexOf(linkQueries()[0])]).toBeLessThan(sendMail.mock.invocationCallOrder[0]);
  });

  it('spoofed_label_keeps_normal_sent_append', async () => {
    // Managed provider columns without a link in the database.
    await sendAs(protonAccount, false);
    expect(appendToSent).toHaveBeenCalledOnce();
    expect(appendToSent.mock.calls[0][1]).toBe('Sent');

    // A Proton mailbox added with ordinary settings never asks for the link at all.
    appendToSent.mockClear();
    query.mockClear();
    await sendAs({ ...protonAccount, connection_mode: 'preset' }, true);
    expect(appendToSent).toHaveBeenCalledOnce();
    expect(linkQueries()).toEqual([]);
  });
});
