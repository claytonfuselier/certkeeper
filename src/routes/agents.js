const express = require('express');
const crypto = require('crypto');
const { getDb, toSqliteDatetime, parsePendingActions, parseIntId } = require('../db');
const logger = require('../logger');
const { requireAuth } = require('../middleware/auth');
const { hashToken } = require('../middleware/agentAuth');
const { getCACert, revokeAgentCert } = require('../services/ca');
const { getTlsSource, isServiceCert } = require('../services/tls');

const router = express.Router();
router.use(requireAuth);

// Enrollment token lifetime: 1 hour
const ENROLLMENT_TOKEN_TTL_MS = 60 * 60 * 1000;

// Columns for admin agent queries — uses computed columns to avoid
// leaking raw cert_fingerprint and enrollment_token_hash.
const AGENT_COLUMNS = `id, name, enabled, status,
  cert_expires_at, cert_serial,
  (cert_fingerprint IS NOT NULL) AS enrolled,
  SUBSTR(cert_fingerprint, 1, 16) AS cert_fingerprint_short,
  (enrollment_token_hash IS NOT NULL) AS has_enrollment_token,
  enrollment_expires_at,
  config_version, pending_actions,
  last_contact_at, last_contact_ip, next_contact_at,
  created_at, updated_at`;

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
    enrolled: !!agent.enrolled,
    has_enrollment_token: !!agent.has_enrollment_token,
    deployments: loadDeployments(db, agent.id),
  };

  base.cert_fingerprint_short = agent.cert_fingerprint_short || null;
  base.cert_expires_at = agent.cert_expires_at || null;
  base.cert_serial = agent.cert_serial || 0;
  base.enrollment_expires_at = agent.enrollment_expires_at || null;
  // Check if enrollment token is still valid
  if (agent.has_enrollment_token && agent.enrollment_expires_at) {
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

  base.pending_actions = parsePendingActions(agent);

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
  const agents = db.all(`SELECT ${AGENT_COLUMNS} FROM agents ORDER BY created_at DESC`);
  res.json(agents.map((a) => agentResponse(db, a)));
});

// ---------------------------------------------------------------------------
// GET /api/agents/:id — single agent detail
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid agent ID' });
  const db = getDb();
  const agent = db.get(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`, [id]);
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

  // Block agent creation when server TLS is self-signed
  if (getTlsSource() === 'self-signed') {
    return res.status(400).json({
      error: 'Cannot create agents while the server is using a self-signed TLS certificate. Agents cannot verify the server identity during enrollment. Switch to a managed or custom certificate in Settings → TLS first.',
    });
  }

  if (!name || typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 255) {
    return res.status(400).json({ error: 'Agent name is required (max 255 characters)' });
  }

  const db = getDb();

  // Check for duplicate name
  const existing = db.get('SELECT id FROM agents WHERE name = ?', [name.trim()]);
  if (existing) {
    return res.status(409).json({ error: `An agent named "${name.trim()}" already exists.` });
  }

  // Generate enrollment token: cke_<64 hex chars> (valid 1 hour)
  const rawSecret = crypto.randomBytes(32).toString('hex');
  const enrollToken = `cke_${rawSecret}`;
  const enrollHash = hashToken(enrollToken);
  const expiresAt = toSqliteDatetime(new Date(Date.now() + ENROLLMENT_TOKEN_TTL_MS));

  const { lastInsertRowid } = db.run(
    "INSERT INTO agents (name, enrollment_token_hash, enrollment_expires_at) VALUES (?, ?, ?)",
    [name.trim(), enrollHash, expiresAt],
  );

  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'agent_created', JSON.stringify({ id: lastInsertRowid, name: name.trim() }),
  ]);

  logger.info('Agent created', { id: lastInsertRowid, name: name.trim() });

  const agent = db.get(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`, [lastInsertRowid]);
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
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid agent ID' });
  const db = getDb();
  const agent = db.get('SELECT id FROM agents WHERE id = ?', [id]);
  if (!agent) return res.status(404).json({ error: 'Not found' });

  const { name, enabled } = req.body || {};

  if (typeof name === 'string' && name.trim().length > 0) {
    // Check for duplicate name (excluding this agent)
    const duplicate = db.get('SELECT id FROM agents WHERE name = ? AND id != ?', [name.trim(), agent.id]);
    if (duplicate) {
      return res.status(409).json({ error: `An agent named "${name.trim()}" already exists.` });
    }
    db.run("UPDATE agents SET name = ?, updated_at = datetime('now') WHERE id = ?", [name.trim(), agent.id]);
  }
  if (typeof enabled === 'boolean') {
    db.run("UPDATE agents SET enabled = ?, updated_at = datetime('now') WHERE id = ?", [enabled ? 1 : 0, agent.id]);
  }

  const updated = db.get(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`, [agent.id]);
  res.json(agentResponse(db, updated));
});

// ---------------------------------------------------------------------------
// POST /api/agents/:id/regenerate-token — reset enrollment, generate new enrollment token
// Clears the existing agent cert and generates a fresh 1-hour enrollment token.
// ---------------------------------------------------------------------------
router.post('/:id/regenerate-token', (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid agent ID' });
  const db = getDb();
  const agent = db.get('SELECT id, name, cert_serial_hex FROM agents WHERE id = ?', [id]);
  if (!agent) return res.status(404).json({ error: 'Not found' });

  // Generate new enrollment token and clear existing cert (re-enrollment)
  const rawSecret = crypto.randomBytes(32).toString('hex');
  const enrollToken = `cke_${rawSecret}`;
  const enrollHash = hashToken(enrollToken);
  const expiresAt = toSqliteDatetime(new Date(Date.now() + ENROLLMENT_TOKEN_TTL_MS));

  // Revoke the old agent certificate via CRL before re-enrollment
  if (agent.cert_serial_hex) {
    revokeAgentCert(agent.cert_serial_hex, agent.name);
  }

  db.run(
    `UPDATE agents SET
      enrollment_token_hash = ?, enrollment_expires_at = ?,
      cert_fingerprint = NULL, cert_expires_at = NULL,
      prev_cert_fingerprint = NULL, prev_cert_expires_at = NULL,
      cert_serial = cert_serial + 1,
      cert_serial_hex = NULL,
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
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid agent ID' });
  const db = getDb();
  const agent = db.get('SELECT id, name, cert_serial_hex FROM agents WHERE id = ?', [id]);
  if (!agent) return res.status(404).json({ error: 'Not found' });

  // Revoke the agent's mTLS certificate via CRL
  if (agent.cert_serial_hex) {
    revokeAgentCert(agent.cert_serial_hex, agent.name);
  }

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
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid agent ID' });
  const db = getDb();
  const agent = db.get('SELECT id, name, pending_actions FROM agents WHERE id = ?', [id]);
  if (!agent) return res.status(404).json({ error: 'Not found' });

  const { action } = req.body || {};
  const validActions = ['renew_agent_cert', 'update_agent'];

  if (!action || !validActions.includes(action)) {
    return res.status(400).json({ error: `action must be one of: ${validActions.join(', ')}` });
  }

  let pending = parsePendingActions(agent);

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
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid agent ID' });
  const db = getDb();
  const agent = db.get('SELECT id FROM agents WHERE id = ?', [id]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(loadDeployments(db, agent.id));
});

// ---------------------------------------------------------------------------
// POST /api/agents/:id/deployments — create a deployment
// Body: { name, certificateId }
// ---------------------------------------------------------------------------
router.post('/:id/deployments', (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid agent ID' });
  const db = getDb();
  const agent = db.get('SELECT id, name FROM agents WHERE id = ?', [id]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const { name, certificateId } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 255) {
    return res.status(400).json({ error: 'Deployment name is required (max 255 characters)' });
  }
  if (!certificateId || typeof certificateId !== 'number') {
    return res.status(400).json({ error: 'certificateId is required and must be a number' });
  }

  const cert = db.get('SELECT id FROM certificates WHERE id = ?', [certificateId]);
  if (!cert) {
    return res.status(404).json({ error: 'Certificate not found' });
  }

  // Block deploying the certificate that is currently used for server TLS
  if (isServiceCert(cert.id)) {
    return res.status(400).json({
      error: 'This certificate is currently used for the server\'s TLS and cannot be deployed to agents. Deploying it would allow agents to impersonate the server.',
    });
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
  const agentId = parseIntId(req.params.agentId);
  const depId = parseIntId(req.params.depId);
  if (!agentId || !depId) return res.status(400).json({ error: 'Invalid ID' });
  const db = getDb();
  const dep = db.get(
    'SELECT * FROM deployments WHERE id = ? AND agent_id = ?',
    [depId, agentId],
  );
  if (!dep) return res.status(404).json({ error: 'Deployment not found' });

  const { name, certificateId, enabled } = req.body || {};

  if (typeof name === 'string' && name.trim().length > 0) {
    db.run("UPDATE deployments SET name = ?, updated_at = datetime('now') WHERE id = ?", [name.trim(), dep.id]);
  }
  if (typeof certificateId === 'number') {
    const cert = db.get('SELECT id FROM certificates WHERE id = ?', [certificateId]);
    if (!cert) return res.status(404).json({ error: 'Certificate not found' });

    // Block deploying the certificate that is currently used for server TLS
    if (isServiceCert(cert.id)) {
      return res.status(400).json({
        error: 'This certificate is currently used for the server\'s TLS and cannot be deployed to agents. Deploying it would allow agents to impersonate the server.',
      });
    }

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
  const agentId = parseIntId(req.params.agentId);
  const depId = parseIntId(req.params.depId);
  if (!agentId || !depId) return res.status(400).json({ error: 'Invalid ID' });
  const db = getDb();
  const dep = db.get(
    'SELECT * FROM deployments WHERE id = ? AND agent_id = ?',
    [depId, agentId],
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
