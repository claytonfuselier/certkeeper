const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getDb } = require('../db');
const logger = require('../logger');
const { requireAgentAuth } = require('../middleware/agentAuth');

const router = express.Router();
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
      certbot_name: d.certbot_name,
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
  const db = getDb();
  const depId = parseInt(req.params.id, 10);
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
// POST /api/agent/heartbeat — agent check-in / keepalive
// ---------------------------------------------------------------------------
router.post('/heartbeat', (req, res) => {
  const db = getDb();
  const deploymentCount = db.get(
    'SELECT COUNT(*) AS n FROM deployments WHERE agent_id = ?',
    [req.agent.id],
  );

  res.json({
    ok: true,
    agent: {
      id: req.agent.id,
      name: req.agent.name,
    },
    deployments: deploymentCount?.n || 0,
    server_time: new Date().toISOString(),
  });
});

module.exports = router;
