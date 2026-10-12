// Waits for Google sign-ins that finish outside this window. Electron (and any browser that opens
// Google elsewhere) never posts the OAuth result back, so a started attempt is remembered here
// with the address it was launched with and the moment the server's OAuth state expires. Each
// return of focus to the window reads the mailbox list from the server (generation-checked by the
// caller's `reconcile`; returns closer together than `interval` count as one read) until the
// address is in the list or the state expires.
//
// The wait outlives the Gmail form: closing the add-account dialog only releases the form's
// callback, so a sign-in completed after Close still lands in the shared list. It is bounded by
// the state lifetime, by `maxWaits` attempts at once (the oldest is dropped) and by the interval.
// The focus listener exists only while something waits. No address or id leaves this module.

const normalize = (email) => String(email ?? '').trim().toLowerCase();

export function createOAuthReturnWatch({ target, reconcile, getAccounts, now = () => Date.now(), interval, maxWaits = 5 }) {
  let waits = []; // { attemptId, email, until, onFound }
  let lastRead = null;
  let lastPromise = null;
  let listening = false;

  const listen = () => {
    if (!listening && waits.length && target) { target.addEventListener('focus', onReturn); listening = true; }
  };
  const unlisten = () => {
    if (listening && !waits.length) { target.removeEventListener('focus', onReturn); listening = false; }
  };

  function onReturn() {
    const at = now();
    waits = waits.filter((wait) => at <= wait.until);
    if (!waits.length) { unlisten(); return null; }
    // A clock set back (or a fake one in tests) never blocks a read.
    if (lastPromise && lastRead !== null && at >= lastRead && at - lastRead < interval) return lastPromise;
    lastRead = at;
    lastPromise = Promise.resolve(reconcile()).then(() => {
      const present = new Set((getAccounts() ?? []).map((account) => normalize(account?.email_address)));
      const found = waits.filter((wait) => present.has(wait.email));
      waits = waits.filter((wait) => !found.includes(wait));
      unlisten();
      for (const wait of found) wait.onFound?.();
    });
    return lastPromise;
  }

  return {
    // Starts (or replaces) the wait of one attempt.
    watch({ attemptId, email, until, onFound = null }) {
      waits = waits.filter((wait) => wait.attemptId !== attemptId);
      waits.push({ attemptId, email: normalize(email), until, onFound });
      while (waits.length > maxWaits) waits.shift();
      listen();
    },
    // The form that started the attempt is gone or moved on: keep refreshing the list, report to nobody.
    release(attemptId) {
      for (const wait of waits) if (wait.attemptId === attemptId) wait.onFound = null;
    },
    // A result for this attempt arrived: nothing to wait for.
    forget(attemptId) {
      waits = waits.filter((wait) => wait.attemptId !== attemptId);
      unlisten();
    },
    // Drops every wait (tests start from a clean slate).
    clear() {
      waits = [];
      lastRead = null;
      lastPromise = null;
      unlisten();
    },
    onReturn,
  };
}
