import { describe, it, expect, beforeEach } from 'vitest';
import { recordImapLogin, recordImapEvent, recordStatusCycle, getImapSnapshot, _resetImapMetrics } from './imapMetrics.js';

const provider = host => (host.includes('gmail') ? 'gmail' : 'imap');
const T = Date.UTC(2026, 8, 15, 12, 0, 0);

describe('imapMetrics', () => {
  beforeEach(() => _resetImapMetrics());

  it('counts login attempts by provider and purpose, including retries of the same connect', () => {
    recordImapLogin('imap.gmail.com', 'IMAP pool connect', { now: T });
    recordImapLogin('IMAP.GMAIL.COM', 'IMAP pool connect token-retry', { now: T });
    recordImapLogin('imap.gmail.com', 'Backfill connect IPv4-retry', { failed: true, now: T });
    recordImapLogin('mail.corp.example', 'IMAP connect', { now: T });
    const snap = getImapSnapshot(provider, T);
    expect(snap.logins).toContainEqual({ provider: 'gmail', purpose: 'IMAP pool connect', total: 2, failures: 0, lastHour: 2, peakPerMinute: 2 });
    expect(snap.logins).toContainEqual({ provider: 'gmail', purpose: 'Backfill connect', total: 1, failures: 1, lastHour: 1, peakPerMinute: 1 });
    expect(snap.loginsByProvider[0]).toEqual({ provider: 'gmail', total: 3, failures: 1, lastHour: 3, peakPerMinute: 3 });
    // The raw custom-domain host never reaches the snapshot.
    expect(JSON.stringify(snap)).not.toContain('corp.example');
  });

  it('keeps totals but reports only the last hour in the window and its busiest minute', () => {
    recordImapLogin('imap.gmail.com', 'Folder status connect', { now: T - 2 * 3600000 });
    for (let i = 0; i < 3; i++) recordImapLogin('imap.gmail.com', 'Folder status connect', { now: T - 10 * 60000 });
    recordImapLogin('imap.gmail.com', 'Folder status connect', { now: T });
    const [row] = getImapSnapshot(provider, T).logins;
    expect(row).toMatchObject({ total: 5, lastHour: 4, peakPerMinute: 3 });
  });

  it('reports skipped background work and folder status cycles per provider', () => {
    recordImapEvent('imap.gmail.com', 'pool_busy', { now: T });
    recordImapEvent('imap.gmail.com', 'pool_busy', { now: T });
    recordStatusCycle('imap.gmail.com', 'list-status', { ms: 100, queryMs: 10 });
    recordStatusCycle('imap.gmail.com', 'list-status', { ms: 300, queryMs: 30, failed: true });
    const snap = getImapSnapshot(provider, T);
    expect(snap.events).toEqual([{ provider: 'gmail', event: 'pool_busy', total: 2, lastHour: 2, peakPerMinute: 2 }]);
    expect(snap.statusCycles).toEqual([{ provider: 'gmail', mode: 'list-status', count: 2, failures: 1, meanMs: 200, maxMs: 300, meanQueryMs: 20, maxQueryMs: 30 }]);
  });
});
