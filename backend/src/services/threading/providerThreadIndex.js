// Whether idx_messages_provider_thread (migration 0061) is usable. A CREATE INDEX CONCURRENTLY
// that failed leaves an INVALID index behind, and the migration is recorded as applied anyway.
// Switching a mailbox to Gmail threading (PR C) needs this index to be valid.
export async function providerThreadIndexState(query) {
  const { rows } = await query(
    `SELECT i.indisvalid
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_messages_provider_thread'`,
  );
  if (!rows.length) return 'missing';
  return rows[0].indisvalid ? 'valid' : 'invalid';
}
