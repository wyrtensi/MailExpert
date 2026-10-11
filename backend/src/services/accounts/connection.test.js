import { describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({ query: vi.fn(), pool: {} }));

const { applyImapTlsMode } = await import('./connection.js');

const explicitRow = { imap_host: 'imap.example.com', imap_port: 993, imap_tls: true, imap_tls_mode: 'implicit' };
const legacyRow = { imap_host: 'imap.example.com', imap_port: 993, imap_tls: true, imap_tls_mode: null };

function apply(stored, updates) {
  const copy = { ...updates };
  return { error: applyImapTlsMode(stored, copy), updates: copy };
}

describe('applyImapTlsMode: an IMAP TLS mode roundtrip through server edits', () => {
  it('re-derives an explicit mode when the port changes, so no stale mode survives', () => {
    expect(apply(explicitRow, { imap_port: 143 })).toEqual({ error: null, updates: { imap_port: 143, imap_tls_mode: 'starttls', imap_tls: false } });
    expect(apply({ ...explicitRow, imap_port: 143, imap_tls: false, imap_tls_mode: 'starttls' }, { imap_port: 993 }))
      .toEqual({ error: null, updates: { imap_port: 993, imap_tls_mode: 'implicit', imap_tls: true } });
  });

  it('re-derives an explicit mode when only the host changes', () => {
    const stored = { ...explicitRow, imap_tls_mode: 'starttls', imap_tls: false };
    expect(apply(stored, { imap_host: 'imap.other.example' }).updates).toEqual({ imap_host: 'imap.other.example', imap_tls_mode: 'implicit', imap_tls: true });
  });

  it('keeps an explicit mode a form resends unchanged, with a consistent imap_tls', () => {
    // The stored mode stays (a resent value is not rewritten); imap_tls follows it, not the port.
    const stored = { ...explicitRow, imap_port: 993, imap_tls_mode: 'starttls', imap_tls: false };
    expect(apply(stored, { imap_host: 'imap.example.com', imap_port: 993, imap_tls: true, imap_tls_mode: 'starttls' }).updates)
      .toEqual({ imap_host: 'imap.example.com', imap_port: 993, imap_tls: false });
  });

  it('accepts an administrator choosing the mode explicitly', () => {
    expect(apply(explicitRow, { imap_port: 993, imap_tls_mode: 'starttls' }).updates).toEqual({ imap_port: 993, imap_tls_mode: 'starttls', imap_tls: false });
    expect(apply(legacyRow, { imap_tls_mode: 'implicit' }).updates).toEqual({ imap_tls_mode: 'implicit', imap_tls: true });
  });

  it('refuses an unknown mode and a return of a verified row to the legacy mode', () => {
    expect(apply(explicitRow, { imap_tls_mode: 'plaintext' }).error).toMatch(/TLS mode/);
    expect(apply(explicitRow, { imap_tls_mode: null }).error).toMatch(/TLS mode/);
    expect(apply(explicitRow, { imap_tls_mode: '' }).error).toMatch(/TLS mode/);
  });

  it('legacy_null_mode_preserves_behavior', () => {
    // NULL rows keep the port-implied boolean and stay NULL; a resent NULL is not a change.
    expect(apply(legacyRow, { imap_port: 143 }).updates).toEqual({ imap_port: 143, imap_tls: false });
    expect(apply(legacyRow, { imap_host: 'imap.other.example' }).updates).toEqual({ imap_host: 'imap.other.example' });
    expect(apply(legacyRow, { imap_port: 993, imap_tls_mode: null })).toEqual({ error: null, updates: { imap_port: 993, imap_tls: true } });
    expect(apply(legacyRow, { name: 'x' }).updates).toEqual({ name: 'x' });
  });
});
