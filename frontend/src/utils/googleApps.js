// Helpers for the "Google apps" admin screen. Shapes mirror /api/admin/google-apps
// (backend/src/routes/googleAppsAdmin.js). Pure: no DOM, no store, no network.
const CLIENT_ID_RE = /^(\d+)-([a-z0-9]+)\.apps\.googleusercontent\.com$/;
const LABEL_MAX = 100;
// user_limit is a Postgres INTEGER.
const USER_LIMIT_MAX = 2147483647;
const DEFAULT_USER_LIMIT = 100;
const STATUSES = ['active', 'closed', 'disabled'];

export const GOOGLE_APP_SCOPES = 'openid email profile https://mail.google.com/';

// Keys are spelled out literally so the i18n coverage tests can find them.
const STATE_KEYS = Object.freeze({
  active: 'admin.integrations.googleApps.stateActive',
  full: 'admin.integrations.googleApps.stateFull',
  closed: 'admin.integrations.googleApps.stateClosed',
  disabled: 'admin.integrations.googleApps.stateDisabled',
});

const STATUS_ACTION_KEYS = Object.freeze({
  active: 'admin.integrations.googleApps.activate',
  closed: 'admin.integrations.googleApps.close',
  disabled: 'admin.integrations.googleApps.disable',
});

const ERROR_KEYS = Object.freeze({
  label_invalid: 'admin.integrations.googleApps.errorLabelInvalid',
  client_id_invalid: 'admin.integrations.googleApps.errorClientIdInvalid',
  client_secret_required: 'admin.integrations.googleApps.errorClientSecretRequired',
  client_secret_redacted: 'admin.integrations.googleApps.errorClientSecretRedacted',
  user_limit_invalid: 'admin.integrations.googleApps.errorUserLimitInvalid',
  app_status_invalid: 'admin.integrations.googleApps.errorStatusInvalid',
  app_exists: 'admin.integrations.googleApps.errorAppExists',
  app_same_project: 'admin.integrations.googleApps.errorSameProject',
  app_in_use: 'admin.integrations.googleApps.errorInUse',
  app_not_found: 'admin.integrations.googleApps.errorNotFound',
  redirect_uri_invalid: 'admin.integrations.googleApps.errorCallbackInvalid',
});

// "Full" is not stored: the server computes it for an active app whose seats reached the limit.
export function googleAppState(app) {
  if (!STATUSES.includes(app?.status)) return null;
  return app.status === 'active' && app.full === true ? 'full' : app.status;
}

export function googleAppStateKey(app) {
  const state = googleAppState(app);
  return state ? STATE_KEYS[state] : null;
}

export function shortClientId(clientId) {
  if (typeof clientId !== 'string') return '';
  const match = CLIENT_ID_RE.exec(clientId.trim());
  if (match) return `${match[1]}-${match[2].slice(0, 6)}…`;
  return clientId.length > 24 ? `${clientId.slice(0, 24)}…` : clientId;
}

// Seats Google has counted plus live reservations, against the app's limit.
export function googleAppSeatsText(app) {
  const used = (app?.grantsCount ?? 0) + (app?.reservedCount ?? 0);
  return `${used} / ${app?.userLimit ?? 0}`;
}

// Disabling sends the app's mailboxes to "needs reconnect", so only it asks for confirmation.
export function googleAppStatusActions(app) {
  return STATUSES
    .filter((status) => status !== app?.status)
    .map((status) => ({ status, labelKey: STATUS_ACTION_KEYS[status], confirm: status === 'disabled' }));
}

// The server refuses to delete an app with bound mailboxes (409 app_in_use).
export function canDeleteGoogleApp(app) {
  return (app?.accountsCount ?? 0) === 0;
}

// The secret field always starts empty: the server never returns it, and an empty value keeps it.
export function googleAppForm(app) {
  return {
    label: app?.label ?? '',
    clientId: app?.clientId ?? '',
    clientSecret: '',
    userLimit: String(app?.userLimit ?? DEFAULT_USER_LIMIT),
  };
}

function parseUserLimit(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n > 0 && n <= USER_LIMIT_MAX ? n : null;
}

// The first problem that stops the form from saving, as a translation key, or null. The client
// ID of an existing app never changes, so an edit does not check it.
export function googleAppFormError(form, { editing }) {
  const label = form.label.trim();
  if (!label || label.length > LABEL_MAX) return ERROR_KEYS.label_invalid;
  if (!editing && !CLIENT_ID_RE.test(form.clientId.trim())) return ERROR_KEYS.client_id_invalid;
  const secret = form.clientSecret.trim();
  if (!editing && !secret) return ERROR_KEYS.client_secret_required;
  if (secret.includes('•')) return ERROR_KEYS.client_secret_redacted;
  if (parseUserLimit(form.userLimit) === null) return ERROR_KEYS.user_limit_invalid;
  return null;
}

// Body for POST (new app) or PATCH (edit). A blank secret on edit is left out, which keeps the
// stored one; the client ID is never sent on edit.
export function googleAppPayload(form, { editing }) {
  const body = { label: form.label.trim(), userLimit: parseUserLimit(form.userLimit) };
  const secret = form.clientSecret.trim();
  if (!editing) return { label: body.label, clientId: form.clientId.trim(), clientSecret: secret, userLimit: body.userLimit };
  if (secret) body.clientSecret = secret;
  return body;
}

export function googleAppErrorKey(code) {
  return typeof code === 'string' && Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code] : null;
}

// Same rule as the server: an absolute http(s) address.
export function googleCallbackFormError(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' || url.protocol === 'http:') return null;
  } catch {
    // fall through
  }
  return ERROR_KEYS.redirect_uri_invalid;
}

// When the panel is open on another public host (APP_ALT_URLS), Google must also know that
// host's callback: the backend sends the browser back to the host the flow started on.
export function googleCallbackAltUri(configured, origin) {
  if (typeof configured !== 'string' || typeof origin !== 'string' || !origin) return null;
  let url;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }
  const base = origin.replace(/\/+$/, '');
  return url.origin === base ? null : `${base}${url.pathname}`;
}
