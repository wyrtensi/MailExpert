import { safeFetch } from '../safeFetch.js';
import { getDiskStatus, getMailNodeConfig } from './mailcow.js';

// Watches the mail node's mail disk. Every run reads the disk through the mailcow API and, when an
// administrator gave a ping URL, pings it: success below the threshold, /fail at or above it. An
// unreachable node sends no ping, which the ping service reports by itself; so does a stopped panel.

export const DISK_WARN_PERCENT = 85;
const INTERVAL_MS = 10 * 60 * 1000;
const PING_TIMEOUT_MS = 10000;

let timer = null;

async function ping(url, fail, body) {
  try {
    await safeFetch(fail ? `${url.replace(/\/+$/, '')}/fail` : url, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`Mail node disk ping failed: ${err?.code || err?.name || 'error'}`);
  }
}

// Returns the reading ({ usedPercent, used, total, warn }), null without a mail node; a node
// failure is thrown to the caller after skipping the ping.
export async function checkMailNodeDisk() {
  const cfg = await getMailNodeConfig();
  if (!cfg) return null;
  const disk = await getDiskStatus(cfg);
  const warn = disk.usedPercent >= DISK_WARN_PERCENT;
  if (cfg.diskPingUrl) {
    await ping(cfg.diskPingUrl, warn, `mail node disk ${disk.usedPercent}% used (${disk.used} of ${disk.total})`);
  }
  return { ...disk, warn };
}

export function startMailNodeDiskWatch() {
  if (timer) return;
  const run = () => checkMailNodeDisk().catch((err) => console.error('Mail node disk check failed:', err.message));
  run();
  timer = setInterval(run, INTERVAL_MS);
  timer.unref?.();
}
