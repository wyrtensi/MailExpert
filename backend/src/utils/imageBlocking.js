// Remote images in a letter body: shown unless the user turned blocking on (owner's choice,
// 2026-09-23: a team reading business mail wants letters as sent). With blocking on, senders and
// domains on the user's whitelist still show theirs.
export function shouldBlockImages(prefs, message) {
  if (prefs?.blockRemoteImages !== true) return false;
  const senderEmail = (message.from_email || '').toLowerCase();
  const atIdx = senderEmail.indexOf('@');
  const senderDomain = atIdx >= 0 ? senderEmail.slice(atIdx + 1) : '';
  const whitelist = prefs?.imageWhitelist || {};
  const allowedAddresses = Array.isArray(whitelist.addresses) ? whitelist.addresses.filter(a => typeof a === 'string').map(a => a.toLowerCase()) : [];
  const allowedDomains   = Array.isArray(whitelist.domains)   ? whitelist.domains.filter(d => typeof d === 'string').map(d => d.toLowerCase())   : [];
  if (senderEmail && allowedAddresses.includes(senderEmail)) return false;
  if (senderDomain && allowedDomains.some(d => senderDomain === d || senderDomain.endsWith('.' + d))) return false;
  return true;
}
