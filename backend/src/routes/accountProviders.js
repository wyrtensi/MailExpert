import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireCsrfHeader } from '../middleware/csrf.js';
import { routeActor, auditOf } from '../services/actor.js';
import { recordAudit } from '../services/auditLog.js';
import { parseProviderCreate, parseManualCreate } from '../services/accounts/createRequest.js';
import { CREATION_REQUEST_ID, createVerifiedAccount } from '../services/accounts/accountCreation.js';
import { safeAccount } from '../services/accounts/manualAccounts.js';
import { imapManager } from '../index.js';

export async function handleAccountCreate(req, res, parse = parseManualCreate) {
  const actor = routeActor(req);
  const parsed = parse(req.body);
  const requestId = req.get('Idempotency-Key');
  if (parsed.error || !CREATION_REQUEST_ID.test(requestId || '')) {
    recordAudit(auditOf(actor, { action: 'mailbox.connection_failed', details: { code: 'invalid_request' } }));
    return res.status(400).json({ error: 'invalid_request', code: 'invalid_request' });
  }
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  req.once('aborted', abort); res.once('close', abort);
  try {
    const result = await createVerifiedAccount(parsed.candidate, actor, {
      provider: parsed.provider, mode: parsed.mode, requestId, signal: controller.signal,
    });
    if (result.error) {
      const status = result.code === 'rate_limited' ? 429 : ['already_connected', 'idempotency_conflict'].includes(result.code) ? 409 : 400;
      return res.status(status).json({ error: result.code, code: result.code });
    }
    if (!result.replayed) imapManager.connectAccount(result.account).catch(() => {});
    return res.json(safeAccount(result.account));
  } finally { req.off('aborted', abort); res.off('close', abort); }
}
const router = Router();
router.use(requireAuth, requireCsrfHeader);
router.post('/', (req, res) => handleAccountCreate(req, res, parseProviderCreate));
export default router;
