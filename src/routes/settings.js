const express = require('express');
const { getDb } = require('../db');
const config = require('../config');
const logger = require('../logger');
const { requireAuth } = require('../middleware/auth');
const { validateCloudflareToken } = require('../services/cloudflare');
const { ensureCloudflareIni, deleteCloudflareIni } = require('../services/certbot');
const { getTlsSource, installCustomCert, removeCustomCert, readManagedCert, setServiceDomain } = require('../services/tls');
const scheduler = require('../services/scheduler');

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// GET /api/settings — retrieve current settings
// ---------------------------------------------------------------------------
router.get('/', (_req, res) => {
  const db = getDb();
  const cfRow = db.get("SELECT value FROM settings WHERE key = 'cloudflare_api_token'");
  const dbToken = cfRow ? cfRow.value : '';
  const envToken = config.cloudflare.apiToken;

  const emailRow = db.get("SELECT value FROM settings WHERE key = 'letsencrypt_email'");
  const dbEmail = emailRow ? emailRow.value : '';
  const envEmail = config.letsencrypt.email;
  const effectiveEmail = envEmail || dbEmail;

  const certCount = db.get('SELECT COUNT(*) AS n FROM certificates');
  const activeCerts = db.get("SELECT COUNT(*) AS n FROM certificates WHERE status = 'active'");

  res.json({
    server: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: process.uptime(),
      port: config.port,
    },
    cloudflare: {
      hasToken: !!(envToken || dbToken),
      source: envToken ? 'env' : dbToken ? 'database' : 'none',
      maskedToken: maskToken(envToken || dbToken),
    },
    credentials: {
      source: config.admin.fromEnv ? 'env' : 'database',
    },
    email: {
      value: effectiveEmail,
      source: envEmail ? 'env' : dbEmail ? 'database' : 'none',
    },
    tls: {
      source: config.useHttp ? 'disabled' : getTlsSource(),
      httpMode: config.useHttp,
    },
    schedule: scheduler.getScheduleInfo(),
    staging: config.letsencrypt.staging,
    certs: {
      total: certCount?.n || 0,
      active: activeCerts?.n || 0,
    },
  });
});

// ---------------------------------------------------------------------------
// PUT /api/settings/cloudflare — save Cloudflare API token to DB
// ---------------------------------------------------------------------------
router.put('/cloudflare', async (req, res) => {
  const { apiToken } = req.body || {};

  // Reject if the token is managed via environment variable
  if (config.cloudflare.apiToken) {
    return res.status(400).json({ error: 'Cloudflare API token is set via environment variable. Remove it from .env to manage via UI.' });
  }

  if (typeof apiToken !== 'string') {
    return res.status(400).json({ error: 'apiToken must be a string' });
  }

  const db = getDb();

  if (apiToken.trim() === '') {
    // Clear the token
    db.run("DELETE FROM settings WHERE key = 'cloudflare_api_token'");
    deleteCloudflareIni();
    logger.info('Cloudflare API token removed from database');
    db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", ['cf_token_removed', 'Token cleared']);
  } else {
    // Validate with Cloudflare API before saving
    const validation = await validateCloudflareToken(apiToken.trim());
    if (!validation.valid) {
      return res.status(400).json({ error: `Invalid Cloudflare API token: ${validation.error}` });
    }

    const existing = db.get("SELECT key FROM settings WHERE key = 'cloudflare_api_token'");
    if (existing) {
      db.run("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'cloudflare_api_token'", [apiToken.trim()]);
    } else {
      db.run("INSERT INTO settings (key, value) VALUES ('cloudflare_api_token', ?)", [apiToken.trim()]);
    }
    logger.info('Cloudflare API token saved to database (validated)');
    ensureCloudflareIni();
    db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", ['cf_token_updated', 'Token updated via UI (validated)']);
  }

  const envToken = config.cloudflare.apiToken;
  const dbToken = apiToken.trim();

  res.json({
    ok: true,
    cloudflare: {
      hasToken: !!(envToken || dbToken),
      source: envToken ? 'env' : dbToken ? 'database' : 'none',
      maskedToken: maskToken(envToken || dbToken),
    },
  });
});

// ---------------------------------------------------------------------------
// PUT /api/settings/email — save registration email to DB
// ---------------------------------------------------------------------------
router.put('/email', (req, res) => {
  const { email } = req.body || {};

  if (config.letsencrypt.emailFromEnv) {
    return res.status(400).json({ error: 'Registration email is set via environment variable. Remove it from .env to manage via UI.' });
  }

  if (typeof email !== 'string') {
    return res.status(400).json({ error: 'email must be a string' });
  }

  const trimmed = email.trim();
  const db = getDb();

  if (trimmed === '') {
    return res.status(400).json({ error: 'Registration email is required.' });
  }

  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const existing = db.get("SELECT key FROM settings WHERE key = 'letsencrypt_email'");
  if (existing) {
    db.run("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'letsencrypt_email'", [trimmed]);
  } else {
    db.run("INSERT INTO settings (key, value) VALUES ('letsencrypt_email', ?)", [trimmed]);
  }
  logger.info('Registration email saved to database', { email: trimmed });
  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", ['email_updated', `Email set to ${trimmed}`]);

  const envEmail = config.letsencrypt.email;
  res.json({
    ok: true,
    email: {
      value: envEmail || trimmed,
      source: envEmail ? 'env' : 'database',
    },
  });
});

// ---------------------------------------------------------------------------
// PUT /api/settings/tls — upload a custom cert + key, or use a managed cert
// ---------------------------------------------------------------------------
router.put('/tls', (req, res) => {
  if (config.useHttp) {
    return res.status(400).json({ error: 'TLS settings are disabled when USE_HTTP=true. The server is running in plain HTTP mode.' });
  }

  const { certPem, keyPem, managedDomain, action } = req.body || {};

  // Revert to self-signed
  if (action === 'reset') {
    const result = removeCustomCert();
    if (!result.ok) return res.status(500).json({ error: result.error });

    setServiceDomain(null);
    logger.info('TLS reverted to self-signed via settings');
    return res.json({
      ok: true,
      tls: { source: 'self-signed' },
      restart: true,
    });
  }

  // Use a managed cert (issued by this app)
  if (managedDomain) {
    const managed = readManagedCert(managedDomain);
    if (!managed) {
      return res.status(404).json({ error: `No managed certificate found for "${managedDomain}". Make sure the cert was issued and is active.` });
    }

    const result = installCustomCert(managed.cert, managed.key);
    if (!result.ok) return res.status(400).json({ error: result.error });

    setServiceDomain(managedDomain);
    logger.info('TLS set to managed certificate via settings', { domain: managedDomain });
    return res.json({
      ok: true,
      tls: { source: 'custom' },
      restart: true,
    });
  }

  // Upload custom PEM
  if (!certPem || !keyPem) {
    return res.status(400).json({ error: 'Provide certPem and keyPem, or managedDomain, or action:"reset".' });
  }

  const result = installCustomCert(certPem, keyPem);
  if (!result.ok) return res.status(400).json({ error: result.error });

  setServiceDomain(null); // custom upload — not a managed domain
  logger.info('Custom TLS certificate uploaded via settings');
  return res.json({
    ok: true,
    tls: { source: 'custom' },
    restart: true,
  });
});

// ---------------------------------------------------------------------------
// GET /api/settings/schedule — get current renewal schedule
// ---------------------------------------------------------------------------
router.get('/schedule', (_req, res) => {
  res.json(scheduler.getScheduleInfo());
});

// ---------------------------------------------------------------------------
// PUT /api/settings/schedule — update renewal schedule
// ---------------------------------------------------------------------------
router.put('/schedule', (req, res) => {
  if (config.renewalCronFromEnv) {
    return res.status(400).json({ error: 'Renewal schedule is set via RENEWAL_CRON environment variable. Remove it from .env to manage via UI.' });
  }

  const { day1, hour1, min1, day2, hour2, min2 } = req.body || {};

  // Validate all fields are integers in range
  const fields = { day1, hour1, min1, day2, hour2, min2 };
  for (const [name, val] of Object.entries(fields)) {
    if (typeof val !== 'number' || !Number.isInteger(val)) {
      return res.status(400).json({ error: `${name} must be an integer` });
    }
  }
  if (day1 < 0 || day1 > 6 || day2 < 0 || day2 > 6) {
    return res.status(400).json({ error: 'day1 and day2 must be 0-6 (Sunday-Saturday)' });
  }
  if (hour1 < 0 || hour1 > 23 || hour2 < 0 || hour2 > 23) {
    return res.status(400).json({ error: 'hour1 and hour2 must be 0-23' });
  }
  if (min1 < 0 || min1 > 59 || min2 < 0 || min2 > 59) {
    return res.status(400).json({ error: 'min1 and min2 must be 0-59' });
  }
  if (day1 === day2) {
    return res.status(400).json({ error: 'The two days must be different' });
  }

  const sched = { day1, hour1, min1, day2, hour2, min2 };
  scheduler.updateSchedule(sched);

  const db = getDb();
  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)",
    ['schedule_updated', JSON.stringify(sched)]);

  res.json({ ok: true, schedule: scheduler.getScheduleInfo() });
});

// ---------------------------------------------------------------------------
// GET /api/settings/tls/managed — list active managed certs available for use
// ---------------------------------------------------------------------------
router.get('/tls/managed', (_req, res) => {
  if (config.useHttp) {
    return res.status(400).json({ error: 'TLS settings are disabled when USE_HTTP=true.' });
  }

  const db = getDb();
  const certs = db.all("SELECT id, domains, status FROM certificates WHERE status = 'active' ORDER BY domains");
  res.json(certs.map((c) => ({
    id: c.id,
    domains: JSON.parse(c.domains),
  })));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function maskToken(token) {
  if (!token) return '';
  if (token.length <= 8) return '••••••••';
  return token.slice(0, 4) + '••••••••' + token.slice(-4);
}

module.exports = router;
