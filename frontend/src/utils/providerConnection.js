// Connection logic of the mailbox-provider forms: which request a form sends (the fixed provider
// route or the manual one), the editable server values behind the collapsed advanced block, the
// hints taken from the address, and the message keys of every refusal. Pure functions: no DOM, no
// store, no network, so they run under `node --test`.
//
// The catalog (`defaults`) is the safe metadata of GET /api/integrations/status `mailProviders`:
// { id, imap: { host, port, tls }, smtp: { host, port, tls }, appPasswordUrl, publicDomains,
// loginAlternatives }. The servers of a fixed provider come from there, never from the address.

export const IMAP_TLS_MODES = Object.freeze(['implicit', 'starttls']);
export const SMTP_TLS_VALUES = Object.freeze(['SSL', 'STARTTLS']);

const STANDARD_PORTS = Object.freeze({ imap_port: [143, 993], smtp_port: [465, 587] });
const SERVER_TEXT_FIELDS = ['imap_host', 'smtp_host'];
const SERVER_PORT_FIELDS = ['imap_port', 'smtp_port'];

const smtpTlsOf = (tls) => (tls === 'implicit' ? 'SSL' : 'STARTTLS');
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');
const portNumber = (value) => {
  const text = String(value ?? '').trim();
  return /^\d{1,5}$/.test(text) ? Number(text) : NaN;
};

// The server part of the advanced block, as the inputs hold it (ports as text), filled from a
// catalog entry. `login` and `smtp_login` are optional and empty by default.
export function advancedFromDefaults(defaults) {
  return {
    imap_host: defaults?.imap?.host ?? '',
    imap_port: String(defaults?.imap?.port ?? ''),
    imap_tls_mode: defaults?.imap?.tls ?? 'implicit',
    smtp_host: defaults?.smtp?.host ?? '',
    smtp_port: String(defaults?.smtp?.port ?? ''),
    smtp_tls: defaults?.smtp ? smtpTlsOf(defaults.smtp.tls) : 'STARTTLS',
    smtp_login: '',
  };
}

// "Other" starts without hosts (none are invented); the usual ports and modes are suggestions.
export function emptyAdvanced() {
  return {
    imap_host: '', imap_port: '993', imap_tls_mode: 'implicit',
    smtp_host: '', smtp_port: '587', smtp_tls: 'STARTTLS',
    smtp_login: '',
  };
}

// Whether any server value differs from the provider's fixed route. Case and spacing of hosts and
// the spelling of numbers do not count; merely opening the block changes nothing.
export function isServerChanged(advanced, defaults) {
  if (!advanced || !defaults?.imap || !defaults?.smtp) return false;
  const fixed = advancedFromDefaults(defaults);
  for (const key of SERVER_TEXT_FIELDS) {
    if (trimmed(advanced[key]).toLowerCase() !== fixed[key].toLowerCase()) return true;
  }
  for (const key of SERVER_PORT_FIELDS) {
    if (portNumber(advanced[key]) !== Number(fixed[key])) return true;
  }
  return advanced.imap_tls_mode !== fixed.imap_tls_mode || advanced.smtp_tls !== fixed.smtp_tls;
}

// Server fields that must be filled before "Other" can connect.
export function missingServerFields(advanced) {
  const missing = [];
  for (const key of ['imap_host', 'imap_port', 'smtp_host', 'smtp_port']) {
    if (!trimmed(advanced?.[key])) missing.push(key);
  }
  // Order of the form: IMAP host, IMAP port, SMTP host, SMTP port.
  return missing;
}

// Ports that are not whole numbers in 1..65535, or (unless the installation allows other ports)
// not one of the standard mail ports. The server decides in any case; this only saves a round trip.
export function portProblems(advanced, { allowNonstandardPorts = false } = {}) {
  const problems = [];
  for (const key of SERVER_PORT_FIELDS) {
    if (!trimmed(advanced?.[key])) continue;
    const port = portNumber(advanced[key]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(key);
    else if (!allowNonstandardPorts && !STANDARD_PORTS[key].includes(port)) problems.push(key);
  }
  return problems;
}

const domainOf = (email) => {
  const text = trimmed(email).toLowerCase();
  const at = text.lastIndexOf('@');
  return at > 0 && at === text.indexOf('@') && !/\s/.test(text) ? text.slice(at + 1) : '';
};

// The catalog provider whose public domain list names this address's domain exactly (never a
// substring or a subdomain); null for every other domain. A hint, never a reason to change servers.
export function providerForEmail(email, catalog) {
  const domain = domainOf(email);
  if (!domain || !Array.isArray(catalog)) return null;
  return catalog.find((entry) => Array.isArray(entry?.publicDomains) && entry.publicDomains.includes(domain))?.id ?? null;
}

// The provider the address belongs to when it is not the tile in use (the form offers the other tile).
export function otherProviderForEmail(email, current, catalog) {
  const found = providerForEmail(email, catalog);
  return found && found !== current ? found : null;
}

function metadataFields(metadata, spelling) {
  const out = {};
  const map = spelling === 'preset'
    ? { name: 'name', senderName: 'senderName', signature: 'signature', color: 'color' }
    : { name: 'name', senderName: 'sender_name', signature: 'signature', color: 'color' };
  for (const [from, to] of Object.entries(map)) {
    const value = metadata?.[from];
    if (typeof value !== 'string') continue;
    const text = from === 'signature' ? value : value.trim();
    if (text.trim()) out[to] = text;
  }
  return out;
}

// What a provider form sends. Fixed providers (`yahoo`, `yandex`, `mailru`, `icloud`) use the
// fixed-provider route while every server value equals the catalog's; a changed value switches to
// the manual route and keeps the provider as the label. "Other" is always manual. The password
// exists in the returned body only for the request.
//   preset: POST /accounts/provider { provider, email, appPassword, [login, name, senderName, signature, color] }
//   manual: POST /accounts { provider, email_address, auth_user, auth_pass, imap_*, smtp_*, [smtp_auth_user, ...] }
export function providerConnectionPayload({ provider, email, appPassword, login, advanced, metadata } = {}, defaults = null) {
  const address = trimmed(email);
  const altLogin = trimmed(login);
  const smtpLogin = trimmed(advanced?.smtp_login);
  const effectiveLogin = altLogin || address;
  const differentSmtpLogin = !!smtpLogin && smtpLogin !== effectiveLogin;
  const manual = provider === 'other' || (!!defaults && !!advanced && (isServerChanged(advanced, defaults) || differentSmtpLogin));
  if (!manual) {
    return {
      mode: 'preset',
      body: { provider, email: address, appPassword, ...(altLogin ? { login: altLogin } : {}), ...metadataFields(metadata, 'preset') },
    };
  }
  const values = advanced ?? {};
  const body = {
    provider,
    email_address: address,
    auth_user: effectiveLogin,
    auth_pass: appPassword,
    imap_host: trimmed(values.imap_host),
    imap_port: portNumber(values.imap_port),
    imap_tls_mode: values.imap_tls_mode,
    smtp_host: trimmed(values.smtp_host),
    smtp_port: portNumber(values.smtp_port),
    smtp_tls: values.smtp_tls,
    ...(differentSmtpLogin ? { smtp_auth_user: smtpLogin } : {}),
    ...metadataFields(metadata, 'manual'),
  };
  return { mode: 'manual', body };
}

// ---- refusals -------------------------------------------------------------------------------

// Spelled out literally so the i18n coverage test finds them.
const CONNECTION_ERROR_KEYS = {
  email_invalid: 'admin.accounts.add.error.emailInvalid',
  login_invalid: 'admin.accounts.add.error.loginInvalid',
  imap_auth_failed: 'admin.accounts.add.error.imapAuth',
  smtp_auth_failed: 'admin.accounts.add.error.smtpAuth',
  imap_unavailable: 'admin.accounts.add.error.imapUnavailable',
  smtp_unavailable: 'admin.accounts.add.error.smtpUnavailable',
  connection_timeout: 'admin.accounts.add.error.timeout',
  tls_error: 'admin.accounts.add.error.tls',
  connection_cancelled: 'admin.accounts.add.error.cancelled',
  server_refused: 'admin.accounts.add.error.serverRefused',
  already_connected: 'admin.accounts.add.error.alreadyConnected',
  idempotency_conflict: 'admin.accounts.add.error.conflict',
  rate_limited: 'admin.accounts.add.error.rateLimited',
  invalid_request: 'admin.accounts.add.error.invalidRequest',
};
const CONNECTION_ERROR_FALLBACK = 'admin.accounts.add.error.generic';

export function connectionErrorKey(code) {
  return typeof code === 'string' && Object.hasOwn(CONNECTION_ERROR_KEYS, code) ? CONNECTION_ERROR_KEYS[code] : CONNECTION_ERROR_FALLBACK;
}

// The server refused the sign-in itself (not the network or TLS): the form may offer the optional
// separate login. The password is never echoed.
export function isAuthRefusal(code) {
  return code === 'imap_auth_failed' || code === 'smtp_auth_failed';
}

// Every code the Proton connection API can answer (status errorCode, or an HTTP refusal).
// `invalid_credentials` adds the owner's hint about the server's access to Proton; `connection` is
// a separate message.
const PROTON_ERROR_KEYS = {
  invalid_credentials: 'admin.accounts.add.protonError.invalidCredentials',
  connection: 'admin.accounts.add.protonError.connection',
  verification_required: 'admin.accounts.add.protonError.verificationRequired',
  login_busy: 'admin.accounts.add.protonError.loginBusy',
  login_failed: 'admin.accounts.add.protonError.loginFailed',
  proton_unavailable: 'admin.accounts.add.protonError.unavailable',
  already_connected: 'admin.accounts.add.protonError.alreadyConnected',
  reconnect_unavailable: 'admin.accounts.add.protonError.reconnectUnavailable',
  reconnect_mismatch: 'admin.accounts.add.protonError.reconnectMismatch',
  address_mismatch: 'admin.accounts.add.protonError.addressMismatch',
  imap_auth_failed: 'admin.accounts.add.protonError.imapAuth',
  smtp_auth_failed: 'admin.accounts.add.protonError.smtpAuth',
  imap_unavailable: 'admin.accounts.add.protonError.imapUnavailable',
  smtp_unavailable: 'admin.accounts.add.protonError.smtpUnavailable',
  connection_timeout: 'admin.accounts.add.protonError.timeout',
  tls_error: 'admin.accounts.add.protonError.tls',
  connection_cancelled: 'admin.accounts.add.protonError.cancelled',
  server_refused: 'admin.accounts.add.protonError.serverRefused',
  invalid_challenge: 'admin.accounts.add.protonError.invalidChallenge',
  rate_limited: 'admin.accounts.add.protonError.rateLimited',
  idempotency_conflict: 'admin.accounts.add.protonError.conflict',
  invalid_request: 'admin.accounts.add.protonError.invalidRequest',
  expired: 'admin.accounts.add.protonError.expired',
  cancelled: 'admin.accounts.add.protonError.cancelledByUser',
};
const PROTON_ERROR_FALLBACK = 'admin.accounts.add.protonError.generic';

export function protonErrorKey(code) {
  return typeof code === 'string' && Object.hasOwn(PROTON_ERROR_KEYS, code) ? PROTON_ERROR_KEYS[code] : PROTON_ERROR_FALLBACK;
}

// ---- Proton ---------------------------------------------------------------------------------

// POST /accounts/proton/connect: the attempt id is `requestId` in the body. Metadata and the
// reconnect target are added only when present.
export function protonStartBody({ email, password, requestId, reconnectAccountId, metadata } = {}) {
  return {
    email: trimmed(email),
    password,
    requestId,
    ...(reconnectAccountId ? { reconnectAccountId } : {}),
    ...metadataFields(metadata, 'preset'),
  };
}

// The mailbox a Proton sign-in may reconnect: the one in the shared list with this address that the
// server says can be reconnected (`can_reconnect_proton`, which is true for any approved employee on
// a managed Proton mailbox). A seed (the account the user came from) is honoured only when it names
// the same address and the list agrees. Anything else starts a new connection.
export function findReconnectTarget(accounts, email, seed = null) {
  const wanted = trimmed(email).toLowerCase();
  if (!wanted || !Array.isArray(accounts)) return null;
  if (seed && trimmed(seed.email_address).toLowerCase() !== wanted) return null;
  return accounts.find((account) => (
    account?.mail_provider === 'proton'
    && account.can_reconnect_proton === true
    && trimmed(account.email_address).toLowerCase() === wanted
    && (!seed?.id || seed.id === account.id)
  )) ?? null;
}
