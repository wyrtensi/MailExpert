-- Google sign-in mode identifies people by a verified email and lets an admin turn a user
-- off without deleting them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- OIDC and password reset matched addresses against username, so a username that is an
-- address becomes the email — unless another username is the same address in another case.
UPDATE users u
   SET email = lower(u.username)
 WHERE u.email IS NULL
   AND u.username ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
   AND NOT EXISTS (
     SELECT 1 FROM users o WHERE o.id <> u.id AND lower(o.username) = lower(u.username)
   );

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email)) WHERE email IS NOT NULL;
