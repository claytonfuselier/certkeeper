const express = require('express');
const { getDb } = require('../db');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { getEffectiveCloudflareToken, getEffectiveLetsencryptEmail } = require('../services/configHelpers');

const router = express.Router();
router.use(requireAuth);

// GET /api/dashboard — summary data for the dashboard
router.get('/', (_req, res) => {
  try {
    const db = getDb();
    const total = db.get('SELECT COUNT(*) as count FROM certificates').count;
    const active = db.get("SELECT COUNT(*) as count FROM certificates WHERE status = 'active'").count;
    const expiring = db.get(`
      SELECT COUNT(*) as count FROM certificates
      WHERE status = 'active'
        AND expires_at IS NOT NULL
        AND datetime(expires_at) < datetime('now', '+30 days')
    `).count;
    const errors = db.get("SELECT COUNT(*) as count FROM certificates WHERE status = 'error'").count;
    const recentAudit = db.all('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 20');

    // Determine cloudflare token source
    const cfToken = getEffectiveCloudflareToken();
    const cfSource = config.cloudflare.apiToken ? 'env' : cfToken ? 'database' : 'none';

    res.json({
      total,
      active,
      expiring,
      errors,
      staging: config.letsencrypt.staging,
      email: getEffectiveLetsencryptEmail(),
      hasCloudflareToken: !!cfToken,
      cloudflareSource: cfSource,
      recentAudit,
    });
  } catch (err) {
    const logger = require('../logger');
    logger.error('Dashboard error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
