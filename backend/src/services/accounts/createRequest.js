import { getImapProvider } from './providerCatalog.js';

const PROVIDER_FIELDS = new Set(['provider', 'email', 'appPassword', 'login', 'name', 'senderName', 'signature', 'color']);
const MANUAL_FIELDS = new Set(['provider', 'name', 'sender_name', 'email_address', 'color', 'protocol', 'imap_host', 'imap_port', 'imap_tls', 'imap_tls_mode', 'imap_skip_tls_verify', 'smtp_host', 'smtp_port', 'smtp_tls', 'auth_user', 'auth_pass', 'smtp_auth_user', 'smtp_auth_pass', 'signature']);
const invalid = () => ({ error: 'invalid_request', code: 'invalid_request' });
// Reject all header/control characters, including NUL.
// eslint-disable-next-line no-control-regex
const controls = /[\x00-\x1f\x7f]/;
const text = v => typeof v === 'string' && !!v.trim() && !controls.test(v);
const port = v => Number.isInteger(v) && v >= 1 && v <= 65535;
const shape = (body, fields) => body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(k => fields.has(k));
const email = v => text(v) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());
function metadata(body, senderKey) {
  for (const key of ['name', senderKey, 'signature', 'color']) {
    if (body[key] != null && typeof body[key] !== 'string') return false;
  }
  return !['name', senderKey, 'color'].some(k => typeof body[k] === 'string' && controls.test(body[k]));
}
export function parseProviderCreate(body) {
  if (!shape(body, PROVIDER_FIELDS) || !metadata(body, 'senderName')) return invalid();
  const provider = getImapProvider(body.provider);
  if (!provider || !email(body.email) || typeof body.appPassword !== 'string' || !body.appPassword) return invalid();
  if (body.login !== undefined && !text(body.login)) return invalid();
  const address = body.email.trim().toLowerCase();
  const login = body.login?.trim() || address;
  return { provider: provider.id, mode: 'preset', candidate: {
    name: body.name?.trim() || address, sender_name: body.senderName || null,
    email_address: address, color: body.color || '#6366f1', signature: body.signature || null,
    protocol: 'imap', imap_host: provider.imap.host, imap_port: provider.imap.port,
    imap_tls_mode: provider.imap.tls, smtp_host: provider.smtp.host, smtp_port: provider.smtp.port,
    smtp_tls: provider.smtp.tls === 'implicit' ? 'SSL' : 'STARTTLS',
    auth_user: login, smtp_auth_user: login, auth_pass: body.appPassword,
    smtp_auth_pass: body.appPassword, provider, explicitLogin: body.login !== undefined,
  } };
}
export function parseManualCreate(body) {
  if (!shape(body, MANUAL_FIELDS) || !metadata(body, 'sender_name')) return invalid();
  if (body.provider !== undefined && body.provider !== 'other' && !getImapProvider(body.provider)) return invalid();
  if (!email(body.email_address) || !text(body.imap_host) || !text(body.smtp_host)) return invalid();
  if (body.protocol !== undefined && body.protocol !== 'imap') return invalid();
  if (body.imap_skip_tls_verify !== undefined && body.imap_skip_tls_verify !== false) return invalid();
  if (body.imap_tls !== undefined && body.imap_tls !== true) return invalid();
  const imapPort = body.imap_port ?? 993, smtpPort = body.smtp_port ?? 587;
  const imapMode = body.imap_tls_mode === undefined ? (imapPort === 143 ? 'starttls' : 'implicit') : body.imap_tls_mode;
  const smtpMode = body.smtp_tls ?? 'STARTTLS';
  if (!port(imapPort) || !port(smtpPort) || !['implicit', 'starttls'].includes(imapMode) || !['SSL', 'STARTTLS'].includes(smtpMode)) return invalid();
  const address = body.email_address.trim().toLowerCase();
  const login = body.auth_user === undefined ? address : body.auth_user;
  if (!text(login) || body.smtp_auth_user != null && body.smtp_auth_user !== '' && !text(body.smtp_auth_user)) return invalid();
  if (typeof body.auth_pass !== 'string' || !body.auth_pass || body.smtp_auth_pass != null && typeof body.smtp_auth_pass !== 'string') return invalid();
  return { provider: body.provider || 'other', mode: 'manual', candidate: {
    ...body, name: body.name?.trim() || address, email_address: address, protocol: 'imap',
    imap_host: body.imap_host.trim(), smtp_host: body.smtp_host.trim(), imap_port: imapPort, smtp_port: smtpPort,
    imap_tls_mode: imapMode, smtp_tls: smtpMode, auth_user: login.trim(),
    smtp_auth_user: body.smtp_auth_user?.trim() || login.trim(), provider: undefined, explicitLogin: true,
  } };
}
