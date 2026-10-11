import { Router } from 'express';
import { isAdminRequest, requireAuth } from '../middleware/auth.js';
import { requireCsrfHeader } from '../middleware/csrf.js';
import { routeActor } from '../services/actor.js';
import { uuidParam } from '../utils/uuid.js';
import {
  cancelProtonConnection, continueProtonConnection, getProtonConnection, parseProtonContinue, parseProtonStart,
  startProtonConnection,
} from '../services/proton/connections.js';

// Managed Proton connection attempts (services/proton/connections.js). Any approved employee may
// start one, including a reconnect of a shared managed mailbox; an attempt's status is for the
// employee who started it or an administrator, everything else about it for that employee only.
// Bodies are parsed by middleware/bodyParsers.js (32 KiB) and only whitelisted fields go on.

const STATUS = Object.freeze({
  invalid_request: 400, not_found: 404, invalid_challenge: 409, idempotency_conflict: 409,
  rate_limited: 429, proton_unavailable: 503,
});

function answer(res, result) {
  res.set('Cache-Control', 'no-store');
  if (result.error) return res.status(STATUS[result.code] ?? 400).json({ error: result.code, code: result.code });
  return res.json(result);
}

const router = Router();
router.use(requireAuth, requireCsrfHeader);
router.param('id', uuidParam('id'));

router.post('/', async (req, res) => {
  const parsed = parseProtonStart(req.body);
  if (parsed.error) return answer(res, parsed);
  return answer(res, await startProtonConnection(parsed.input, routeActor(req)));
});

router.get('/:id', async (req, res) => {
  const actor = { ...routeActor(req), isAdmin: await isAdminRequest(req) };
  return answer(res, await getProtonConnection(req.params.id, actor));
});

router.post('/:id/continue', async (req, res) => {
  const parsed = parseProtonContinue(req.body);
  if (parsed.error) return answer(res, parsed);
  return answer(res, await continueProtonConnection(req.params.id, parsed.input, routeActor(req)));
});

router.post('/:id/cancel', async (req, res) => answer(res, await cancelProtonConnection(req.params.id, routeActor(req))));

export default router;
