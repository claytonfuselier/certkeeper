const express = require('express');
const { getDb } = require('../db');
const config = require('../config');
const logger = require('../logger');
const { requireAuth } = require('../middleware/auth');
const { validateCloudflareToken } = require('../services/cloudflare');
const { ensureCloudflareIni, deleteCloudflareIni } = require('../services/certbot');
const { getTlsSource, installCustomCert, removeCustomCert, readManagedCert, getServiceDomain, getServiceCertId, setServiceDomain, applyTlsToServer } = require('../services/tls');
const scheduler = require('../services/scheduler');
const { getEffectiveCloudflareToken, getEffectiveLetsencryptEmail } = require('../services/configHelpers');
const { encrypt } = require('../services/encryption');

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// GET /api/settings — retrieve current settings
// ---------------------------------------------------------------------------
router.get('/', (_req, res) => {
  const db = getDb();

  const effectiveToken = getEffectiveCloudflareToken();
  const tokenSource = config.cloudflare.apiToken ? 'env' : effectiveToken ? 'database' : 'none';

  const effectiveEmail = getEffectiveLetsencryptEmail();
  const emailSource = config.letsencrypt.email ? 'env' : effectiveEmail ? 'database' : 'none';

  const certCount = db.get('SELECT COUNT(*) AS n FROM certificates');
  const activeCerts = db.get("SELECT COUNT(*) AS n FROM certificates WHERE status = 'active'");
  const agentCount = db.get('SELECT COUNT(*) AS n FROM agents')?.n || 0;

  // Identify the certificate ID being used for server TLS (if managed)
  const serviceDomain = getServiceDomain();
  const serviceCertId = getServiceCertId();

  res.json({
    server: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: process.uptime(),
      port: config.port,
    },
    cloudflare: {
      hasToken: !!effectiveToken,
      source: tokenSource,
      maskedToken: maskToken(effectiveToken),
    },
    credentials: {
      source: config.admin.fromEnv ? 'env' : 'database',
    },
    email: {
      value: effectiveEmail,
      source: emailSource,
    },
    tls: {
      source: getTlsSource(),
      serviceDomain: serviceDomain,
      serviceCertId: serviceCertId,
    },
    agents: {
      count: agentCount,
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

    db.upsertSetting('cloudflare_api_token', encrypt(apiToken.trim()));
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

  db.upsertSetting('letsencrypt_email', trimmed);
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
  const { certPem, keyPem, managedDomain, action } = req.body || {};

  // Revert to self-signed
  if (action === 'reset') {
    // Block if agents exist — self-signed breaks mTLS trust
    const db = getDb();
    const agentCount = db.get('SELECT COUNT(*) AS n FROM agents')?.n || 0;
    if (agentCount > 0) {
      return res.status(409).json({
        error: `Cannot revert to self-signed while ${agentCount} agent${agentCount !== 1 ? 's' : ''} exist. Agents cannot verify the server identity with a self-signed certificate. Remove all agents first, or switch to a different managed/custom certificate instead.`,
      });
    }

    const result = removeCustomCert();
    if (!result.ok) return res.status(500).json({ error: result.error });

    setServiceDomain(null);
    applyTlsToServer();
    logger.info('TLS reverted to self-signed via settings');
    return res.json({
      ok: true,
      tls: { source: 'self-signed' },
    });
  }

  // Use a managed cert (issued by this app)
  if (managedDomain) {
    // Validate managedDomain against DB to prevent path traversal
    if (typeof managedDomain !== 'string' || managedDomain.length > 253) {
      return res.status(400).json({ error: 'Invalid managed domain' });
    }
    const db = getDb();
    const certRow = db.get("SELECT certbot_name FROM certificates WHERE certbot_name = ? AND status = 'active'", [managedDomain]);
    if (!certRow) {
      return res.status(404).json({ error: `No active managed certificate found for "${managedDomain}".` });
    }

    const managed = readManagedCert(certRow.certbot_name);
    if (!managed) {
      return res.status(404).json({ error: `Certificate files not found on disk for "${managedDomain}".` });
    }

    const result = installCustomCert(managed.cert, managed.key);
    if (!result.ok) return res.status(400).json({ error: result.error });

    setServiceDomain(managedDomain);
    applyTlsToServer();
    logger.info('TLS set to managed certificate via settings', { domain: managedDomain });
    return res.json({
      ok: true,
      tls: { source: 'custom' },
    });
  }

  // Upload custom PEM
  if (!certPem || !keyPem) {
    return res.status(400).json({ error: 'Provide certPem and keyPem, or managedDomain, or action:"reset".' });
  }

  const result = installCustomCert(certPem, keyPem);
  if (!result.ok) return res.status(400).json({ error: result.error });

  setServiceDomain(null); // custom upload — not a managed domain
  applyTlsToServer();
  logger.info('Custom TLS certificate uploaded via settings');
  return res.json({
    ok: true,
    tls: { source: 'custom' },
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
  const db = getDb();
  const certs = db.all("SELECT id, domains, status FROM certificates WHERE status = 'active' ORDER BY domains");
  res.json(certs.map((c) => ({
    id: c.id,
    domains: c.domains.split(' '),
  })));
});

// ---------------------------------------------------------------------------
// GET /api/settings/agents — get agent monitoring settings
// ---------------------------------------------------------------------------
router.get('/agents', (_req, res) => {
  const db = getDb();
  const intervalRow = db.get("SELECT value FROM settings WHERE key = 'agent_heartbeat_interval'");
  const thresholdRow = db.get("SELECT value FROM settings WHERE key = 'agent_offline_threshold'");
  const versionRow = db.get("SELECT value FROM settings WHERE key = 'agent_config_version'");

  res.json({
    heartbeat_interval: parseInt(intervalRow?.value, 10) || 180,
    offline_threshold: parseInt(thresholdRow?.value, 10) || 3,
    config_version: parseInt(versionRow?.value, 10) || 1,
  });
});

// ---------------------------------------------------------------------------
// PUT /api/settings/agents — update agent monitoring settings
// Increments config_version so agents pick up the change on next heartbeat.
// ---------------------------------------------------------------------------
router.put('/agents', (req, res) => {
  const { heartbeat_interval_minutes, offline_threshold } = req.body || {};

  if (typeof heartbeat_interval_minutes !== 'number' || !Number.isInteger(heartbeat_interval_minutes) || heartbeat_interval_minutes < 1) {
    return res.status(400).json({ error: 'heartbeat_interval_minutes must be an integer ≥ 1' });
  }
  if (typeof offline_threshold !== 'number' || !Number.isInteger(offline_threshold) || offline_threshold < 1) {
    return res.status(400).json({ error: 'offline_threshold must be an integer ≥ 1' });
  }

  const db = getDb();
  const intervalSeconds = heartbeat_interval_minutes * 60;

  db.upsertSetting('agent_heartbeat_interval', String(intervalSeconds));
  db.upsertSetting('agent_offline_threshold', String(offline_threshold));

  // Increment global config version — agents will pick this up on next heartbeat
  const versionRow = db.get("SELECT value FROM settings WHERE key = 'agent_config_version'");
  const currentVersion = parseInt(versionRow?.value, 10) || 1;
  const newVersion = currentVersion + 1;
  db.upsertSetting('agent_config_version', String(newVersion));

  logger.info('Agent monitoring settings updated', {
    heartbeat_interval: intervalSeconds,
    offline_threshold,
    config_version: newVersion,
  });

  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'agent_settings_updated',
    JSON.stringify({ heartbeat_interval: intervalSeconds, offline_threshold, config_version: newVersion }),
  ]);

  res.json({
    ok: true,
    heartbeat_interval: intervalSeconds,
    offline_threshold,
    config_version: newVersion,
  });
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
