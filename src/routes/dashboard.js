const express = require('express');
const { getDb } = require('../db');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/dashboard — summary data for the dashboard
router.get('/', (_req, res) => {
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
  const envToken = config.cloudflare.apiToken;
  const dbRow = db.get("SELECT value FROM settings WHERE key = 'cloudflare_api_token'");
  const dbToken = dbRow ? dbRow.value : '';
  const cfToken = envToken || dbToken;

  res.json({
    total,
    active,
    expiring,
    errors,
    staging: config.letsencrypt.staging,
    email: config.letsencrypt.email || (db.get("SELECT value FROM settings WHERE key = 'letsencrypt_email'") || {}).value || '',
    hasCloudflareToken: !!cfToken,
    cloudflareSource: envToken ? 'env' : dbToken ? 'database' : 'none',
    recentAudit,
  });
});

module.exports = router;
