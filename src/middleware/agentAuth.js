const crypto = require('crypto');
const { getDb } = require('../db');

/**
 * Hash a raw token with SHA-256 for comparison against stored hashes.
 * We use SHA-256 (not bcrypt) because agent tokens have high entropy
 * (48 bytes / 64 chars) and we need fast lookups on every request.
 */
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Express middleware that authenticates an agent via Bearer token.
 * Expects header: Authorization: Bearer ck_<token>
 *
 * On success, sets:
 *   req.agent — the agent row from the DB
 *
 * Also updates last_contact_at and last_contact_ip on the agent row.
 */
function requireAgentAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header. Use: Bearer <token>' });
  }

  const rawToken = authHeader.slice(7).trim();
  if (!rawToken || !rawToken.startsWith('ck_')) {
    return res.status(401).json({ error: 'Invalid token format' });
  }

  const hash = hashToken(rawToken);
  const db = getDb();

  const agent = db.get('SELECT * FROM agents WHERE token_hash = ?', [hash]);
  if (!agent) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  if (!agent.enabled) {
    return res.status(403).json({ error: 'Agent is disabled' });
  }

  req.agent = agent;

  // Update last contact (fire-and-forget — don't block the request)
  const ip = req.ip || req.connection?.remoteAddress || '';
  db.run(
    "UPDATE agents SET last_contact_at = datetime('now'), last_contact_ip = ?, updated_at = datetime('now') WHERE id = ?",
    [ip, agent.id],
  );

  next();
}

module.exports = { requireAgentAuth, hashToken };
