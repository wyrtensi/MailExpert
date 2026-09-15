-- Mailboxes are serviced by the server, so how often they sync is one install-wide setting
-- instead of a preference of whoever signed in. Seed it from the user who owns the most
-- mailboxes when their value is one the settings screen offers, then drop the per-user keys.
WITH top_owner AS (
  SELECT u.preferences
    FROM users u
    JOIN email_accounts a ON a.user_id = u.id
   GROUP BY u.id
   ORDER BY COUNT(*) DESC, u.created_at ASC, u.id ASC
   LIMIT 1
)
INSERT INTO system_settings (key, value, updated_at)
SELECT 'sync_interval_sec',
       COALESCE((SELECT o.preferences->>'syncInterval' FROM top_owner o
                  WHERE o.preferences->>'syncInterval' IN ('15', '30', '60', '120')), '60'),
       NOW()
UNION ALL
SELECT 'folder_sync_interval_sec',
       COALESCE((SELECT o.preferences->>'folderSyncInterval' FROM top_owner o
                  WHERE o.preferences->>'folderSyncInterval' IN ('0', '900', '1800', '3600')), '1800'),
       NOW()
ON CONFLICT (key) DO NOTHING;

UPDATE users
   SET preferences = preferences - 'syncInterval' - 'folderSyncInterval'
 WHERE preferences ?| ARRAY['syncInterval', 'folderSyncInterval'];
