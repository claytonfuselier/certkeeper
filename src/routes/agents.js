const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');
const logger = require('../logger');
const { requireAuth } = require('../middleware/auth');
const { hashToken } = require('../middleware/agentAuth');
const { getCACert } = require('../services/ca');

const router = express.Router();
router.use(requireAuth);

// Enrollment token lifetime: 1 hour
const ENROLLMENT_TOKEN_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load deployments for an agent, joined with certificate info. */
function loadDeployments(db, agentId) {
  return db.all(
    `SELECT d.*, c.domains, c.status AS cert_status, c.expires_at, c.certbot_name
     FROM deployments d
     JOIN certificates c ON c.id = d.certificate_id
     WHERE d.agent_id = ?
     ORDER BY d.name`,
    [agentId],
  ).map((d) => ({
    id: d.id,
    name: d.name,
    enabled: !!d.enabled,
    certificate_id: d.certificate_id,
    domains: d.domains ? d.domains.split(' ') : [],
    cert_status: d.cert_status,
    expires_at: d.expires_at,
    last_deployed_at: d.last_deployed_at,
    last_deployed_hash: d.last_deployed_hash,
    created_at: d.created_at,
    updated_at: d.updated_at,
  }));
}

/** Build a full agent response object. */
function agentResponse(db, agent) {
  const base = {
    ...agent,
    enabled: !!agent.enabled,
    deployments: loadDeployments(db, agent.id),
  };

  // Enrollment / mTLS status fields
  base.enrolled = !!agent.cert_fingerprint;
  base.cert_fingerprint_short = agent.cert_fingerprint
    ? agent.cert_fingerprint.slice(0, 16)
    : null;
  base.cert_expires_at = agent.cert_expires_at || null;
  base.cert_serial = agent.cert_serial || 0;
  base.has_enrollment_token = !!agent.enrollment_token_hash;
  base.enrollment_expires_at = agent.enrollment_expires_at || null;
  // Check if enrollment token is still valid
  if (agent.enrollment_token_hash && agent.enrollment_expires_at) {
    const exp = new Date(agent.enrollment_expires_at + 'Z');
    base.enrollment_token_expired = exp <= new Date();
  } else {
    base.enrollment_token_expired = false;
  }

  // Agent heartbeat / status fields
  base.status = agent.status || null;         // 'online', 'offline', or null (unknown)
  base.next_contact_at = agent.next_contact_at || null;
  base.config_version = agent.config_version || 0;

  // Determine if agent has the latest config
  const globalVersionRow = db.get("SELECT value FROM settings WHERE key = 'agent_config_version'");
  const globalVersion = parseInt(globalVersionRow?.value, 10) || 1;
  base.config_current = (agent.config_version || 0) >= globalVersion;

  // Pending actions (for admin visibility)
  let pending = [];
  if (agent.pending_actions) {
    try {
      pending = JSON.parse(agent.pending_actions);
      if (!Array.isArray(pending)) pending = [];
    } catch { pending = []; }
  }
  base.pending_actions = pending;

  // Remove sensitive fields from response
  delete base.enrollment_token_hash;
  delete base.cert_fingerprint;
  delete base.prev_cert_fingerprint;
  delete base.prev_cert_expires_at;

  return base;
}

// ============================= AGENTS ======================================

// ---------------------------------------------------------------------------
// GET /api/agents/ca-cert — download the CA certificate (for agent trust config)
// Must be before /:id to avoid Express matching 'ca-cert' as a param.
// ---------------------------------------------------------------------------
router.get('/ca-cert', (_req, res) => {
  try {
    const caCert = getCACert();
    res.type('application/x-pem-file').send(caCert);
  } catch (err) {
    logger.error('Failed to retrieve CA cert', { error: err.message });
    res.status(500).json({ error: 'Failed to retrieve CA certificate' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/agents — list all agents with their deployments
// ---------------------------------------------------------------------------
router.get('/', (_req, res) => {
  const db = getDb();
  const agents = db.all('SELECT * FROM agents ORDER BY created_at DESC');
  res.json(agents.map((a) => agentResponse(db, a)));
});

// ---------------------------------------------------------------------------
// GET /api/agents/:id — single agent detail
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const db = getDb();
  const agent = db.get('SELECT * FROM agents WHERE id = ?', [req.params.id]);
  if (!agent) return res.status(404).json({ error: 'Not found' });
  res.json(agentResponse(db, agent));
});

// ---------------------------------------------------------------------------
// POST /api/agents — create a new agent
// Body: { name }
// Always creates an mTLS agent with a 1-hour enrollment token for bootstrap.
// ---------------------------------------------------------------------------
router.post('/', (req, res) => {
  const { name } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length < 1) {
    return res.status(400).json({ error: 'Agent name is required' });
  }

  const db = getDb();

  // Generate enrollment token: cke_<64 hex chars> (valid 1 hour)
  const rawSecret = crypto.randomBytes(32).toString('hex');
  const enrollToken = `cke_${rawSecret}`;
  const enrollHash = hashToken(enrollToken);
  const expiresAt = new Date(Date.now() + ENROLLMENT_TOKEN_TTL_MS).toISOString().replace('T', ' ').replace('Z', '');

  const { lastInsertRowid } = db.run(
    "INSERT INTO agents (name, enrollment_token_hash, enrollment_expires_at) VALUES (?, ?, ?)",
    [name.trim(), enrollHash, expiresAt],
  );

  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'agent_created', JSON.stringify({ id: lastInsertRowid, name: name.trim() }),
  ]);

  logger.info('Agent created', { id: lastInsertRowid, name: name.trim() });

  const agent = db.get('SELECT * FROM agents WHERE id = ?', [lastInsertRowid]);
  res.status(201).json({
    agent: agentResponse(db, agent),
    enrollmentToken: enrollToken, // shown ONCE
    enrollmentExpiresAt: expiresAt,
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/agents/:id — update agent (name, enabled)
// ---------------------------------------------------------------------------
router.patch('/:id', (req, res) => {
  const db = getDb();
  const agent = db.get('SELECT * FROM agents WHERE id = ?', [req.params.id]);
  if (!agent) return res.status(404).json({ error: 'Not found' });

  const { name, enabled } = req.body || {};

  if (typeof name === 'string' && name.trim().length > 0) {
    db.run("UPDATE agents SET name = ?, updated_at = datetime('now') WHERE id = ?", [name.trim(), agent.id]);
  }
  if (typeof enabled === 'boolean') {
    db.run("UPDATE agents SET enabled = ?, updated_at = datetime('now') WHERE id = ?", [enabled ? 1 : 0, agent.id]);
  }

  const updated = db.get('SELECT * FROM agents WHERE id = ?', [agent.id]);
  res.json(agentResponse(db, updated));
});

// ---------------------------------------------------------------------------
// POST /api/agents/:id/regenerate-token — reset enrollment, generate new enrollment token
// Clears the existing client cert and generates a fresh 1-hour enrollment token.
// ---------------------------------------------------------------------------
router.post('/:id/regenerate-token', (req, res) => {
  const db = getDb();
  const agent = db.get('SELECT * FROM agents WHERE id = ?', [req.params.id]);
  if (!agent) return res.status(404).json({ error: 'Not found' });

  // Generate new enrollment token and clear existing cert (re-enrollment)
  const rawSecret = crypto.randomBytes(32).toString('hex');
  const enrollToken = `cke_${rawSecret}`;
  const enrollHash = hashToken(enrollToken);
  const expiresAt = new Date(Date.now() + ENROLLMENT_TOKEN_TTL_MS).toISOString().replace('T', ' ').replace('Z', '');

  db.run(
    `UPDATE agents SET
      enrollment_token_hash = ?, enrollment_expires_at = ?,
      cert_fingerprint = NULL, cert_expires_at = NULL,
      prev_cert_fingerprint = NULL, prev_cert_expires_at = NULL,
      cert_serial = cert_serial + 1,
      status = NULL, next_contact_at = NULL,
      config_version = 0, pending_actions = NULL,
      updated_at = datetime('now')
    WHERE id = ?`,
    [enrollHash, expiresAt, agent.id],
  );

  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'agent_enrollment_reset', JSON.stringify({ id: agent.id, name: agent.name }),
  ]);

  logger.info('Agent enrollment reset — new enrollment token generated', { id: agent.id, name: agent.name });

  res.json({
    enrollmentToken: enrollToken,
    enrollmentExpiresAt: expiresAt,
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/agents/:id — delete an agent and all its deployments
// ---------------------------------------------------------------------------
router.delete('/:id', (req, res) => {
  const db = getDb();
  const agent = db.get('SELECT * FROM agents WHERE id = ?', [req.params.id]);
  if (!agent) return res.status(404).json({ error: 'Not found' });

  // CASCADE should handle deployments, but be explicit
  db.run('DELETE FROM deployments WHERE agent_id = ?', [agent.id]);
  db.run('DELETE FROM agents WHERE id = ?', [agent.id]);

  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'agent_deleted', JSON.stringify({ id: agent.id, name: agent.name }),
  ]);

  logger.info('Agent deleted', { id: agent.id, name: agent.name });

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/agents/:id/actions — queue an action for an agent
// Body: { action: "renew_agent_cert" | "update_agent" }
// The action is stored in pending_actions and delivered on next heartbeat.
// ---------------------------------------------------------------------------
router.post('/:id/actions', (req, res) => {
  const db = getDb();
  const agent = db.get('SELECT * FROM agents WHERE id = ?', [req.params.id]);
  if (!agent) return res.status(404).json({ error: 'Not found' });

  const { action } = req.body || {};
  const validActions = ['renew_agent_cert', 'update_agent'];

  if (!action || !validActions.includes(action)) {
    return res.status(400).json({ error: `action must be one of: ${validActions.join(', ')}` });
  }

  // Parse existing pending actions and append
  let pending = [];
  if (agent.pending_actions) {
    try {
      pending = JSON.parse(agent.pending_actions);
      if (!Array.isArray(pending)) pending = [];
    } catch {
      pending = [];
    }
  }

  // Don't duplicate the same action
  if (!pending.includes(action)) {
    pending.push(action);
  }

  db.run(
    "UPDATE agents SET pending_actions = ?, updated_at = datetime('now') WHERE id = ?",
    [JSON.stringify(pending), agent.id],
  );

  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'agent_action_queued',
    JSON.stringify({ agentId: agent.id, agentName: agent.name, action }),
  ]);

  logger.info('Action queued for agent', { agentId: agent.id, agentName: agent.name, action });

  res.json({ ok: true, pending_actions: pending });
});

// ============================ DEPLOYMENTS ==================================

// ---------------------------------------------------------------------------
// GET /api/agents/:id/deployments — list deployments for an agent
// ---------------------------------------------------------------------------
router.get('/:id/deployments', (req, res) => {
  const db = getDb();
  const agent = db.get('SELECT id FROM agents WHERE id = ?', [req.params.id]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(loadDeployments(db, agent.id));
});

// ---------------------------------------------------------------------------
// POST /api/agents/:id/deployments — create a deployment
// Body: { name, certificateId }
// ---------------------------------------------------------------------------
router.post('/:id/deployments', (req, res) => {
  const db = getDb();
  const agent = db.get('SELECT * FROM agents WHERE id = ?', [req.params.id]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const { name, certificateId } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length < 1) {
    return res.status(400).json({ error: 'Deployment name is required' });
  }
  if (!certificateId || typeof certificateId !== 'number') {
    return res.status(400).json({ error: 'certificateId is required and must be a number' });
  }

  const cert = db.get('SELECT id FROM certificates WHERE id = ?', [certificateId]);
  if (!cert) {
    return res.status(404).json({ error: 'Certificate not found' });
  }

  const { lastInsertRowid } = db.run(
    'INSERT INTO deployments (agent_id, certificate_id, name) VALUES (?, ?, ?)',
    [agent.id, cert.id, name.trim()],
  );

  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'deployment_created',
    JSON.stringify({ id: lastInsertRowid, agentId: agent.id, agentName: agent.name, certId: cert.id, name: name.trim() }),
  ]);

  logger.info('Deployment created', { id: lastInsertRowid, agentId: agent.id, certId: cert.id, name: name.trim() });

  res.status(201).json(loadDeployments(db, agent.id).find((d) => d.id === lastInsertRowid));
});

// ---------------------------------------------------------------------------
// PATCH /api/agents/:agentId/deployments/:depId — update a deployment
// Body: { name?, certificateId?, enabled? }
// ---------------------------------------------------------------------------
router.patch('/:agentId/deployments/:depId', (req, res) => {
  const db = getDb();
  const dep = db.get(
    'SELECT * FROM deployments WHERE id = ? AND agent_id = ?',
    [req.params.depId, req.params.agentId],
  );
  if (!dep) return res.status(404).json({ error: 'Deployment not found' });

  const { name, certificateId, enabled } = req.body || {};

  if (typeof name === 'string' && name.trim().length > 0) {
    db.run("UPDATE deployments SET name = ?, updated_at = datetime('now') WHERE id = ?", [name.trim(), dep.id]);
  }
  if (typeof certificateId === 'number') {
    const cert = db.get('SELECT id FROM certificates WHERE id = ?', [certificateId]);
    if (!cert) return res.status(404).json({ error: 'Certificate not found' });
    db.run("UPDATE deployments SET certificate_id = ?, updated_at = datetime('now') WHERE id = ?", [cert.id, dep.id]);
  }
  if (typeof enabled === 'boolean') {
    db.run("UPDATE deployments SET enabled = ?, updated_at = datetime('now') WHERE id = ?", [enabled ? 1 : 0, dep.id]);
  }

  const updated = loadDeployments(db, dep.agent_id).find((d) => d.id === dep.id);
  res.json(updated);
});

// ---------------------------------------------------------------------------
// DELETE /api/agents/:agentId/deployments/:depId — remove a deployment
// ---------------------------------------------------------------------------
router.delete('/:agentId/deployments/:depId', (req, res) => {
  const db = getDb();
  const dep = db.get(
    'SELECT * FROM deployments WHERE id = ? AND agent_id = ?',
    [req.params.depId, req.params.agentId],
  );
  if (!dep) return res.status(404).json({ error: 'Deployment not found' });

  db.run('DELETE FROM deployments WHERE id = ?', [dep.id]);

  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'deployment_deleted',
    JSON.stringify({ id: dep.id, agentId: dep.agent_id, certId: dep.certificate_id, name: dep.name }),
  ]);

  logger.info('Deployment deleted', { id: dep.id, agentId: dep.agent_id });

  res.json({ ok: true });
});

module.exports = router;
