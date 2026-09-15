import { createLocalJWKSet, jwtVerify } from 'jose';

// Cloudflare Access puts a signed assertion of the signed-in identity on every request it
// lets through. It is trusted only after checking the signature, issuer and audience.
export const CF_ACCESS_HEADER = 'cf-access-jwt-assertion';

const CACHE_MAX_AGE_MS = 10 * 60_000;
const STALE_MAX_AGE_MS = 24 * 60 * 60_000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;

// A key set that survives the Access certs endpoint being briefly unreachable: a failed
// refresh keeps serving the last good document until it is too old to trust. One refresh
// runs at a time, so a burst of requests at expiry makes a single fetch.
export function createResilientJwks({
  fetchJwks,
  now = () => Date.now(),
  cacheMaxAgeMs = CACHE_MAX_AGE_MS,
  staleMaxAgeMs = STALE_MAX_AGE_MS,
}) {
  let cached = null;
  let inFlight = null;

  const refresh = async () => {
    const document = await fetchJwks();
    cached = { getKey: createLocalJWKSet(document), fetchedAt: now() };
  };

  const ensureFresh = async () => {
    if (cached && now() - cached.fetchedAt <= cacheMaxAgeMs) return;
    inFlight ??= refresh().finally(() => { inFlight = null; });
    try {
      await inFlight;
    } catch (err) {
      if (cached && now() - cached.fetchedAt <= staleMaxAgeMs) return;
      throw err;
    }
  };

  return async (protectedHeader, token) => {
    await ensureFresh();
    return cached.getKey(protectedHeader, token);
  };
}

const fetchJwksOverHttp = (issuer) => async () => {
  const res = await fetch(`${issuer}/cdn-cgi/access/certs`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Access certs request failed with status ${res.status}`);
  return res.json();
};

const jwksByIssuer = new Map();
function jwksFor(issuer) {
  if (!jwksByIssuer.has(issuer)) {
    jwksByIssuer.set(issuer, createResilientJwks({ fetchJwks: fetchJwksOverHttp(issuer) }));
  }
  return jwksByIssuer.get(issuer);
}

// The lower-cased email of a valid Access token, or null. Never throws: an absent or
// unverifiable token is simply not a way in.
export async function verifyCloudflareAccessToken(token, { issuer, audience }, { jwks } = {}) {
  if (typeof token !== 'string' || !token) return null;
  try {
    const { payload } = await jwtVerify(token, jwks ?? jwksFor(issuer), {
      issuer,
      audience,
      algorithms: ['RS256'],
    });
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    return email.includes('@') ? email : null;
  } catch {
    return null;
  }
}
