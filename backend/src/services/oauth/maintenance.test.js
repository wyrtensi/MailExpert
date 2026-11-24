import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('./tokenManager.js', () => ({ ensureFreshOAuthAccount: vi.fn() }));

import { query } from '../db.js';
import { ensureFreshOAuthAccount } from './tokenManager.js';
import { startOAuthMaintenance, stopOAuthMaintenance } from './maintenance.js';

const MINUTE = 60_000;
const NOW = Date.parse('2026-01-15T00:00:00Z');

function mailbox(id, overrides = {}) {
  return {
    id, enabled: true, oauth_provider: 'google', oauth_access_token: 'stored',
    oauth_token_expiry: new Date(NOW + 9 * MINUTE), ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  query.mockReset();
  ensureFreshOAuthAccount.mockReset();
  ensureFreshOAuthAccount.mockResolvedValue(null);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await stopOAuthMaintenance();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('mailbox OAuth maintenance', () => {
  it('renews due mailboxes at startup without activity and ignores mailboxes that are fresh or disconnected', async () => {
    const idle = mailbox('idle');
    const old = mailbox('old', { oauth_provider: 'yandex', oauth_token_expiry: new Date(NOW + 160 * 24 * 60 * MINUTE) });
    query.mockResolvedValue({ rows: [
      idle, old,
      mailbox('unexpired', { oauth_token_expiry: new Date(NOW + 60 * MINUTE) }),
      mailbox('revoked', { oauth_reconnect_required: true }),
      mailbox('disabled', { enabled: false }),
      mailbox('bridge', { oauth_provider: 'proton' }),
    ] });

    startOAuthMaintenance();
    await vi.advanceTimersByTimeAsync(0);

    expect(ensureFreshOAuthAccount.mock.calls.map(([row]) => row.id)).toEqual(['idle', 'old']);
    expect(ensureFreshOAuthAccount).toHaveBeenCalledWith(idle, { background: true, lockWaitMs: 0 });
  });

  it('backs off after a network failure and retries the same saved grant without user action', async () => {
    const idle = mailbox('idle');
    query.mockResolvedValue({ rows: [idle] });
    ensureFreshOAuthAccount
      .mockRejectedValueOnce(new Error('temporary provider error'))
      .mockRejectedValueOnce(new Error('temporary provider error'));

    startOAuthMaintenance();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(ensureFreshOAuthAccount).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(ensureFreshOAuthAccount).toHaveBeenCalledTimes(3);
    expect(ensureFreshOAuthAccount.mock.calls.every(([row]) => row === idle)).toBe(true);
  });

  it('caps backoff before Yandex expiry so a recovery one minute before expiration still renews in time', async () => {
    const expiry = NOW + 9 * MINUTE;
    const yandex = mailbox('ya', {
      oauth_provider: 'yandex',
      oauth_token_expiry: new Date(expiry),
      oauth_token_refreshed_at: new Date(NOW - 2 * MINUTE),
    });
    const attempts = [];
    let recoveredAt = null;
    query.mockImplementation(async () => ({
      rows: recoveredAt ? [{ ...yandex, oauth_token_expiry: new Date(expiry + 365 * 24 * 60 * MINUTE), oauth_token_refreshed_at: new Date(recoveredAt) }] : [yandex],
    }));
    ensureFreshOAuthAccount.mockImplementation(async () => {
      const at = Date.now();
      attempts.push(at - NOW);
      // Network is down until 1 minute before expiry, and each failed attempt takes the full 10 s timeout.
      if (at < expiry - MINUTE) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        throw new Error('temporary network outage');
      }
      recoveredAt = at;
      return null;
    });

    startOAuthMaintenance();
    // Advance up to the minute before expiry (8m) — must NOT wait until 15m (6m after expiry).
    await vi.advanceTimersByTimeAsync(8 * MINUTE);

    expect(attempts).toEqual([0, MINUTE, 3 * MINUTE, 7 * MINUTE, 8 * MINUTE]);
    expect(recoveredAt).toBe(NOW + 8 * MINUTE);
  });

  it('leaves enough time for the provider request when expiry lands just after a tick', async () => {
    const expiry = NOW + 9 * MINUTE + 5_000;
    const yandex = mailbox('ya-tight', {
      oauth_provider: 'yandex',
      oauth_token_expiry: new Date(expiry),
      oauth_token_refreshed_at: new Date(NOW - 2 * MINUTE),
    });
    const attempts = [];
    let renewed = false;
    query.mockImplementation(async () => ({
      rows: renewed ? [{ ...yandex, oauth_token_expiry: new Date(expiry + 365 * 24 * 60 * MINUTE), oauth_token_refreshed_at: new Date(Date.now()) }] : [yandex],
    }));
    ensureFreshOAuthAccount.mockImplementation(async () => {
      const at = Date.now();
      attempts.push(at - NOW);
      if (attempts.length < 5) throw new Error('temporary network outage');
      renewed = true;
      return null;
    });

    startOAuthMaintenance();
    await vi.advanceTimersByTimeAsync(8 * MINUTE);

    // At 8m, 65s remain (> 10s request timeout); at 9m only 5s would remain.
    expect(attempts).toEqual([0, MINUTE, 3 * MINUTE, 7 * MINUTE, 8 * MINUTE]);
    expect(renewed).toBe(true);
  });

  it('resumes exponential backoff once the token expiry has already passed', async () => {
    const expired = mailbox('ya-expired', {
      oauth_provider: 'yandex',
      oauth_token_expiry: new Date(NOW - MINUTE),
      oauth_token_refreshed_at: new Date(NOW - 2 * MINUTE),
    });
    const attempts = [];
    query.mockResolvedValue({ rows: [expired] });
    ensureFreshOAuthAccount.mockImplementation(async () => {
      attempts.push(Date.now() - NOW);
      throw new Error('still down');
    });

    startOAuthMaintenance();
    await vi.advanceTimersByTimeAsync(15 * MINUTE);

    expect(attempts).toEqual([0, MINUTE, 3 * MINUTE, 7 * MINUTE, 15 * MINUTE]);
  });
});
