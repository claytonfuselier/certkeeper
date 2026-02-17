const crypto = require('crypto');
const { getDb } = require('../db');
const logger = require('../logger');

/**
 * Hash a raw token with SHA-256 for comparison against stored hashes.
 * We use SHA-256 (not bcrypt) because agent tokens have high entropy
 * (48 bytes / 64 chars) and we need fast lookups on every request.
 */
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Compute the SHA-256 fingerprint of a DER-encoded certificate.
 */
function certFingerprintFromDer(derBuffer) {
  return crypto.createHash('sha256').update(derBuffer).digest('hex');
}

// Columns needed from agents table for mTLS authentication + downstream handlers
const AGENT_AUTH_COLUMNS = `id, name, enabled, status,
  cert_expires_at, prev_cert_expires_at, cert_serial,
  pending_actions, config_version,
  last_contact_at, next_contact_at, last_contact_ip`;

/**
 * Try to authenticate an agent via its mTLS agent certificate.
 * Returns the agent row if successful, null otherwise.
 */
function authenticateViaMTLS(req) {
  // req.socket.getPeerCertificate() returns the agent cert if one was presented
  const peerCert = req.socket?.getPeerCertificate?.(true);
  if (!peerCert || !peerCert.raw) return null;

  // Compute fingerprint of the presented agent cert
  const fingerprint = certFingerprintFromDer(peerCert.raw);

  const db = getDb();

  // Try current cert fingerprint first
  let agent = db.get(
    `SELECT ${AGENT_AUTH_COLUMNS} FROM agents WHERE cert_fingerprint = ?`,
    [fingerprint],
  );

  if (agent) {
    // Check if the current cert has expired
    if (agent.cert_expires_at) {
      const expiresAt = new Date(agent.cert_expires_at + 'Z');
      if (expiresAt <= new Date()) {
        logger.warn('Agent mTLS cert has expired', { agentId: agent.id, name: agent.name, expiresAt: agent.cert_expires_at });
        return null;
      }
    }
    return agent;
  }

  // Fall back to previous cert fingerprint (grace period after renewal)
  agent = db.get(
    `SELECT ${AGENT_AUTH_COLUMNS} FROM agents WHERE prev_cert_fingerprint = ?`,
    [fingerprint],
  );

  if (agent) {
    // The previous cert is only valid until it naturally expires
    if (agent.prev_cert_expires_at) {
      const prevExpiresAt = new Date(agent.prev_cert_expires_at + 'Z');
      if (prevExpiresAt <= new Date()) {
        logger.warn('Agent previous mTLS cert has expired', { agentId: agent.id, name: agent.name, expiresAt: agent.prev_cert_expires_at });
        return null;
      }
    }
    return agent;
  }

  return null;
}

/**
 * Express middleware that authenticates an agent via its mTLS agent certificate.
 *
 * On success, sets:
 *   req.agent — the agent row from the DB
 *   req.agentAuthMethod — 'mtls'
 *
 * Also updates last_contact_at and last_contact_ip on the agent row.
 */
function requireAgentAuth(req, res, next) {
  const agent = authenticateViaMTLS(req);

  if (!agent) {
    return res.status(401).json({
      error: 'Authentication failed. Provide a valid mTLS agent certificate.',
    });
  }

  if (!agent.enabled) {
    return res.status(403).json({ error: 'Agent is disabled' });
  }

  req.agent = agent;
  req.agentAuthMethod = 'mtls';

  // Update last contact — skip for heartbeat requests (the heartbeat handler manages it)
  const isHeartbeat = req.method === 'POST' && req.path === '/heartbeat';
  if (!isHeartbeat) {
    const db = getDb();
    const ip = req.ip || req.socket?.remoteAddress || '';
    db.run(
      "UPDATE agents SET last_contact_at = datetime('now'), last_contact_ip = ?, updated_at = datetime('now') WHERE id = ?",
      [ip, agent.id],
    );
  }

  next();
}

/**
 * Middleware that authenticates via enrollment token.
 * Used only for the POST /api/agent/enroll endpoint.
 *
 * Expects header: Authorization: Bearer cke_<token>
 *
 * On success, sets:
 *   req.enrollmentAgent — the agent row
 */
function requireEnrollmentAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header. Use: Bearer <enrollment_token>' });
  }

  const rawToken = authHeader.slice(7).trim();
  if (!rawToken || !rawToken.startsWith('cke_')) {
    return res.status(401).json({ error: 'Invalid enrollment token format. Expected: cke_<token>' });
  }

  const hash = hashToken(rawToken);
  const db = getDb();

  const agent = db.get(
    `SELECT id, name, enabled, enrollment_expires_at,
            (cert_fingerprint IS NOT NULL) AS already_enrolled
     FROM agents WHERE enrollment_token_hash = ?`,
    [hash],
  );

  if (!agent) {
    return res.status(401).json({ error: 'Invalid enrollment token' });
  }

  if (!agent.enabled) {
    return res.status(403).json({ error: 'Agent is disabled' });
  }

  // Check expiry
  if (agent.enrollment_expires_at) {
    const expiresAt = new Date(agent.enrollment_expires_at + 'Z');
    if (expiresAt <= new Date()) {
      return res.status(401).json({ error: 'Enrollment token has expired. Generate a new one from the admin UI.' });
    }
  }

  // Check if agent already has a cert (already enrolled)
  if (agent.already_enrolled) {
    return res.status(409).json({
      error: 'Agent is already enrolled. Use the admin UI to reset enrollment if needed.',
    });
  }

  req.enrollmentAgent = agent;
  next();
}

module.exports = { requireAgentAuth, requireEnrollmentAuth, hashToken };
