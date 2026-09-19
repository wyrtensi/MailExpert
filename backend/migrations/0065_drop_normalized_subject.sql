-- Subject grouping is gone: new mail has not been threaded by subject since 0060, and the
-- recompute rekeys the rows that still carried a subject-formed key. The generated column and
-- its index only cost writes now. Dropping a column is a catalog change; the index goes with it.
DROP INDEX IF EXISTS idx_messages_norm_subject;
ALTER TABLE messages DROP COLUMN IF EXISTS normalized_subject;
