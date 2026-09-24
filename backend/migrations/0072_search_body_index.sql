-- no-transaction
-- routes/search.js matches a letter's body with to_tsvector('english', LEFT(coalesce(body_text, ''), 600000)):
-- the cap keeps one huge letter from failing the search on the tsvector size limit. The baseline's
-- body index is built on the uncapped expression, so no search could use it: every free-text
-- search read the whole messages table and computed the tsvector of every body (about 12 s per
-- search at 100 000 letters). Index exactly the search's expression, then drop the unusable one.
-- The cap is FTS_BODY_CHAR_CAP in routes/search.js; the two must stay equal.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_body_capped;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_body_capped
  ON messages USING GIN (to_tsvector('english', LEFT(COALESCE(body_text, ''), 600000)));
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_body;
