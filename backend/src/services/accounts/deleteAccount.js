import { query } from '../db.js';
import { revokeGoogleToken } from '../oauth/googleOAuth.js';
import { recordAudit } from '../auditLog.js';
import { failJobsOfDeletedAccount } from '../jobQueue.js';
import { redactEmail } from '../../utils/redact.js';

// Removes an ordinary mailbox (not one on the mail node, whose deletion is asked for and waits):
// DELETE /api/accounts/:id and a managed Proton attempt whose worker commit was lost
// (services/proton/connections.js) both go through here. The caller has read the row
// (at least { id, email_address }) and decided
// that the actor may delete it; a Google mailbox's route reads its token to revoke from that row
// (googleRevokeToken). The engine (imapManager) lets go of the mailbox afterwards.
export async function deleteAccount(account, { actor = null, reason = null, googleRevokeToken = null, client = { query }, engine = null } = {}) {
  const { id } = account;
  // Delete from DB first (cascades to messages and folders immediately).
  // Disconnect IMAP afterward — fire-and-forget so a slow server logout
  // doesn't block the response.
  // Letters waiting to be sent from it fail first, so their authors hear of them (jobQueue.js).
  await failJobsOfDeletedAccount(id);
  // Revoked before the row goes, and awaited: Google revokes the person's access to the whole
  // project, so a revoke answered after the row is gone could also cut a grant the same address
  // got by being added again meanwhile. While the row exists, adding the address is refused
  // (already_connected). revokeGoogleToken never throws and times out on its own
  // (PROVIDER_FETCH_TIMEOUT_MS), so the deletion waits at most that long and never fails on it.
  // The grant journal (google_oauth_grants) is left untouched, same as every other revoke path
  // in this codebase — it is a lifetime record for the app's Google user cap, not a list of live
  // grants, and a revoked user still counts against that cap.
  if (googleRevokeToken) {
    const revoked = await revokeGoogleToken(googleRevokeToken).catch(() => false);
    console.log(`Google OAuth grant ${revoked ? 'revoked' : 'revoke failed'} for removed mailbox ${redactEmail(account.email_address)}`);
  }
  await client.query('DELETE FROM email_accounts WHERE id = $1', [id]);
  // The row is gone, so the entry names the mailbox by the address read above.
  recordAudit({
    actorUserId: actor?.userId ?? null,
    accountEmail: account.email_address,
    action: 'mailbox.deleted',
    details: reason ? { mailNode: false, reason } : { mailNode: false },
  });
  const disconnected = engine
    ? engine.disconnectAccount(id).catch(err => console.error(`Disconnect error after delete for ${id}:`, err.message))
    : Promise.resolve();
  return { disconnected };
}
