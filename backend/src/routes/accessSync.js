import { Router } from 'express';
import { getAuthSettings } from '../services/auth/authSettings.js';
import { requestAccessSync, runAccessSyncNow, withAccessSyncLock } from '../services/accessSync/index.js';
import {
  AccessSyncConfigError, accessSyncMaxDisables, loadState, loadStoredConfig, publicConfig, saveConfig,
} from '../services/accessSync/settings.js';

// Cloudflare Access sync settings for admins; mounted by routes/admin.js behind requireAdmin.
const router = Router();

async function snapshot() {
  const [stored, state] = await Promise.all([loadStoredConfig(), loadState()]);
  return {
    config: publicConfig(stored),
    lastRun: state.lastRun,
    maxDisables: accessSyncMaxDisables(),
    googleMode: getAuthSettings().mode === 'google',
  };
}

router.get('/', async (_req, res) => {
  res.json(await snapshot());
});

router.put('/', async (req, res) => {
  try {
    const saved = await withAccessSyncLock(() => saveConfig(req.body));
    if (saved.enabled) requestAccessSync('config');
  } catch (err) {
    if (!(err instanceof AccessSyncConfigError)) throw err;
    return res.status(400).json({ error: 'Invalid Cloudflare Access settings', code: err.code });
  }
  console.log(`[admin] ${req.session.userId} changed the Cloudflare Access sync settings`);
  return res.json(await snapshot());
});

router.post('/run', async (_req, res) => {
  const result = await runAccessSyncNow();
  res.json({ result, ...(await snapshot()) });
});

export default router;
