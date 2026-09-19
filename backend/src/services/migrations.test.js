import { describe, it, expect, vi } from 'vitest';

vi.mock('./db.js', () => ({ pool: { connect: vi.fn() } }));

import { hasNoTransactionMarker } from './migrations.js';

describe('hasNoTransactionMarker', () => {
  it('detects the marker when it is the first line of the file', () => {
    const sql = '-- no-transaction\nCREATE INDEX CONCURRENTLY foo ON bar (baz);\n';
    expect(hasNoTransactionMarker(sql)).toBe(true);
  });

  it('allows leading blank lines before the marker', () => {
    const sql = '\n\n  \n-- no-transaction\nCREATE INDEX CONCURRENTLY foo ON bar (baz);\n';
    expect(hasNoTransactionMarker(sql)).toBe(true);
  });

  it('ignores the same words when they only appear on a later line', () => {
    // A regular migration whose comment happens to start with "no-transaction" partway
    // through the file (e.g. a wrapped explanatory comment) must NOT flip the migration
    // into statement-splitting mode: that is exactly the /im false-positive being fixed.
    const sql = [
      'BEGIN is implicit; this migration runs inside a transaction.',
      '-- Note: this migration does not need',
      '-- no-transaction semantics because it only touches small tables.',
      'ALTER TABLE foo ADD COLUMN bar INT;',
    ].join('\n');
    expect(hasNoTransactionMarker(sql)).toBe(false);
  });

  it('is case-insensitive and tolerant of extra dashes/spaces on the marker line', () => {
    expect(hasNoTransactionMarker('--   NO-TRANSACTION\nSELECT 1;')).toBe(true);
    expect(hasNoTransactionMarker('--no-transaction: for CONCURRENTLY\nSELECT 1;')).toBe(true);
  });

  it('returns false for an ordinary migration with no marker at all', () => {
    expect(hasNoTransactionMarker('-- Add a column\nALTER TABLE foo ADD COLUMN bar INT;\n')).toBe(false);
  });

  it('returns false for empty or missing sql', () => {
    expect(hasNoTransactionMarker('')).toBe(false);
    expect(hasNoTransactionMarker(undefined)).toBe(false);
  });
});
