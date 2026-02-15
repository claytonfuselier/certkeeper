const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const selfsigned = require('selfsigned');
const logger = require('../logger');
const config = require('../config');
const { getDb } = require('../db');

// ---------------------------------------------------------------------------
// TLS certificate management for the admin UI
// ---------------------------------------------------------------------------

const TLS_DIR = path.join(config.paths.data, 'tls');
const SELF_SIGNED_CERT = path.join(TLS_DIR, 'self-signed.crt');
const SELF_SIGNED_KEY = path.join(TLS_DIR, 'self-signed.key');
const CUSTOM_CERT = path.join(TLS_DIR, 'server.crt');
const CUSTOM_KEY = path.join(TLS_DIR, 'server.key');

/**
 * Get the TLS credentials (cert + key) for the HTTPS server.
 *
 * Priority:
 *   1. Custom cert/key (uploaded or linked via settings)
 *   2. Self-signed cert (auto-generated on first run)
 */
async function getTlsCredentials() {
  fs.mkdirSync(TLS_DIR, { recursive: true });

  // 1. Custom / managed cert takes priority
  if (fs.existsSync(CUSTOM_CERT) && fs.existsSync(CUSTOM_KEY)) {
    logger.info('Using custom TLS certificate', { cert: CUSTOM_CERT });
    return {
      cert: fs.readFileSync(CUSTOM_CERT, 'utf-8'),
      key: fs.readFileSync(CUSTOM_KEY, 'utf-8'),
      source: 'custom',
    };
  }

  // 2. Self-signed cert — generate if missing or expired
  if (!fs.existsSync(SELF_SIGNED_CERT) || !fs.existsSync(SELF_SIGNED_KEY) || isSelfSignedExpired()) {
    await generateSelfSigned();
  }

  logger.info('Using self-signed TLS certificate', { cert: SELF_SIGNED_CERT });
  return {
    cert: fs.readFileSync(SELF_SIGNED_CERT, 'utf-8'),
    key: fs.readFileSync(SELF_SIGNED_KEY, 'utf-8'),
    source: 'self-signed',
  };
}

const SELF_SIGNED_DAYS = 14;

/**
 * Check whether the self-signed cert on disk has expired (or expires within 1 day).
 */
function isSelfSignedExpired() {
  try {
    const pem = fs.readFileSync(SELF_SIGNED_CERT, 'utf-8');
    const x509 = new crypto.X509Certificate(pem);
    const expiry = new Date(x509.validTo);
    const oneDayFromNow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    if (expiry <= oneDayFromNow) {
      logger.info('Self-signed TLS certificate expired or expiring soon', { validTo: x509.validTo });
      return true;
    }
    return false;
  } catch {
    // If we can't parse it, regenerate
    return true;
  }
}

/**
 * Generate a self-signed certificate and persist it to disk.
 */
async function generateSelfSigned() {
  logger.info('Generating self-signed TLS certificate…');

  const attrs = [{ name: 'commonName', value: 'CertKeeper' }];
  const notAfter = new Date();
  notAfter.setDate(notAfter.getDate() + SELF_SIGNED_DAYS);

  const opts = {
    keySize: 2048,
    notAfterDate: notAfter,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' },
        ],
      },
    ],
  };

  const pems = await selfsigned.generate(attrs, opts);

  fs.writeFileSync(SELF_SIGNED_CERT, pems.cert, { mode: 0o644 });
  fs.writeFileSync(SELF_SIGNED_KEY, pems.private, { mode: 0o600 });

  logger.info('Self-signed TLS certificate created', { cert: SELF_SIGNED_CERT });
}

/**
 * Install a custom cert+key pair (from upload or managed cert selection).
 * Writes to the custom cert/key paths so they take priority on next load.
 * Returns { ok, error? }.
 */
function installCustomCert(certPem, keyPem) {
  try {
    // Basic PEM validation
    if (!certPem.includes('-----BEGIN CERTIFICATE-----')) {
      return { ok: false, error: 'Invalid certificate — must be PEM-encoded.' };
    }
    if (!keyPem.includes('-----BEGIN') || !keyPem.includes('PRIVATE KEY-----')) {
      return { ok: false, error: 'Invalid private key — must be PEM-encoded.' };
    }

    fs.mkdirSync(TLS_DIR, { recursive: true });
    fs.writeFileSync(CUSTOM_CERT, certPem, { mode: 0o644 });
    fs.writeFileSync(CUSTOM_KEY, keyPem, { mode: 0o600 });

    logger.info('Custom TLS certificate installed');
    return { ok: true };
  } catch (err) {
    logger.error('Failed to install custom TLS certificate', { error: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * Remove the custom cert so the server falls back to self-signed.
 */
function removeCustomCert() {
  try {
    if (fs.existsSync(CUSTOM_CERT)) fs.unlinkSync(CUSTOM_CERT);
    if (fs.existsSync(CUSTOM_KEY)) fs.unlinkSync(CUSTOM_KEY);
    logger.info('Custom TLS certificate removed — will use self-signed');
    return { ok: true };
  } catch (err) {
    logger.error('Failed to remove custom TLS certificate', { error: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * Get the current TLS source without reading file contents.
 */
function getTlsSource() {
  if (fs.existsSync(CUSTOM_CERT) && fs.existsSync(CUSTOM_KEY)) return 'custom';
  return 'self-signed';
}

/**
 * Read a managed cert's PEM files from the certbot config directory.
 * Returns { cert, key } or null if not found.
 */
function readManagedCert(domain) {
  const liveDir = path.join(config.paths.certbotConfig, 'live', domain);
  const certPath = path.join(liveDir, 'fullchain.pem');
  const keyPath = path.join(liveDir, 'privkey.pem');

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;

  return {
    cert: fs.readFileSync(certPath, 'utf-8'),
    key: fs.readFileSync(keyPath, 'utf-8'),
  };
}

// ---------------------------------------------------------------------------
// Managed-domain tracking (which managed cert powers the HTTPS server)
// ---------------------------------------------------------------------------

const TLS_DOMAIN_KEY = 'tls_managed_domain';

/**
 * Get the managed domain currently used as the service TLS cert (if any).
 */
function getServiceDomain() {
  const db = getDb();
  const row = db.get('SELECT value FROM settings WHERE key = ?', [TLS_DOMAIN_KEY]);
  return row ? row.value : null;
}

/**
 * Store which managed domain is used for the service TLS cert.
 * Pass null to clear it (e.g. when reverting to self-signed or uploading custom).
 */
function setServiceDomain(domain) {
  const db = getDb();
  if (domain) {
    const existing = db.get('SELECT key FROM settings WHERE key = ?', [TLS_DOMAIN_KEY]);
    if (existing) {
      db.run('UPDATE settings SET value = ?, updated_at = datetime(\'now\') WHERE key = ?', [domain, TLS_DOMAIN_KEY]);
    } else {
      db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [TLS_DOMAIN_KEY, domain]);
    }
  } else {
    db.run('DELETE FROM settings WHERE key = ?', [TLS_DOMAIN_KEY]);
  }
}

/**
 * After cert renewal, re-copy the managed cert to the service TLS paths
 * if the service is currently using a managed cert.
 *
 * Call this after `renewAll()` or `renewCertificate()` succeeds.
 * Returns true if the cert was refreshed, false otherwise.
 */
function refreshServiceCert() {
  const domain = getServiceDomain();
  if (!domain) return false;

  // Only refresh if we are actually using a custom (managed) cert
  if (getTlsSource() !== 'custom') return false;

  const managed = readManagedCert(domain);
  if (!managed) {
    logger.warn('Service TLS managed domain set but cert not found on disk', { domain });
    return false;
  }

  // Check whether the cert on disk is already up-to-date
  try {
    const current = fs.readFileSync(CUSTOM_CERT, 'utf-8');
    if (current === managed.cert) return false; // already current
  } catch {
    // server.crt missing — install it
  }

  const result = installCustomCert(managed.cert, managed.key);
  if (result.ok) {
    logger.info('Service TLS certificate refreshed after renewal', { domain });
    return true;
  }

  logger.error('Failed to refresh service TLS certificate after renewal', { domain, error: result.error });
  return false;
}

module.exports = {
  getTlsCredentials,
  installCustomCert,
  removeCustomCert,
  getTlsSource,
  readManagedCert,
  getServiceDomain,
  setServiceDomain,
  refreshServiceCert,
};
