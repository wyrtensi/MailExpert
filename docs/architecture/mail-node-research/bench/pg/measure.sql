\pset format aligned
SELECT count(*) AS row_count FROM messages;

SELECT
  pg_size_pretty(pg_total_relation_size('messages')) AS total_incl_indexes_toast,
  pg_size_pretty(pg_table_size('messages'))          AS heap_plus_toast,
  pg_size_pretty(pg_indexes_size('messages'))         AS all_indexes,
  pg_total_relation_size('messages') / (SELECT count(*) FROM messages) AS bytes_per_row_total,
  pg_table_size('messages') / (SELECT count(*) FROM messages)          AS bytes_per_row_heap_toast,
  pg_indexes_size('messages') / (SELECT count(*) FROM messages)        AS bytes_per_row_indexes;

SELECT
  indexname,
  pg_size_pretty(pg_relation_size(indexname::regclass)) AS size
FROM pg_indexes
WHERE tablename = 'messages'
ORDER BY pg_relation_size(indexname::regclass) DESC;

SELECT
  avg(octet_length(body_text))::int  AS body_text_raw_avg,
  avg(pg_column_size(body_text))::int AS body_text_stored_avg,
  avg(octet_length(body_html))::int  AS body_html_raw_avg,
  avg(pg_column_size(body_html))::int AS body_html_stored_avg,
  avg(pg_column_size(id) + pg_column_size(account_id) + pg_column_size(uid) + pg_column_size(folder)
      + pg_column_size(message_id) + pg_column_size(subject) + pg_column_size(from_name)
      + pg_column_size(from_email) + pg_column_size(snippet))::int AS metadata_cols_stored_avg
FROM messages;
