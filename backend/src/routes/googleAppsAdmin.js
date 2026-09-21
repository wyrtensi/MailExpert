import { Router } from 'express';
import {
  GOOGLE_APP_STATUSES,
  GoogleAppError,
  createGoogleApp,
  deleteGoogleApp,
  getGoogleAppSummary,
  listGoogleApps,
  setGoogleAppStatus,
  updateGoogleApp,
} from '../services/oauth/googleApps.js';
import { countGoogleReservations } from '../services/oauth/googleAppSelection.js';
import { uuidParam } from '../utils/uuid.js';

// Mounted by routes/admin.js behind requireAdmin at /api/admin/google-apps.
const router = Router();
router.param('id', uuidParam('id'));

// Placeholder the admin screen shows for a stored secret; sending it back keeps the secret.
const REDACTED_SECRET = '••••••••';

const ERRORS = {
  label_invalid: [400, 'Name must be 1 to 100 characters'],
  client_id_invalid: [400, 'Client ID is not a Google OAuth client ID'],
  client_secret_required: [400, 'Client secret is required'],
  client_secret_redacted: [400, 'Client secret contains the redaction placeholder; enter the full secret'],
  user_limit_invalid: [400, 'User limit must be a positive whole number'],
  app_status_invalid: [400, 'Unknown app status'],
  app_exists: [409, 'This client ID is already added'],
  app_same_project: [409, 'An app from this Google Cloud project is already added'],
  app_in_use: [409, 'The app still has connected mailboxes'],
  app_not_found: [404, 'App not found'],
};

function refuse(res, code) {
  const [status, error] = ERRORS[code];
  return res.status(status).json({ error, code });
}

function handleRegistryError(res, err) {
  if (err instanceof GoogleAppError && ERRORS[err.code]) return refuse(res, err.code);
  throw err;
}

// A secret field that is exactly the placeholder or empty keeps the stored value; one that
// mixes the placeholder with typed text would overwrite the real secret with junk.
function secretFromBody(value) {
  if (typeof value !== 'string' || value === '' || value === REDACTED_SECRET) return { secret: null };
  if (value.includes('•')) return { error: 'client_secret_redacted' };
  return { secret: value };
}

async function toApi(row) {
  const reservedCount = await countGoogleReservations(row.id);
  return {
    id: row.id,
    label: row.label,
    clientId: row.client_id,
    projectNumber: row.project_number,
    userLimit: row.user_limit,
    status: row.status,
    grantsCount: row.grants_count ?? 0,
    reservedCount,
    accountsCount: row.accounts_count ?? 0,
    // "Full" is not a stored status: an active app whose counted seats reached its limit.
    full: row.status === 'active' && (row.grants_count ?? 0) + reservedCount >= row.user_limit,
    createdAt: row.created_at,
  };
}

router.get('/', async (_req, res) => {
  const rows = await listGoogleApps();
  res.json({ apps: await Promise.all(rows.map(toApi)) });
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  const { secret, error } = secretFromBody(body.clientSecret);
  if (error) return refuse(res, error);
  try {
    const row = await createGoogleApp({
      label: body.label,
      clientId: body.clientId,
      clientSecret: secret,
      userLimit: body.userLimit ?? 100,
    });
    res.status(201).json({ app: await toApi(row) });
  } catch (err) {
    return handleRegistryError(res, err);
  }
});

router.patch('/:id', async (req, res) => {
  const body = req.body || {};
  const { secret, error } = secretFromBody(body.clientSecret);
  if (error) return refuse(res, error);
  if (body.status !== undefined && !GOOGLE_APP_STATUSES.includes(body.status)) return refuse(res, 'app_status_invalid');
  try {
    await updateGoogleApp(req.params.id, { label: body.label, clientSecret: secret, userLimit: body.userLimit });
    // Always applied when sent: setGoogleAppStatus is idempotent, and disabling again re-flags
    // mailboxes a previous disable may have left half done.
    if (body.status !== undefined) {
      const flagged = await setGoogleAppStatus(req.params.id, body.status);
      // Their tokens came from a client that no longer refreshes: drop the live connections.
      const manager = req.app.get('imapManager');
      for (const accountId of flagged) {
        Promise.resolve(manager?.disconnectAccount(accountId)).catch(() => {});
      }
    }
    // Re-read so the response carries the grants/accounts counts as they stand now:
    // updateGoogleApp's own return only has the columns it wrote.
    const row = await getGoogleAppSummary(req.params.id);
    if (!row) return refuse(res, 'app_not_found');
    res.json({ app: await toApi(row) });
  } catch (err) {
    return handleRegistryError(res, err);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await deleteGoogleApp(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    return handleRegistryError(res, err);
  }
});

export default router;
