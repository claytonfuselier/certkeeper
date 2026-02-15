const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');
const logger = require('../logger');
const { requireAuth } = require('../middleware/auth');
const { hashToken } = require('../middleware/agentAuth');

const router = express.Router();
router.use(requireAuth);

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
  return {
    ...agent,
    enabled: !!agent.enabled,
    deployments: loadDeployments(db, agent.id),
  };
}

// ============================= AGENTS ======================================

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
// POST /api/agents — create a new agent + generate token
// Returns the raw token ONCE — it cannot be retrieved again.
// ---------------------------------------------------------------------------
router.post('/', (req, res) => {
  const { name } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length < 1) {
    return res.status(400).json({ error: 'Agent name is required' });
  }

  const db = getDb();

  // Generate a cryptographically secure token: ck_<64 hex chars>
  const rawSecret = crypto.randomBytes(32).toString('hex');
  const rawToken = `ck_${rawSecret}`;
  const tokenHash = hashToken(rawToken);
  const tokenPrefix = rawSecret.slice(0, 8);

  const { lastInsertRowid } = db.run(
    'INSERT INTO agents (name, token_hash, token_prefix) VALUES (?, ?, ?)',
    [name.trim(), tokenHash, tokenPrefix],
  );

  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'agent_created', JSON.stringify({ id: lastInsertRowid, name: name.trim() }),
  ]);

  logger.info('Agent created', { id: lastInsertRowid, name: name.trim() });

  const agent = db.get('SELECT * FROM agents WHERE id = ?', [lastInsertRowid]);

  res.status(201).json({
    agent: agentResponse(db, agent),
    token: rawToken, // shown ONCE
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
// POST /api/agents/:id/regenerate-token — generate a new token, invalidating the old one
// ---------------------------------------------------------------------------
router.post('/:id/regenerate-token', (req, res) => {
  const db = getDb();
  const agent = db.get('SELECT * FROM agents WHERE id = ?', [req.params.id]);
  if (!agent) return res.status(404).json({ error: 'Not found' });

  const rawSecret = crypto.randomBytes(32).toString('hex');
  const rawToken = `ck_${rawSecret}`;
  const tokenHash = hashToken(rawToken);
  const tokenPrefix = rawSecret.slice(0, 8);

  db.run(
    "UPDATE agents SET token_hash = ?, token_prefix = ?, updated_at = datetime('now') WHERE id = ?",
    [tokenHash, tokenPrefix, agent.id],
  );

  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'agent_token_regenerated', JSON.stringify({ id: agent.id, name: agent.name }),
  ]);

  logger.info('Agent token regenerated', { id: agent.id, name: agent.name });

  res.json({ token: rawToken, tokenPrefix });
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
