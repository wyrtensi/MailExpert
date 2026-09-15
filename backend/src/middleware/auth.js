import { query } from '../services/db.js';

// A disabled user loses access at the next request, whatever session they still hold.
function refuseDisabled(req, res) {
  req.session.destroy(() => {});
  return res.status(403).json({ error: 'user_disabled', code: 'user_disabled' });
}

export async function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const result = await query('SELECT id, disabled_at FROM users WHERE id = $1', [req.session.userId]);
    if (!result.rows.length) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (result.rows[0].disabled_at) return refuseDisabled(req, res);
    next();
  } catch (err) {
    next(err);
  }
}

// Always verifies against the DB so a revoked or disabled admin can't keep using
// a stale session. The extra query is cheap and only hits admin routes.
export async function requireAdmin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const result = await query(
      'SELECT is_admin, disabled_at FROM users WHERE id = $1',
      [req.session.userId]
    );
    const user = result.rows[0];
    if (user?.disabled_at) return refuseDisabled(req, res);
    if (!user?.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    next(err);
  }
}
