// Reads and writes one Cloudflare Access policy. Errors carry the HTTP status and Cloudflare
// error codes only: response texts can quote emails or other account details.
const DEFAULT_API_BASE = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 10_000;
const READ_ONLY_FIELDS = new Set(['id', 'uid', 'created_at', 'updated_at', 'reusable', 'app_count']);

export class CloudflareAccessError extends Error {
  constructor(action, status, codes = []) {
    super(`Cloudflare ${action} failed (${status})${codes.length ? `: error ${codes.join(', ')}` : ''}`);
    this.name = 'CloudflareAccessError';
    this.status = status;
    this.codes = codes;
  }
}

// CF_API_BASE points the client at a test server; production uses the public API.
export function cloudflareApiBase(env = process.env) {
  return String(env.CF_API_BASE ?? '').trim().replace(/\/+$/, '') || DEFAULT_API_BASE;
}

export function createCloudflareAccessClient({
  accountId, appId, apiToken, apiBase = cloudflareApiBase(), fetchImpl = fetch,
}) {
  const accessUrl = `${apiBase}/accounts/${accountId}/access`;

  async function call(action, method, url, body) {
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new CloudflareAccessError(action, err?.name === 'TimeoutError' ? 'timeout' : 'network');
    }
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload || payload.success === false) {
      const codes = (Array.isArray(payload?.errors) ? payload.errors : [])
        .map((error) => error?.code)
        .filter(Number.isInteger);
      throw new CloudflareAccessError(action, res.status, codes);
    }
    return payload.result;
  }

  return {
    async getPolicy(policyId) {
      try {
        return await call('getPolicy', 'GET', `${accessUrl}/apps/${appId}/policies/${policyId}`);
      } catch (err) {
        if (err.status !== 404) throw err;
        // Reusable policies are readable through the application they are attached to, so a 404
        // there with the policy present on the account means it is not attached to this app.
        const onAccount = await call('getPolicy', 'GET', `${accessUrl}/policies/${policyId}`).then(() => true, () => false);
        throw onAccount ? new CloudflareAccessError('getPolicy', 'not_attached') : err;
      }
    },

    // PUT replaces the whole policy, so every field read is written back except read-only ones.
    updatePolicy(policy) {
      const body = Object.fromEntries(Object.entries(policy).filter(([key]) => !READ_ONLY_FIELDS.has(key)));
      body.exclude = policy.exclude ?? [];
      body.require = policy.require ?? [];
      const url = policy.reusable === true
        ? `${accessUrl}/policies/${policy.id}`
        : `${accessUrl}/apps/${appId}/policies/${policy.id}`;
      return call('updatePolicy', 'PUT', url, body);
    },
  };
}
