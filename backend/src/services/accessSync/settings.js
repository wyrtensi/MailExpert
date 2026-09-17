import { query } from '../db.js';
import { decrypt, encrypt } from '../encryption.js';
import { UUID_RE } from '../../utils/uuid.js';

// Cloudflare Access sync settings and the state between runs, stored in system_settings. The API
// token is stored encrypted and only ever written: nothing here returns it to a client.
export const ACCESS_SYNC_CONFIG_KEY = 'access_sync_config';
export const ACCESS_SYNC_STATE_KEY = 'access_sync_state';
export const DEFAULT_MAX_DISABLES = 10;

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
const EMPTY_CONFIG = Object.freeze({ enabled: false, accountId: '', appId: '', policyId: '', apiToken: null });

export class AccessSyncConfigError extends Error {
  constructor(code) {
    super(`Invalid Access sync settings: ${code}`);
    this.name = 'AccessSyncConfigError';
    this.code = code;
  }
}

// ACCESS_SYNC_MAX_DISABLES: the most users one run may disable. 0 stops every run that would
// disable anyone.
export function accessSyncMaxDisables(env = process.env) {
  const raw = String(env.ACCESS_SYNC_MAX_DISABLES ?? '').trim();
  return /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MAX_DISABLES;
}

async function readJson(key) {
  const { rows } = await query('SELECT value FROM system_settings WHERE key = $1', [key]);
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].value);
  } catch {
    return null;
  }
}

async function writeJson(key, value) {
  await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}

export async function loadStoredConfig() {
  const stored = await readJson(ACCESS_SYNC_CONFIG_KEY);
  return { ...EMPTY_CONFIG, ...(stored && typeof stored === 'object' ? stored : {}) };
}

// What the admin screen sees: whether a token is stored, never the token.
export function publicConfig(stored) {
  return {
    enabled: !!stored.enabled,
    accountId: stored.accountId,
    appId: stored.appId,
    policyId: stored.policyId,
    apiTokenSet: !!stored.apiToken,
  };
}

// Settings a run can use, or null while the sync is off or not filled in. A token that no longer
// decrypts (a changed ENCRYPTION_KEY) comes back as null so the run can report it.
export async function loadRunConfig() {
  const stored = await loadStoredConfig();
  if (!stored.enabled || !stored.accountId || !stored.appId || !stored.policyId || !stored.apiToken) return null;
  return {
    accountId: stored.accountId,
    appId: stored.appId,
    policyId: stored.policyId,
    apiToken: decrypt(stored.apiToken),
  };
}

// Whether the sync is turned on, for callers outside a run that only need that one flag (the
// Cloudflare sign-in gate in userIdentity.js).
export async function isAccessSyncEnabled() {
  return (await loadStoredConfig()).enabled === true;
}

export async function loadState() {
  const stored = await readJson(ACCESS_SYNC_STATE_KEY);
  return {
    baseline: Array.isArray(stored?.baseline) ? stored.baseline.filter((email) => typeof email === 'string') : [],
    abortedCandidates: Array.isArray(stored?.abortedCandidates) ? stored.abortedCandidates : null,
    lastRun: stored?.lastRun && typeof stored.lastRun === 'object' ? stored.lastRun : null,
  };
}

export function saveState(state) {
  return writeJson(ACCESS_SYNC_STATE_KEY, state);
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

// Saves settings from the admin screen. A blank token keeps the stored one. Pointing the sync at
// another account, application or policy forgets the baseline: the emails written to the old
// policy would otherwise look removed from the new one and disable their users. The baseline is
// reset before the new config is written, not after: a reset followed by a failed config write is
// harmless (an empty baseline never disables anyone), while the old order could pair a new policy
// with a stale baseline if the config write succeeded but the state write then failed.
export async function saveConfig(input) {
  if (typeof input?.enabled !== 'boolean') throw new AccessSyncConfigError('invalid_field');
  const stored = await loadStoredConfig();
  const next = {
    enabled: input.enabled,
    accountId: text(input.accountId).toLowerCase(),
    appId: text(input.appId).toLowerCase(),
    policyId: text(input.policyId).toLowerCase(),
    apiToken: stored.apiToken,
  };
  if ((next.accountId && !ACCOUNT_ID_RE.test(next.accountId))
    || (next.appId && !UUID_RE.test(next.appId))
    || (next.policyId && !UUID_RE.test(next.policyId))) {
    throw new AccessSyncConfigError('invalid_id');
  }
  const token = text(input.apiToken);
  if (next.enabled && !(next.accountId && next.appId && next.policyId && (token || next.apiToken))) {
    throw new AccessSyncConfigError('incomplete');
  }
  if (token) next.apiToken = encrypt(token);

  if (next.accountId !== stored.accountId || next.appId !== stored.appId || next.policyId !== stored.policyId) {
    await saveState({ ...(await loadState()), baseline: [], abortedCandidates: null });
  }
  await writeJson(ACCESS_SYNC_CONFIG_KEY, next);
  return next;
}
