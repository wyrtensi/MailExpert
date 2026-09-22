import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { uuidParam } from '../utils/uuid.js';
import { DISK_WARN_PERCENT, checkMailNodeDisk } from '../services/mailNode/diskWatch.js';
import {
  DEFAULT_DOMAIN_MAILBOXES,
  DEFAULT_QUOTA_MB,
  MAX_DOMAIN_MAILBOXES,
  MAX_QUOTA_MB,
  MailNodeError,
  addDomain,
  getDiskStatus,
  getMailNodeConfig,
  listDomains,
  listMailboxes,
  parseHostName,
  parsePingUrl,
  parseWholeNumber,
  saveMailNodeConfig,
  setMailboxQuota,
} from '../services/mailNode/mailcow.js';

// The mail node (mailcow) settings, its domains and the quotas of the mailboxes MailExpert made
// there. Mounted at /api/mail-node. Everyone signed in may list domains (the add-mailbox form
// offers them); everything else is for administrators.
const router = Router();
router.param('id', uuidParam('id'));

// Sent instead of the stored API key; posting it back keeps the stored key.
const REDACTED_SECRET = '••••••••';

const ERRORS = {
  mail_host_invalid: [400, 'Mail host must be a host name such as mail.example.com'],
  api_key_required: [400, 'API key is required'],
  quota_invalid: [400, `Quota must be a whole number of MB from 1 to ${MAX_QUOTA_MB}`],
  domain_invalid: [400, 'Domain must be a domain name such as example.com'],
  ping_url_invalid: [400, 'Ping URL must be an https address'],
  mailboxes_invalid: [400, `Mailbox limit must be a whole number from 1 to ${MAX_DOMAIN_MAILBOXES}`],
  mail_node_not_configured: [409, 'The mail node is not set up'],
  mailbox_not_found: [404, 'Mail node mailbox not found'],
};

export function refuse(res, code) {
  const [status, error] = ERRORS[code];
  return res.status(status).json({ error, code });
}

// A mailcow failure: 502, the node's own message and a code the screens translate.
export function mailNodeFailure(res, err) {
  if (err instanceof MailNodeError) return res.status(502).json({ error: err.message, code: err.code });
  throw err;
}

router.use(requireAuth);

router.get('/config', requireAdmin, async (req, res) => {
  const cfg = await getMailNodeConfig();
  res.json({
    configured: !!cfg,
    mailHost: cfg?.mailHost ?? '',
    apiKey: cfg ? REDACTED_SECRET : '',
    quotaMb: cfg?.quotaMb ?? DEFAULT_QUOTA_MB,
    diskPingUrl: cfg?.diskPingUrl ?? '',
  });
});

// Saves only settings the node accepts: the key is checked by listing the domains first.
router.put('/config', requireAdmin, async (req, res) => {
  const mailHost = parseHostName(req.body?.mailHost);
  if (!mailHost) return refuse(res, 'mail_host_invalid');
  const quotaMb = parseWholeNumber(req.body?.quotaMb ?? DEFAULT_QUOTA_MB, 1, MAX_QUOTA_MB);
  if (!quotaMb) return refuse(res, 'quota_invalid');
  const rawPing = typeof req.body?.diskPingUrl === 'string' ? req.body.diskPingUrl.trim() : '';
  const diskPingUrl = rawPing ? parsePingUrl(rawPing) : null;
  if (rawPing && !diskPingUrl) return refuse(res, 'ping_url_invalid');
  const sent = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  let apiKey = sent;
  if (!sent || sent === REDACTED_SECRET) {
    // The stored key goes only to the host it was entered for: a new host needs the key again.
    const current = await getMailNodeConfig();
    if (!current?.apiKey || current.mailHost !== mailHost) return refuse(res, 'api_key_required');
    apiKey = current.apiKey;
  }
  const cfg = { mailHost, apiKey, quotaMb, diskPingUrl };
  try {
    await listDomains(cfg);
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  await saveMailNodeConfig(cfg);
  // Read the disk (and ping) right away instead of at the next scheduled run.
  checkMailNodeDisk().catch((err) => console.error('Mail node disk check failed:', err.message));
  res.json({ ok: true });
});

router.get('/domains', async (req, res) => {
  const cfg = await getMailNodeConfig();
  if (!cfg) return refuse(res, 'mail_node_not_configured');
  try {
    res.json({ domains: await listDomains(cfg) });
  } catch (err) {
    return mailNodeFailure(res, err);
  }
});

// Creates the domain on the node. DNS, the EOP connectors and DKIM stay manual (runbook).
router.post('/domains', requireAdmin, async (req, res) => {
  const domain = parseHostName(req.body?.domain);
  if (!domain) return refuse(res, 'domain_invalid');
  const mailboxes = parseWholeNumber(req.body?.mailboxes ?? DEFAULT_DOMAIN_MAILBOXES, 1, MAX_DOMAIN_MAILBOXES);
  if (!mailboxes) return refuse(res, 'mailboxes_invalid');
  const cfg = await getMailNodeConfig();
  if (!cfg) return refuse(res, 'mail_node_not_configured');
  try {
    await addDomain(cfg, { domain, mailboxes });
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  res.json({ ok: true, domain });
});

// The node mailboxes MailExpert knows, with quota and usage as the node reports them.
router.get('/mailboxes', requireAdmin, async (req, res) => {
  const cfg = await getMailNodeConfig();
  if (!cfg) return refuse(res, 'mail_node_not_configured');
  const { rows } = await query(
    'SELECT id, email_address FROM email_accounts WHERE mail_node = true ORDER BY email_address'
  );
  let onNode;
  try {
    onNode = new Map((await listMailboxes(cfg)).map((m) => [m.email, m]));
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  // The disk is read fresh here; the scheduled check alone pings the ping URL.
  const disk = await getDiskStatus(cfg).then(
    (d) => ({ ...d, warn: d.usedPercent >= DISK_WARN_PERCENT }),
    (err) => ({ error: err.message, code: err.code || 'mail_node_failed' }),
  );
  res.json({
    disk,
    mailboxes: rows.map((row) => {
      const m = onNode.get(row.email_address.toLowerCase());
      return {
        accountId: row.id,
        email: row.email_address,
        onNode: !!m,
        active: m?.active ?? false,
        quotaMb: m?.quotaMb ?? null,
        usedBytes: m?.usedBytes ?? null,
      };
    }),
  });
});

router.put('/mailboxes/:id/quota', requireAdmin, async (req, res) => {
  const quotaMb = parseWholeNumber(req.body?.quotaMb, 1, MAX_QUOTA_MB);
  if (!quotaMb) return refuse(res, 'quota_invalid');
  const { rows } = await query(
    'SELECT email_address FROM email_accounts WHERE id = $1 AND mail_node = true', [req.params.id]
  );
  if (!rows.length) return refuse(res, 'mailbox_not_found');
  const cfg = await getMailNodeConfig();
  if (!cfg) return refuse(res, 'mail_node_not_configured');
  try {
    await setMailboxQuota(cfg, rows[0].email_address, quotaMb);
  } catch (err) {
    return mailNodeFailure(res, err);
  }
  res.json({ ok: true, quotaMb });
});

export default router;
