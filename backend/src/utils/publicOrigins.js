// Public origins MailExpert is served from: APP_URL plus APP_ALT_URLS (comma-separated).
// WebSocket connections accept them, and OAuth flows send the browser back to the one it
// actually came through.
function toOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function getPublicOrigins(env = process.env) {
  const values = [env.APP_URL, ...String(env.APP_ALT_URLS || '').split(',')];
  return [...new Set(values.map(toOrigin).filter(Boolean))];
}

// The origin of this request when it is a public origin, else null. The scheme comes from
// X-Forwarded-Proto through `trust proxy`, the host from the Host header.
export function allowedRequestOrigin(req, env = process.env) {
  const host = req.get('host');
  if (!host) return null;
  const origin = toOrigin(`${req.protocol}://${host}`);
  return origin && getPublicOrigins(env).includes(origin) ? origin : null;
}
