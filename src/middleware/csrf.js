/**
 * CSRF protection middleware.
 *
 * Validates a synchronizer token on state-changing requests (POST, PUT,
 * PATCH, DELETE) for session-authenticated routes. The CSRF token is
 * stored in the session and must be sent by the client as the
 * X-CSRF-Token header.
 *
 * Exempt:
 *   - GET / HEAD / OPTIONS (read-only)
 *   - /api/agent/* (mTLS-authenticated, not cookie-based)
 *   - /api/auth/login and /api/auth/setup (session doesn't exist yet)
 *   - Requests with no authenticated session
 */
function csrfProtection(req, res, next) {
  // Read-only methods are safe
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  // Agent API uses mTLS, not cookies — CSRF doesn't apply
  if (req.originalUrl.startsWith('/api/agent/')) return next();

  // Login and setup create the session — no token to verify yet
  if (req.originalUrl === '/api/auth/login' || req.originalUrl === '/api/auth/setup') return next();

  // Only enforce for authenticated sessions
  if (!req.session?.user) return next();

  // Verify the CSRF token
  const token = req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }

  next();
}

module.exports = { csrfProtection };
