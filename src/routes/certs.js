const express = require('express');
const config = require('../config');
const { getDb, parseIntId } = require('../db');
const logger = require('../logger');
const certbot = require('../services/certbot');
const { getEffectiveCloudflareToken } = require('../services/configHelpers');
const { refreshServiceCert, isServiceCert } = require('../services/tls');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Domain name validation — prevents argument injection and path traversal
const DOMAIN_RE = /^(\*\.)?([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
function validateDomains(domains) {
  if (!domains || !Array.isArray(domains) || domains.length === 0) {
    return 'domains must be a non-empty array';
  }
  if (domains.length > 100) {
    return 'Too many domains (max 100)';
  }
  for (const d of domains) {
    if (typeof d !== 'string' || d.length > 253) {
      return `Invalid domain: must be a string no longer than 253 characters`;
    }
    if (!DOMAIN_RE.test(d)) {
      return `Invalid domain format: "${d}". Use a valid FQDN (wildcards like *.example.com are allowed).`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /api/certs — list all tracked certificates
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const db = getDb();
  const certs = db.all('SELECT * FROM certificates ORDER BY created_at DESC');
  const result = certs.map((c) => ({ ...c, domains: c.domains.split(' ').filter(Boolean) }));
  res.json(result);
});

// ---------------------------------------------------------------------------
// GET /api/certs/:id — single certificate details
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid certificate ID' });
  const db = getDb();
  const cert = db.get('SELECT * FROM certificates WHERE id = ?', [id]);
  if (!cert) return res.status(404).json({ error: 'Not found' });
  cert.domains = cert.domains.split(' ').filter(Boolean);
  res.json(cert);
});

// ---------------------------------------------------------------------------
// POST /api/certs — request a new certificate (async — returns 202)
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { domains } = req.body || {};
    const db = getDb();

    const domainErr = validateDomains(domains);
    if (domainErr) {
      return res.status(400).json({ error: domainErr });
    }

    // Require a Cloudflare API token (env var or DB) before issuing
    const cfToken = getEffectiveCloudflareToken();
    if (!cfToken) {
      return res.status(400).json({ error: 'Cloudflare API token is not configured. Add one in Settings → Cloudflare API, or set the CLOUDFLARE_API_TOKEN environment variable.' });
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
    cert.domains = cert.domains.split(' ').filter(Boolean);
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
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/certs/:id/renew — force-renew a certificate (async — returns 202)
// ---------------------------------------------------------------------------
router.post('/:id/renew', async (req, res) => {
  try {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid certificate ID' });
    const db = getDb();
    const cert = db.get('SELECT * FROM certificates WHERE id = ?', [id]);
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
    updated.domains = updated.domains.split(' ').filter(Boolean);
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
    return res.status(500).json({ error: 'Internal server error' });
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
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid certificate ID' });
    const db = getDb();
    const cert = db.get('SELECT * FROM certificates WHERE id = ?', [id]);
    if (!cert) return res.status(404).json({ error: 'Not found' });

    // Block revoke/remove of the certificate currently used for server TLS
    if (isServiceCert(cert.id)) {
      return res.status(409).json({
        error: 'This certificate is currently used for the server\'s TLS. Switch to a different certificate in Settings → TLS before revoking or removing it.',
      });
    }

    const action = req.query.action; // 'remove' | 'revoke' | undefined

    // Statuses where no valid cert exists on disk — skip certbot revocation
    const skipRevoke = ['expired', 'revoked', 'error', 'pending', 'issuing'].includes(cert.status);

    if (action === 'remove') {
      // Remove: revoke first (async) if cert is active, then delete from DB + disk
      if (!skipRevoke && cert.certbot_name) {
        // Fire-and-forget: revoke handles disk cleanup via --delete-after-revoke
        certbot.revokeCertificate(cert.certbot_name).then((result) => {
          if (result.success) {
            logger.info('Certificate revoked during remove', { id: cert.id, domains: cert.domains });
          } else {
            logger.warn('Revocation failed during remove, attempting disk cleanup', { id: cert.id, message: result.message });
            certbot.deleteCertificate(cert.certbot_name).catch(() => {});
          }
        }).catch((err) => {
          logger.warn('Revocation error during remove, attempting disk cleanup', { id: cert.id, error: err.message });
          certbot.deleteCertificate(cert.certbot_name).catch(() => {});
        });
      } else if (cert.certbot_name) {
        // No revocation needed — just delete files from disk
        const delResult = await certbot.deleteCertificate(cert.certbot_name);
        if (!delResult.success) {
          logger.warn('Failed to delete cert from disk during remove', { id: cert.id, message: delResult.message });
        }
      }

      db.run('DELETE FROM certificates WHERE id = ?', [cert.id]);
      db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
        'cert_remove', JSON.stringify({ id: cert.id, domains: cert.domains }),
      ]);
      return res.json({ ok: true });
    }

    // Revoke via certbot (for 'revoke' action or default) — skip if not applicable
    if (!skipRevoke && cert.certbot_name) {
      const result = await certbot.revokeCertificate(cert.certbot_name);
      if (!result.success) {
        return res.status(500).json({ error: result.message });
      }
    } else if (cert.certbot_name && action !== 'revoke') {
      // Default delete of expired/error cert — just clean up disk
      const delResult = await certbot.deleteCertificate(cert.certbot_name);
      if (!delResult.success) {
        logger.warn('Failed to delete cert from disk during delete', { id: cert.id, message: delResult.message });
      }
    }

    if (action === 'revoke') {
      // Keep the row but mark as revoked
      db.run(
        "UPDATE certificates SET status = 'revoked', error_message = NULL, updated_at = datetime('now') WHERE id = ?",
        [cert.id],
      );
    } else {
      // Default delete — remove from DB
      db.run('DELETE FROM certificates WHERE id = ?', [cert.id]);
    }

    db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
      action === 'revoke' ? 'cert_revoke' : 'cert_remove',
      JSON.stringify({ id: cert.id, domains: cert.domains }),
    ]);

    return res.json({ ok: true });
  } catch (err) {
    logger.error('Certificate delete error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/certs/:id — update settings (e.g. auto_renew)
// ---------------------------------------------------------------------------
router.patch('/:id', (req, res) => {
  try {
    const id = parseIntId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid certificate ID' });
    const db = getDb();
    const cert = db.get('SELECT * FROM certificates WHERE id = ?', [id]);
    if (!cert) return res.status(404).json({ error: 'Not found' });

    const { auto_renew } = req.body || {};
    if (typeof auto_renew !== 'undefined') {
      db.run("UPDATE certificates SET auto_renew = ?, updated_at = datetime('now') WHERE id = ?",
        [auto_renew ? 1 : 0, cert.id]);
    }

    const updated = db.get('SELECT * FROM certificates WHERE id = ?', [cert.id]);
    updated.domains = updated.domains.split(' ').filter(Boolean);
    res.json(updated);
  } catch (err) {
    logger.error('Certificate update error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/certs/bulk — perform bulk actions on multiple certificates
// Body: { ids: [1,2,3], action: 'renew'|'revoke'|'remove'|'auto_renew_on'|'auto_renew_off' }
// ---------------------------------------------------------------------------
router.post('/bulk', async (req, res) => {
  try {
    const { ids, action } = req.body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No certificates selected.' });
    }

    const validActions = ['renew', 'revoke', 'remove', 'auto_renew_on', 'auto_renew_off'];
    if (!validActions.includes(action)) {
      return res.status(400).json({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` });
    }

    // Validate all IDs are positive integers
    const parsedIds = ids.map((id) => parseIntId(id)).filter(Boolean);
    if (parsedIds.length === 0) {
      return res.status(400).json({ error: 'No valid certificate IDs provided.' });
    }

    const db = getDb();
    const results = { succeeded: 0, failed: 0, errors: [] };

    for (const id of parsedIds) {
      const cert = db.get('SELECT * FROM certificates WHERE id = ?', [id]);
      if (!cert) {
        results.failed++;
        results.errors.push({ id, error: 'Not found' });
        continue;
      }

      try {
        if (action === 'auto_renew_on' || action === 'auto_renew_off') {
          const val = action === 'auto_renew_on' ? 1 : 0;
          db.run("UPDATE certificates SET auto_renew = ?, updated_at = datetime('now') WHERE id = ?", [val, id]);
          results.succeeded++;

        } else if (action === 'renew') {
          if (!cert.certbot_name) {
            results.failed++;
            results.errors.push({ id, error: 'No certbot name' });
            continue;
          }
          if (cert.status === 'issuing' || cert.status === 'renewing') {
            results.failed++;
            results.errors.push({ id, error: 'Already in progress' });
            continue;
          }
          if (cert.status !== 'active' && cert.status !== 'expired') {
            results.failed++;
            results.errors.push({ id, error: `Cannot renew cert with status "${cert.status}"` });
            continue;
          }
          db.run("UPDATE certificates SET status = 'renewing', error_message = NULL, updated_at = datetime('now') WHERE id = ?", [id]);
          db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
            'cert_renew', JSON.stringify({ id, certbotName: cert.certbot_name, bulk: true }),
          ]);
          // Fire-and-forget background renewal
          certbot.renewCertificate(cert.certbot_name).then(async (result) => {
            if (result.success) {
              await certbot.syncCertificates();
              refreshServiceCert();
            } else {
              const errPayload = JSON.stringify(result.error || { title: 'Unknown error', detail: result.message, link: '' });
              db.run("UPDATE certificates SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?", [errPayload, id]);
            }
          }).catch((err) => {
            const errPayload = JSON.stringify({ title: 'Unexpected error', detail: err.message, link: '' });
            db.run("UPDATE certificates SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?", [errPayload, id]);
          });
          results.succeeded++;

        } else if (action === 'revoke') {
          if (isServiceCert(id)) {
            results.failed++;
            results.errors.push({ id, error: 'Certificate is used for server TLS' });
            continue;
          }
          if (!cert.certbot_name || ['issuing', 'renewing', 'revoked'].includes(cert.status)) {
            results.failed++;
            results.errors.push({ id, error: `Cannot revoke cert with status "${cert.status}"` });
            continue;
          }
          const revokeResult = await certbot.revokeCertificate(cert.certbot_name);
          if (!revokeResult.success) {
            results.failed++;
            results.errors.push({ id, error: revokeResult.message });
            continue;
          }
          db.run("UPDATE certificates SET status = 'revoked', error_message = NULL, updated_at = datetime('now') WHERE id = ?", [id]);
          db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
            'cert_revoke', JSON.stringify({ id, domains: cert.domains, bulk: true }),
          ]);
          results.succeeded++;

        } else if (action === 'remove') {
          if (isServiceCert(id)) {
            results.failed++;
            results.errors.push({ id, error: 'Certificate is used for server TLS' });
            continue;
          }
          if (['issuing', 'renewing'].includes(cert.status)) {
            results.failed++;
            results.errors.push({ id, error: `Cannot remove cert with status "${cert.status}"` });
            continue;
          }
          const skipRevoke = ['expired', 'revoked', 'error', 'pending'].includes(cert.status);
          if (!skipRevoke && cert.certbot_name) {
            // Fire-and-forget: revoke handles disk cleanup via --delete-after-revoke
            certbot.revokeCertificate(cert.certbot_name).then((result) => {
              if (result.success) {
                logger.info('Certificate revoked during bulk remove', { id, domains: cert.domains });
              } else {
                logger.warn('Revocation failed during bulk remove, attempting disk cleanup', { id, message: result.message });
                certbot.deleteCertificate(cert.certbot_name).catch(() => {});
              }
            }).catch((err) => {
              logger.warn('Revocation error during bulk remove, attempting disk cleanup', { id, error: err.message });
              certbot.deleteCertificate(cert.certbot_name).catch(() => {});
            });
          } else if (cert.certbot_name) {
            const delResult = await certbot.deleteCertificate(cert.certbot_name);
            if (!delResult.success) {
              logger.warn('Failed to delete cert from disk during bulk remove', { id, message: delResult.message });
            }
          }
          db.run('DELETE FROM certificates WHERE id = ?', [id]);
          db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
            'cert_remove', JSON.stringify({ id, domains: cert.domains, bulk: true }),
          ]);
          results.succeeded++;
        }
      } catch (opErr) {
        results.failed++;
        results.errors.push({ id, error: opErr.message });
      }
    }

    logger.info('Bulk cert action completed', { action, total: parsedIds.length, succeeded: results.succeeded, failed: results.failed });

    res.json(results);
  } catch (err) {
    logger.error('Bulk cert action error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/certs/sync — manual sync with certbot on disk
// ---------------------------------------------------------------------------
router.post('/sync', async (_req, res) => {
  try {
    await certbot.syncCertificates();
    const db = getDb();
    const certs = db.all('SELECT * FROM certificates ORDER BY created_at DESC');
    const result = certs.map((c) => ({ ...c, domains: c.domains.split(' ').filter(Boolean) }));
    res.json(result);
  } catch (err) {
    logger.error('Sync error', { err });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
