import { query } from '../services/db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rules and block list entries each belong to one mailbox. Returns the mailbox id, or answers
// 400 / 404 itself and returns null when the request names no mailbox or one that does not exist.
export async function requireMailbox(accountId, res) {
  if (!accountId) {
    res.status(400).json({ error: 'accountId is required', code: 'account_required' });
    return null;
  }
  if (typeof accountId !== 'string' || !UUID_RE.test(accountId)) {
    res.status(400).json({ error: 'Invalid account id' });
    return null;
  }
  const { rows } = await query('SELECT id FROM email_accounts WHERE id = $1', [accountId]);
  if (!rows.length) {
    res.status(404).json({ error: 'Account not found' });
    return null;
  }
  return rows[0].id;
}
