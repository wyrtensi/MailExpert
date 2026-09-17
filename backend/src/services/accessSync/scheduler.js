// Runs the Access sync one at a time in this process: user changes request a run, which waits a
// few seconds so a burst of changes becomes one run; a full reconcile runs every hour. MailExpert
// runs as a single backend container, so an in-process queue is enough.
export const DEBOUNCE_MS = 10_000;
export const INTERVAL_MS = 60 * 60_000;

const logFailure = (err) => console.error('[access-sync] Run failed:', err?.code || err?.name || 'Error');

export function createAccessSyncScheduler({ run, debounceMs = DEBOUNCE_MS, intervalMs = INTERVAL_MS }) {
  let tail = Promise.resolve();
  let queuedRun = null;
  let debounceTimer = null;
  let intervalTimer = null;

  // Runs op after everything queued before it, so runs and settings changes never overlap.
  function exclusive(op) {
    const result = tail.then(() => op());
    tail = result.then(() => {}, () => {});
    return result;
  }

  // A run that has not started yet serves every later request: it reads the users when it starts.
  function queueRun(trigger) {
    if (!queuedRun) {
      queuedRun = exclusive(() => {
        queuedRun = null;
        return run(trigger);
      });
    }
    return queuedRun;
  }

  function request(trigger) {
    if (!intervalTimer) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      queueRun(trigger).catch(logFailure);
    }, debounceMs);
    debounceTimer.unref?.();
  }

  function start() {
    if (intervalTimer) return;
    intervalTimer = setInterval(() => { queueRun('schedule').catch(logFailure); }, intervalMs);
    intervalTimer.unref?.();
    request('startup');
  }

  function stop() {
    clearInterval(intervalTimer);
    clearTimeout(debounceTimer);
    intervalTimer = null;
    debounceTimer = null;
  }

  function runNow(trigger = 'manual') {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    return queueRun(trigger);
  }

  return { start, stop, request, runNow, exclusive };
}
