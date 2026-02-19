const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getDb, toSqliteDatetime, parsePendingActions, parseIntId } = require('../db');
const logger = require('../logger');
const { requireAgentAuth, requireEnrollmentAuth } = require('../middleware/agentAuth');
const { signCSR, getCACert, AGENT_CERT_DAYS, revokeAgentCert } = require('../services/ca');

const router = express.Router();

// ---------------------------------------------------------------------------
// Unauthenticated routes (enrollment uses its own auth middleware)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// POST /api/agent/enroll — exchange an enrollment token + CSR for a signed
// agent certificate. This is the one-time bootstrap endpoint.
//
// Auth: Authorization: Bearer cke_<enrollment_token>
// Body: { csr: "<PEM-encoded PKCS#10 CSR>" }
// Response: { certificate, ca_certificate, fingerprint, expires_at, agent }
// ---------------------------------------------------------------------------
router.post('/enroll', requireEnrollmentAuth, (req, res) => {
  const { csr } = req.body || {};
  const agent = req.enrollmentAgent;

  if (!csr || typeof csr !== 'string' || !csr.includes('BEGIN CERTIFICATE REQUEST')) {
    return res.status(400).json({
      error: 'Request body must include a PEM-encoded CSR in the "csr" field.',
    });
  }

  try {
    const { certPem, fingerprint, serialHex, expiresAt } = signCSR(csr, agent.name);
    const caCert = getCACert();
    const db = getDb();

    // Check for fingerprint collision (astronomically unlikely but enforce uniqueness)
    const expiresAtStr = toSqliteDatetime(expiresAt);
    const fpCollision = db.get(
      'SELECT id, name FROM agents WHERE (cert_fingerprint = ? OR prev_cert_fingerprint = ?) AND id != ?',
      [fingerprint, fingerprint, agent.id],
    );
    if (fpCollision) {
      logger.warn('Enrollment fingerprint collision', { agentId: agent.id, collidesWith: fpCollision.id });
      return res.status(409).json({
        error: 'Certificate fingerprint collision. Please retry enrollment with a new key pair and CSR.',
        retry: true,
      });
    }

    // Read heartbeat interval for initial next_contact_at
    const intervalRow = db.get("SELECT value FROM settings WHERE key = 'agent_heartbeat_interval'");
    const intervalSeconds = parseInt(intervalRow?.value, 10) || 180;
    const nextContactAt = toSqliteDatetime(new Date(Date.now() + intervalSeconds * 1000));

    // Store the cert fingerprint, serial, and expiry, burn the enrollment token,
    // and record initial contact info — all in a single UPDATE.
    const ip = req.ip || req.socket?.remoteAddress || '';
    db.run(
      `UPDATE agents SET
        cert_fingerprint = ?,
        cert_expires_at = ?,
        cert_serial_hex = ?,
        enrollment_token_hash = NULL,
        enrollment_expires_at = NULL,
        status = 'online',
        next_contact_at = ?,
        last_contact_at = datetime('now'),
        last_contact_ip = ?,
        updated_at = datetime('now')
      WHERE id = ?`,
      [fingerprint, expiresAtStr, serialHex, nextContactAt, ip, agent.id],
    );

    db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
      'agent_enrolled',
      JSON.stringify({
        id: agent.id,
        name: agent.name,
        fingerprint: fingerprint.slice(0, 16),
        expiresAt: expiresAtStr,
      }),
    ]);

    logger.info('Agent enrolled via mTLS', {
      id: agent.id,
      name: agent.name,
      fingerprint: fingerprint.slice(0, 16),
    });

    res.json({
      certificate: certPem,
      ca_certificate: caCert,
      fingerprint,
      expires_at: expiresAtStr,
      cert_lifetime_days: AGENT_CERT_DAYS,
      agent: {
        id: agent.id,
        name: agent.name,
      },
    });
  } catch (err) {
    logger.error('Enrollment failed', { agentId: agent.id, error: err.message });
    res.status(400).json({ error: `Enrollment failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// GET /api/agent/time — server clock endpoint for agent time-sync
// Returns the server's current time so agents can detect clock skew and
// base expiry calculations on server time rather than their local clock.
// Unauthenticated — agents need this before enrollment and when their
// local clock thinks the cert has expired (preventing mTLS auth).
// ---------------------------------------------------------------------------
router.get('/time', (_req, res) => {
  res.json({ server_time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// All remaining routes require agent auth (mTLS or bearer token)
// ---------------------------------------------------------------------------
router.use(requireAgentAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a short content hash for a certificate's fullchain PEM on disk.
 * Returns null if the cert file doesn't exist.
 */
function certContentHash(certbotName) {
  if (!certbotName) return null;
  const certPath = path.join(config.paths.certbotConfig, 'live', certbotName, 'fullchain.pem');
  try {
    if (!fs.existsSync(certPath)) return null;
    const pem = fs.readFileSync(certPath, 'utf-8');
    return crypto.createHash('sha256').update(pem).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET /api/agent/deployments — list this agent's deployments
// This is the primary endpoint the agent calls to discover its work.
// Each deployment includes cert metadata + a content_hash so the agent
// can detect renewals without downloading the full bundle.
// ---------------------------------------------------------------------------
router.get('/deployments', (req, res) => {
  const db = getDb();
  const agentId = req.agent.id;

  const deployments = db.all(
    `SELECT d.id, d.name, d.enabled, d.certificate_id, d.last_deployed_at,
            d.last_deployed_hash, d.created_at, d.updated_at,
            c.domains, c.status AS cert_status, c.certbot_name, c.expires_at,
            c.issued_at, c.last_renewed_at, c.staging
     FROM deployments d
     JOIN certificates c ON c.id = d.certificate_id
     WHERE d.agent_id = ?
     ORDER BY d.name`,
    [agentId],
  );

  const result = deployments.map((d) => {
    const contentHash = (d.cert_status === 'active') ? certContentHash(d.certbot_name) : null;

    return {
      id: d.id,
      name: d.name,
      enabled: !!d.enabled,
      certificate_id: d.certificate_id,
      domains: d.domains ? d.domains.split(' ') : [],
      cert_status: d.cert_status,
      expires_at: d.expires_at,
      issued_at: d.issued_at,
      last_renewed_at: d.last_renewed_at,
      staging: !!d.staging,
      content_hash: contentHash,
      last_deployed_at: d.last_deployed_at,
      last_deployed_hash: d.last_deployed_hash,
    };
  });

  res.json(result);
});

// ---------------------------------------------------------------------------
// GET /api/agent/deployments/:id/bundle — download cert+key for a deployment
// The agent fetches this when it detects content_hash has changed.
// ---------------------------------------------------------------------------
router.get('/deployments/:id/bundle', (req, res) => {
  const depId = parseIntId(req.params.id);
  if (!depId) return res.status(400).json({ error: 'Invalid deployment ID' });
  const db = getDb();
  const agentId = req.agent.id;

  const dep = db.get(
    'SELECT d.*, c.certbot_name, c.domains, c.status AS cert_status, c.expires_at, c.issued_at FROM deployments d JOIN certificates c ON c.id = d.certificate_id WHERE d.id = ? AND d.agent_id = ?',
    [depId, agentId],
  );
  if (!dep) {
    return res.status(404).json({ error: 'Deployment not found or does not belong to this agent' });
  }

  if (!dep.certbot_name) {
    return res.status(400).json({ error: 'Certificate has no certbot name — not yet issued' });
  }

  if (!dep.enabled) {
    return res.status(403).json({ error: 'Deployment is disabled' });
  }

  if (dep.cert_status !== 'active') {
    return res.status(400).json({ error: `Certificate is not active (status: ${dep.cert_status})` });
  }

  // Read cert files from certbot's live directory
  const liveDir = path.join(config.paths.certbotConfig, 'live', dep.certbot_name);
  const fullchainPath = path.join(liveDir, 'fullchain.pem');
  const certPath = path.join(liveDir, 'cert.pem');
  const keyPath = path.join(liveDir, 'privkey.pem');

  if (!fs.existsSync(fullchainPath) || !fs.existsSync(keyPath)) {
    return res.status(404).json({ error: 'Certificate files not found on disk' });
  }

  const fullchain = fs.readFileSync(fullchainPath, 'utf-8');
  const key = fs.readFileSync(keyPath, 'utf-8');
  let leafCert = null;
  if (fs.existsSync(certPath)) {
    leafCert = fs.readFileSync(certPath, 'utf-8');
  }

  const contentHash = crypto.createHash('sha256').update(fullchain).digest('hex').slice(0, 16);

  // Update the deployment's last_deployed tracking
  db.run(
    "UPDATE deployments SET last_deployed_at = datetime('now'), last_deployed_hash = ?, updated_at = datetime('now') WHERE id = ?",
    [contentHash, dep.id],
  );

  logger.info('Agent downloaded deployment bundle', {
    agentId: req.agent.id,
    agentName: req.agent.name,
    deploymentId: dep.id,
    deploymentName: dep.name,
    certDomains: dep.domains,
  });

  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'agent_deploy_download',
    JSON.stringify({ agentId: req.agent.id, agentName: req.agent.name, deploymentId: dep.id, deploymentName: dep.name }),
  ]);

  res.json({
    deployment_id: dep.id,
    deployment_name: dep.name,
    certificate_id: dep.certificate_id,
    domains: dep.domains ? dep.domains.split(' ') : [],
    expires_at: dep.expires_at,
    issued_at: dep.issued_at,
    content_hash: contentHash,
    fullchain,
    cert: leafCert,
    key,
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent/renew-cert — renew the agent's mTLS agent certificate
// The agent calls this while its current cert is still valid. It generates
// a new key pair, sends a CSR, and receives a fresh signed cert.
//
// Auth: mTLS (current agent cert) — only available to mTLS agents
// Body: { csr: "<PEM-encoded PKCS#10 CSR>" }
// Response: { certificate, ca_certificate, fingerprint, expires_at }
// ---------------------------------------------------------------------------
router.post('/renew-cert', async (req, res) => {
  const { csr } = req.body || {};
  const agent = req.agent;

  if (!csr || typeof csr !== 'string' || !csr.includes('BEGIN CERTIFICATE REQUEST')) {
    return res.status(400).json({
      error: 'Request body must include a PEM-encoded CSR in the "csr" field.',
    });
  }

  try {
    const { certPem, fingerprint, serialHex, expiresAt } = signCSR(csr, agent.name);
    const caCert = getCACert();
    const db = getDb();

    const expiresAtStr = toSqliteDatetime(expiresAt);

    // Check for fingerprint collision before updating
    const fpCollision = db.get(
      'SELECT id, name FROM agents WHERE (cert_fingerprint = ? OR prev_cert_fingerprint = ?) AND id != ?',
      [fingerprint, fingerprint, agent.id],
    );
    if (fpCollision) {
      logger.warn('Renewal fingerprint collision', { agentId: agent.id, collidesWith: fpCollision.id });
      return res.status(409).json({
        error: 'Certificate fingerprint collision. Please retry with a new key pair and CSR.',
        retry: true,
      });
    }

    // Revoke the old agent certificate via CRL (if serial is known).
    // The old cert's fingerprint is preserved for a grace period (prev_cert_fingerprint)
    // so the agent can still authenticate at the application layer during transition,
    // but the cert is properly revoked at the X.509 level.
    if (agent.cert_serial_hex) {
      try {
        await revokeAgentCert(agent.cert_serial_hex, agent.name);
      } catch (err) {
        logger.warn('Failed to revoke old agent cert on renewal', { agentId: agent.id, error: err.message });
      }
    }

    // Preserve the old fingerprint so both certs are accepted until the old one expires
    db.run(
      `UPDATE agents SET
        prev_cert_fingerprint = cert_fingerprint,
        prev_cert_expires_at = cert_expires_at,
        cert_fingerprint = ?,
        cert_expires_at = ?,
        cert_serial_hex = ?,
        cert_serial = cert_serial + 1,
        updated_at = datetime('now')
      WHERE id = ?`,
      [fingerprint, expiresAtStr, serialHex, agent.id],
    );

    db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
      'agent_cert_renewed',
      JSON.stringify({
        id: agent.id,
        name: agent.name,
        fingerprint: fingerprint.slice(0, 16),
        expiresAt: expiresAtStr,
      }),
    ]);

    logger.info('Agent mTLS certificate renewed', {
      id: agent.id,
      name: agent.name,
      fingerprint: fingerprint.slice(0, 16),
    });

    res.json({
      certificate: certPem,
      ca_certificate: caCert,
      fingerprint,
      expires_at: expiresAtStr,
      cert_lifetime_days: AGENT_CERT_DAYS,
    });
  } catch (err) {
    logger.error('Agent cert renewal failed', { agentId: agent.id, error: err.message });
    res.status(400).json({ error: `Certificate renewal failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// POST /api/agent/heartbeat — agent check-in / keepalive
//
// The agent sends its current config_version so the server knows whether
// the agent has picked up the latest settings. The response includes the
// latest config_version, heartbeat_interval, and any pending actions.
//
// If the agent was previously offline, this transitions it back to 'online'
// and logs the state change.
// ---------------------------------------------------------------------------
router.post('/heartbeat', (req, res) => {
  const db = getDb();
  const agent = req.agent;
  const agentConfigVersion = typeof req.body?.config_version === 'number' ? req.body.config_version : 0;

  // Read global agent monitoring settings
  const intervalRow = db.get("SELECT value FROM settings WHERE key = 'agent_heartbeat_interval'");
  const globalVersion = db.get("SELECT value FROM settings WHERE key = 'agent_config_version'");
  const intervalSeconds = parseInt(intervalRow?.value, 10) || 180;
  const configVersion = parseInt(globalVersion?.value, 10) || 1;

  // Calculate next expected contact time
  const nextContactAt = toSqliteDatetime(new Date(Date.now() + intervalSeconds * 1000));

  // Detect state transition: offline → online
  const wasOffline = agent.status === 'offline';
  if (wasOffline) {
    logger.info('Agent came back online', { id: agent.id, name: agent.name });
    db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
      'agent_online',
      JSON.stringify({ id: agent.id, name: agent.name }),
    ]);
    // TODO: trigger agent_online notification via notification service
  }

  // Read and clear pending actions
  const actions = parsePendingActions(agent);

  // Update agent state + last_contact info (middleware skips this for heartbeats)
  const ip = req.ip || req.socket?.remoteAddress || '';
  db.run(
    `UPDATE agents SET
      status = 'online',
      next_contact_at = ?,
      config_version = ?,
      pending_actions = NULL,
      last_contact_at = datetime('now'),
      last_contact_ip = ?,
      updated_at = datetime('now')
    WHERE id = ?`,
    [nextContactAt, agentConfigVersion, ip, agent.id],
  );

  const deploymentCount = db.get(
    'SELECT COUNT(*) AS n FROM deployments WHERE agent_id = ?',
    [agent.id],
  );

  const response = {
    ok: true,
    agent: {
      id: agent.id,
      name: agent.name,
    },
    deployments: deploymentCount?.n || 0,
    server_time: new Date().toISOString(),
    heartbeat_interval: intervalSeconds,
    config_version: configVersion,
    actions,
  };

  // Include cert expiry so the agent can decide when to renew
  if (agent.cert_expires_at) {
    response.cert_expires_at = agent.cert_expires_at;
  }

  res.json(response);
});

module.exports = router;
