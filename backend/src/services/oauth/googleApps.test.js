import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../encryption.js', () => ({
  encrypt: (v) => (v ? `enc(${v})` : v),
  // 'broken' stands for a value encrypted with another key: decrypt() returns null for it.
  decrypt: (v) => (typeof v === 'string' && v.startsWith('enc(') ? v.slice(4, -1) : v === 'broken' ? null : v),
}));

const { query, withTransaction } = await import('../db.js');
const {
  GoogleAppError,
  parseGoogleClientId,
  getGoogleAppById,
  getDefaultGoogleApp,
  resolveGoogleConfig,
  recordGoogleGrant,
  setGoogleAppStatus,
} = await import('./googleApps.js');

const CLIENT_ID = '123456789012-abc123def456.apps.googleusercontent.com';
const REDIRECT_URI = 'https://mail.example.com/oauth/google/callback';
const APP = {
  id: 'app-1',
  label: 'Google 1',
  client_id: CLIENT_ID,
  client_secret: 'enc(app-secret)',
  project_number: '123456789012',
  user_limit: 100,
  status: 'active',
  created_at: new Date('2026-09-15T00:00:00Z'),
};

// Transaction client that routes SQL by pattern and records every call.
function scriptedClient(handlers) {
  const calls = [];
  const client = {
    query: vi.fn(async (sql, params) => {
      calls.push([sql, params]);
      for (const [re, result] of handlers) {
        if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  return { client, calls };
}

beforeEach(() => {
  query.mockReset();
  withTransaction.mockReset();
  delete process.env.GOOGLE_REDIRECT_URI;
});
afterEach(() => {
  delete process.env.GOOGLE_REDIRECT_URI;
});

describe('parseGoogleClientId', () => {
  it('returns the Google Cloud project number of a web client ID', () => {
    expect(parseGoogleClientId(CLIENT_ID)).toBe('123456789012');
    expect(parseGoogleClientId(`  ${CLIENT_ID}  `)).toBe('123456789012');
  });

  it.each([
    ['no project number', 'abc123.apps.googleusercontent.com'],
    ['another domain', '123-abc.apps.example.com'],
    ['an upper-case suffix', '123-ABC.apps.googleusercontent.com'],
    ['a number', 42],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(parseGoogleClientId(value)).toBeNull();
  });
});

describe('app lookups', () => {
  it('picks the oldest app that is not disabled as the default', async () => {
    query.mockResolvedValue({ rows: [APP] });
    expect(await getDefaultGoogleApp()).toEqual(APP);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/FROM google_oauth_apps/);
    expect(sql).toMatch(/status <> 'disabled'/);
    expect(sql).toMatch(/ORDER BY created_at, id LIMIT 1/);
  });

  it('returns null when there is no default app', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getDefaultGoogleApp()).toBeNull();
  });

  it('loads an app by id in any status and skips the query without an id', async () => {
    query.mockResolvedValue({ rows: [{ ...APP, status: 'disabled' }] });
    expect(await getGoogleAppById('app-1')).toMatchObject({ id: 'app-1', status: 'disabled' });
    expect(query.mock.calls[0][1]).toEqual(['app-1']);

    query.mockClear();
    expect(await getGoogleAppById(null)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('resolveGoogleConfig', () => {
  it('combines the default app with the callback URL and decrypts the secret', async () => {
    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    query.mockResolvedValue({ rows: [APP] });
    expect(await resolveGoogleConfig()).toEqual({
      appId: 'app-1', clientId: CLIENT_ID, clientSecret: 'app-secret', redirectUri: REDIRECT_URI,
    });
    expect(query.mock.calls[0][0]).toMatch(/status <> 'disabled'/);
  });

  it('uses the requested app instead of the default one', async () => {
    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    query.mockResolvedValue({ rows: [{ ...APP, id: 'app-2', status: 'closed' }] });
    expect(await resolveGoogleConfig({ appId: 'app-2' })).toMatchObject({ appId: 'app-2' });
    expect(query.mock.calls[0][0]).toMatch(/WHERE id = \$1/);
    expect(query.mock.calls[0][1]).toEqual(['app-2']);
  });

  it('is null without a callback URL, without an app, for a disabled app or an undecryptable secret', async () => {
    query.mockResolvedValue({ rows: [APP] });
    expect(await resolveGoogleConfig()).toBeNull();

    process.env.GOOGLE_REDIRECT_URI = REDIRECT_URI;
    query.mockResolvedValue({ rows: [] });
    expect(await resolveGoogleConfig()).toBeNull();

    query.mockResolvedValue({ rows: [{ ...APP, status: 'disabled' }] });
    expect(await resolveGoogleConfig({ appId: 'app-1' })).toBeNull();

    query.mockResolvedValue({ rows: [{ ...APP, client_secret: 'broken' }] });
    expect(await resolveGoogleConfig()).toBeNull();
  });
});

describe('recordGoogleGrant', () => {
  it('upserts one journal row per app and lower-cased email, keeping a known subject', async () => {
    query.mockResolvedValue({ rows: [] });
    await recordGoogleGrant({ appId: 'app-1', email: 'User@Gmail.com', sub: 'sub-1' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO google_oauth_grants \(app_id, email, google_sub\) VALUES \(\$1, lower\(\$2\), \$3\)/);
    expect(sql).toMatch(/ON CONFLICT \(app_id, email\) DO UPDATE SET google_sub = COALESCE\(google_oauth_grants\.google_sub, EXCLUDED\.google_sub\)/);
    expect(params).toEqual(['app-1', 'User@Gmail.com', 'sub-1']);
  });

  it('runs on a transaction client when one is passed', async () => {
    const { client } = scriptedClient([[/INSERT INTO google_oauth_grants/, { rows: [] }]]);
    await recordGoogleGrant({ appId: 'app-1', email: 'u@gmail.com' }, client);
    expect(client.query.mock.calls[0][1]).toEqual(['app-1', 'u@gmail.com', null]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('setGoogleAppStatus', () => {
  it('flags every mailbox of a disabled app for reconnect and returns their ids', async () => {
    const { client, calls } = scriptedClient([
      [/^\s*UPDATE google_oauth_apps/, { rows: [{ id: 'app-1' }] }],
      [/^\s*UPDATE email_accounts/, { rows: [{ id: 'acc-1' }, { id: 'acc-2' }] }],
    ]);
    withTransaction.mockImplementation(async (fn) => fn(client));

    expect(await setGoogleAppStatus('app-1', 'disabled')).toEqual(['acc-1', 'acc-2']);
    expect(calls[0][1]).toEqual(['app-1', 'disabled']);
    const [accountSql, accountParams] = calls[1];
    expect(accountSql).toMatch(/oauth_reconnect_required = true/);
    expect(accountSql).toMatch(/sync_error = 'oauth_reconnect_required'/);
    expect(accountSql).toMatch(/WHERE oauth_app_id = \$1/);
    expect(accountParams).toEqual(['app-1']);
  });

  it.each(['active', 'closed'])('leaves mailboxes alone when the status becomes %s', async (status) => {
    const { client, calls } = scriptedClient([[/^\s*UPDATE google_oauth_apps/, { rows: [{ id: 'app-1' }] }]]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    expect(await setGoogleAppStatus('app-1', status)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('rejects an unknown status without a transaction', async () => {
    const err = await setGoogleAppStatus('app-1', 'paused').catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAppError);
    expect(err.code).toBe('app_status_invalid');
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('reports a missing app', async () => {
    const { client } = scriptedClient([[/^\s*UPDATE google_oauth_apps/, { rows: [] }]]);
    withTransaction.mockImplementation(async (fn) => fn(client));
    const err = await setGoogleAppStatus('app-9', 'closed').catch((e) => e);
    expect(err.code).toBe('app_not_found');
  });
});
