const config = require('../config');
const { getDb } = require('../db');
const { decrypt } = require('./encryption');

// ---------------------------------------------------------------------------
// Shared config-resolution helpers
//
// These functions resolve the effective value for settings that can come from
// either environment variables (priority) or the database (fallback).
// DB values are decrypted transparently when needed.
// ---------------------------------------------------------------------------

/**
 * Resolve the effective Cloudflare API token.
 * Priority: env var (plaintext) > DB value (encrypted).
 */
function getEffectiveCloudflareToken() {
  // Env var takes priority (never encrypted)
  if (config.cloudflare.apiToken) return config.cloudflare.apiToken;

  try {
    const db = getDb();
    const row = db.get("SELECT value FROM settings WHERE key = 'cloudflare_api_token'");
    if (!row || !row.value) return '';
    return decrypt(row.value);
  } catch {
    return '';
  }
}

/**
 * Resolve the effective Let's Encrypt registration email.
 * Priority: env var > DB value.
 */
function getEffectiveLetsencryptEmail() {
  if (config.letsencrypt.email) return config.letsencrypt.email;

  try {
    const db = getDb();
    const row = db.get("SELECT value FROM settings WHERE key = 'letsencrypt_email'");
    return row ? row.value : '';
  } catch {
    return '';
  }
}

module.exports = { getEffectiveCloudflareToken, getEffectiveLetsencryptEmail };
