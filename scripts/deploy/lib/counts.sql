-- Row counts recorded with every dump (pg-dump.sh) and compared after every restore
-- (backup.sh --verify, restore.sh): one statement, one line of JSON.
SELECT json_build_object(
  'schema_migrations', (SELECT count(*) FROM schema_migrations),
  'users', (SELECT count(*) FROM users),
  'email_accounts', (SELECT count(*) FROM email_accounts),
  'google_oauth_apps', (SELECT count(*) FROM google_oauth_apps));
