const express = require('express');
const config = require('../config');
const { getDb } = require('../db');
const logger = require('../logger');
const certbot = require('../services/certbot');
const { refreshServiceCert } = require('../services/tls');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// GET /api/certs — list all tracked certificates
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const db = getDb();
  const certs = db.all('SELECT * FROM certificates ORDER BY created_at DESC');
  const result = certs.map((c) => ({ ...c, domains: c.domains.split(' ') }));
  res.json(result);
});

// ---------------------------------------------------------------------------
// GET /api/certs/:id — single certificate details
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const db = getDb();
  const cert = db.get('SELECT * FROM certificates WHERE id = ?', [req.params.id]);
  if (!cert) return res.status(404).json({ error: 'Not found' });
  cert.domains = cert.domains.split(' ');
  res.json(cert);
});

// ---------------------------------------------------------------------------
// POST /api/certs — request a new certificate (async — returns 202)
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { domains } = req.body || {};
    const db = getDb();

    if (!domains || !Array.isArray(domains) || domains.length === 0) {
      return res.status(400).json({ error: 'domains must be a non-empty array' });
    }

    // Check for existing certificate with the same domains
    const domainStr = domains.join(' ');
    const existing = db.get(
      "SELECT id, status FROM certificates WHERE domains = ? AND status NOT IN ('error', 'revoked')",
      [domainStr],
    );
    if (existing) {
      return res.status(409).json({
        error: `A certificate for these domains already exists (id: ${existing.id}, status: ${existing.status}). Use renew instead.`,
      });
    }

    // Allow overriding a revoked entry — remove it first so the new one takes its place
    const revoked = db.get(
      "SELECT id FROM certificates WHERE domains = ? AND status = 'revoked'",
      [domainStr],
    );
    if (revoked) {
      if (req.body.overrideRevoked) {
        db.run('DELETE FROM certificates WHERE id = ?', [revoked.id]);
        logger.info('Removed revoked certificate entry for override', { id: revoked.id, domains });
      } else {
        return res.status(409).json({
          error: 'A revoked certificate exists for these domains.',
          revoked: true,
          revokedId: revoked.id,
        });
      }
    }

    const certbotName = domains[0]; // certbot uses the first domain as the cert name
    const isStaging = config.letsencrypt.staging ? 1 : 0;
    const { lastInsertRowid } = db.run(
      "INSERT INTO certificates (domains, status, certbot_name, staging) VALUES (?, 'issuing', ?, ?)",
      [domainStr, certbotName, isStaging],
    );

    db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
      'cert_request', JSON.stringify({ id: lastInsertRowid, domains }),
    ]);

    // Return immediately — certbot runs in the background
    const cert = db.get('SELECT * FROM certificates WHERE id = ?', [lastInsertRowid]);
    cert.domains = cert.domains.split(' ');
    res.status(202).json(cert);

    // Fire-and-forget: run certbot in the background
    certbot.issueCertificate({ domains }).then(async (result) => {
      if (result.success) {
        await certbot.syncCertificates();
        // Safety net: ensure this specific row is updated even if sync matched differently
        const row = db.get('SELECT status FROM certificates WHERE id = ?', [lastInsertRowid]);
        if (row && row.status === 'issuing') {
          db.run(
            "UPDATE certificates SET status = 'active', issued_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
            [lastInsertRowid],
          );
        }
        logger.info('Background cert issue succeeded', { id: lastInsertRowid, domains });
      } else {
        const errPayload = JSON.stringify(result.error || { title: 'Unknown error', detail: result.message, link: '' });
        db.run(
          "UPDATE certificates SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?",
          [errPayload, lastInsertRowid],
        );
        logger.error('Background cert issue failed', { id: lastInsertRowid, message: result.message });
      }
    }).catch((err) => {
      const errPayload = JSON.stringify({ title: 'Unexpected error', detail: err.message, link: 'https://community.letsencrypt.org/' });
      db.run(
        "UPDATE certificates SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?",
        [errPayload, lastInsertRowid],
      );
      logger.error('Background cert issue error', { id: lastInsertRowid, err });
    });
  } catch (err) {
    logger.error('Certificate issue error', { err });
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/certs/:id/renew — force-renew a certificate (async — returns 202)
// ---------------------------------------------------------------------------
router.post('/:id/renew', async (req, res) => {
  try {
    const db = getDb();
    const cert = db.get('SELECT * FROM certificates WHERE id = ?', [req.params.id]);
    if (!cert) return res.status(404).json({ error: 'Not found' });
    if (!cert.certbot_name) return res.status(400).json({ error: 'Certificate has no certbot name — cannot renew' });
    if (cert.status === 'issuing' || cert.status === 'renewing') {
      return res.status(409).json({ error: 'Certificate is already being processed' });
    }

    // Mark as renewing immediately
    db.run(
      "UPDATE certificates SET status = 'renewing', error_message = NULL, updated_at = datetime('now') WHERE id = ?",
      [cert.id],
    );

    db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
      'cert_renew', JSON.stringify({ id: cert.id, certbotName: cert.certbot_name }),
    ]);

    // Return immediately
    const updated = db.get('SELECT * FROM certificates WHERE id = ?', [cert.id]);
    updated.domains = updated.domains.split(' ');
    res.status(202).json(updated);

    // Fire-and-forget: run certbot in the background
    certbot.renewCertificate(cert.certbot_name).then(async (result) => {
      if (result.success) {
        await certbot.syncCertificates();
        refreshServiceCert();
        logger.info('Background cert renew succeeded', { id: cert.id, certbotName: cert.certbot_name });
      } else {
        const errPayload = JSON.stringify(result.error || { title: 'Unknown error', detail: result.message, link: '' });
        db.run(
          "UPDATE certificates SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?",
          [errPayload, cert.id],
        );
        logger.error('Background cert renew failed', { id: cert.id, message: result.message });
      }
    }).catch((err) => {
      const errPayload = JSON.stringify({ title: 'Unexpected error', detail: err.message, link: 'https://community.letsencrypt.org/' });
      db.run(
        "UPDATE certificates SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?",
        [errPayload, cert.id],
      );
      logger.error('Background cert renew error', { id: cert.id, err });
    });
  } catch (err) {
    logger.error('Certificate renew error', { err });
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/certs/:id — revoke, remove tracking, or both
//   ?action=remove  → remove from DB only (no certbot revoke)
//   ?action=revoke  → revoke via certbot, keep row with 'revoked' status
//   default (no action) → revoke via certbot, then remove from DB
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    const cert = db.get('SELECT * FROM certificates WHERE id = ?', [req.params.id]);
    if (!cert) return res.status(404).json({ error: 'Not found' });

    const action = req.query.action; // 'remove' | 'revoke' | undefined

    // Revoke via certbot (for 'revoke' action or default)
    if (action !== 'remove' && cert.certbot_name) {
      const result = await certbot.revokeCertificate(cert.certbot_name);
      if (!result.success) {
        return res.status(500).json({ error: result.message });
      }
    }

    // Delete cert files from disk (for 'remove' action — cert was not revoked above)
    if (action === 'remove' && cert.certbot_name) {
      const result = await certbot.deleteCertificate(cert.certbot_name);
      if (!result.success) {
        logger.warn('Failed to delete cert from disk during remove', { id: cert.id, message: result.message });
      }
    }

    if (action === 'revoke') {
      // Keep the row but mark as revoked
      db.run(
        "UPDATE certificates SET status = 'revoked', error_message = NULL, updated_at = datetime('now') WHERE id = ?",
        [cert.id],
      );
    } else {
      // Remove from DB ('remove' action or default)
      db.run('DELETE FROM certificates WHERE id = ?', [cert.id]);
    }

    db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
      action === 'remove' ? 'cert_remove' : 'cert_revoke',
      JSON.stringify({ id: cert.id, domains: cert.domains }),
    ]);

    return res.json({ ok: true });
  } catch (err) {
    logger.error('Certificate delete error', { err });
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/certs/:id — update settings (e.g. auto_renew)
// ---------------------------------------------------------------------------
router.patch('/:id', (req, res) => {
  const db = getDb();
  const cert = db.get('SELECT * FROM certificates WHERE id = ?', [req.params.id]);
  if (!cert) return res.status(404).json({ error: 'Not found' });

  const { auto_renew } = req.body || {};
  if (typeof auto_renew !== 'undefined') {
    db.run("UPDATE certificates SET auto_renew = ?, updated_at = datetime('now') WHERE id = ?",
      [auto_renew ? 1 : 0, cert.id]);
  }

  const updated = db.get('SELECT * FROM certificates WHERE id = ?', [cert.id]);
  updated.domains = updated.domains.split(' ');
  res.json(updated);
});

// ---------------------------------------------------------------------------
// POST /api/certs/sync — manual sync with certbot on disk
// ---------------------------------------------------------------------------
router.post('/sync', async (_req, res) => {
  try {
    await certbot.syncCertificates();
    const db = getDb();
    const certs = db.all('SELECT * FROM certificates ORDER BY created_at DESC');
    const result = certs.map((c) => ({ ...c, domains: c.domains.split(' ') }));
    res.json(result);
  } catch (err) {
    logger.error('Sync error', { err });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
