/**
 * Express middleware that requires an authenticated session.
 * Allows API routes under /api to return 401 JSON, and
 * redirects browser requests to /login.
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  return res.redirect('/login');
}

module.exports = { requireAuth };
