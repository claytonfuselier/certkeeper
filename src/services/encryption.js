const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const config = require('../config');
const logger = require('../logger');

// ---------------------------------------------------------------------------
// AES-256-GCM encryption for secrets stored in the settings table.
//
// Key is persisted in data/.encryption-key (separate from the SQLite DB).
// Encrypted values use the format:
//   ek1:<key_fingerprint>:<iv_hex>:<authTag_hex>:<ciphertext_hex>
//
// Key rotation: every 30 days (configurable), a new key is generated and all
// encrypted values are re-encrypted. Old backups become useless.
// ---------------------------------------------------------------------------

const KEY_FILE = path.join(config.paths.data, '.encryption-key');
const ROTATION_INTERVAL_DAYS = 30;

// Settings keys that contain secrets and should be encrypted
const SECRET_KEYS = [
  'cloudflare_api_token',
  'notif_email',
  'notif_webhook',
  'notif_pushover',
  'notif_gotify',
  'notif_slack',
  'notif_discord',
  'notif_telegram',
];

// In-memory key cache (avoids reading file on every encrypt/decrypt)
let _cachedKey = null;

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

/** Compute a short fingerprint of the key (for tagging encrypted values). */
function keyFingerprint(keyHex) {
  return crypto.createHash('sha256').update(Buffer.from(keyHex, 'hex')).digest('hex').slice(0, 8);
}

/** Load the encryption key from disk, or generate one if missing. */
function loadOrGenerateKey() {
  if (_cachedKey) return _cachedKey;

  if (fs.existsSync(KEY_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(KEY_FILE, 'utf-8'));
      if (data.key && data.created_at) {
        _cachedKey = data;
        return data;
      }
    } catch {
      // Corrupted file — regenerate
    }
  }

  return generateNewKey();
}

/**
 * Generate a new 256-bit encryption key and persist it to disk.
 * If previousKeyHex is provided, it is stored as previous_key so that
 * decrypt() can fall back to it during key rotation (crash safety).
 */
function generateNewKey(previousKeyHex) {
  const key = crypto.randomBytes(32).toString('hex');
  const data = {
    key,
    created_at: new Date().toISOString(),
  };
  if (previousKeyHex) {
    data.previous_key = previousKeyHex;
  }
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  _cachedKey = data;
  logger.info('Encryption key generated', { fingerprint: keyFingerprint(key) });
  return data;
}

/**
 * Ensure an encryption key exists. Call during startup (after DB init).
 * Idempotent — returns existing key or generates a new one.
 */
function ensureEncryptionKey() {
  const keyData = loadOrGenerateKey();
  logger.info('Encryption key loaded', { fingerprint: keyFingerprint(keyData.key) });
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns the encrypted string in the format: ek1:<fp>:<iv>:<tag>:<ciphertext>
 * Null/empty values are returned as-is (nothing to protect).
 */
function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;

  const keyData = loadOrGenerateKey();
  const key = Buffer.from(keyData.key, 'hex');
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const fp = keyFingerprint(keyData.key);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `ek1:${fp}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a stored value. If the value is not encrypted (no ek1: prefix),
 * it is returned as-is (plaintext passthrough for backward compatibility).
 *
 * Tries the current key first. If the fingerprint doesn't match and a
 * previous_key exists in the key file (set during rotation), falls back
 * to that. This makes rotation crash-safe — a partial rotation leaves
 * a mix of old-key and new-key values, all of which remain readable.
 *
 * Throws if neither key can decrypt the value.
 */
function decrypt(stored) {
  if (!stored || typeof stored !== 'string') return stored;
  if (!stored.startsWith('ek1:')) return stored; // plaintext passthrough

  const parts = stored.split(':');
  if (parts.length !== 5) return stored; // malformed — return as-is

  const [, fp, ivHex, authTagHex, cipherHex] = parts;
  const keyData = loadOrGenerateKey();

  // Try current key
  if (fp === keyFingerprint(keyData.key)) {
    return _decryptWithKey(keyData.key, ivHex, authTagHex, cipherHex);
  }

  // Fall back to previous key (present during/after rotation)
  if (keyData.previous_key && fp === keyFingerprint(keyData.previous_key)) {
    return _decryptWithKey(keyData.previous_key, ivHex, authTagHex, cipherHex);
  }

  throw new Error('Cannot decrypt: encryption key mismatch (key may have been rotated without re-encrypting)');
}

/** Internal: decrypt with a specific key hex string. */
function _decryptWithKey(keyHex, ivHex, authTagHex, cipherHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(cipherHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf-8');
}

/** Check whether a value is in encrypted format. */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith('ek1:');
}

// ---------------------------------------------------------------------------
// Migration — encrypt existing plaintext secrets in the DB
// ---------------------------------------------------------------------------

/**
 * Scan all secret settings and encrypt any that are still plaintext.
 * Call during startup after the encryption key is initialized.
 * Requires getDb() — must be called after initDatabase().
 */
function migrateSecretsToEncrypted() {
  const { getDb } = require('../db');
  const db = getDb();
  let migrated = 0;

  for (const key of SECRET_KEYS) {
    const row = db.get('SELECT value FROM settings WHERE key = ?', [key]);
    if (row && row.value && !isEncrypted(row.value)) {
      const encrypted = encrypt(row.value);
      db.run("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?", [encrypted, key]);
      migrated++;
    }
  }

  if (migrated > 0) {
    db.save();
    logger.info('Migrated plaintext secrets to encrypted form', { count: migrated });
  }
}

// ---------------------------------------------------------------------------
// Key rotation — re-encrypt all secrets with a new key
// ---------------------------------------------------------------------------

/**
 * Rotate the encryption key if it's older than ROTATION_INTERVAL_DAYS.
 *
 * Crash-safe sequence:
 *   1. Decrypt all secrets with the current (old) key
 *   2. Generate a new key, storing the old key as previous_key in the key file
 *      — from this point, decrypt() can read values encrypted with either key
 *   3. Re-encrypt all secrets with the new key
 *   4. db.save() to persist re-encrypted values
 *   5. Remove previous_key from the key file (cleanup)
 *
 * If the process crashes at any point:
 *   - Before step 2: nothing changed, next attempt retries.
 *   - Between 2 and 4: key file has both keys, DB has a mix of old-key and
 *     new-key values. decrypt() handles both via fingerprint fallback.
 *     Next rotation (or manual restart) will finish re-encrypting.
 *   - Between 4 and 5: all values use new key, previous_key is still on
 *     disk but harmless. Cleaned up on next rotation.
 *
 * Returns true if rotation occurred, false if not yet due.
 */
function rotateKeyIfDue() {
  const keyData = loadOrGenerateKey();
  const ageMs = Date.now() - new Date(keyData.created_at).getTime();
  const maxAgeMs = ROTATION_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

  if (ageMs < maxAgeMs) return false;

  logger.info('Encryption key rotation due — rotating…', {
    ageDay: Math.floor(ageMs / 86400000),
    maxDays: ROTATION_INTERVAL_DAYS,
  });

  const { getDb } = require('../db');
  const db = getDb();

  // Step 1: Decrypt all secrets with the current (old) key
  const decrypted = {};
  for (const key of SECRET_KEYS) {
    const row = db.get('SELECT value FROM settings WHERE key = ?', [key]);
    if (row && row.value) {
      try {
        decrypted[key] = decrypt(row.value);
      } catch (err) {
        logger.warn('Skipping key during rotation — decrypt failed', { key, error: err.message });
      }
    }
  }

  // Step 2: Generate new key, preserving old key as fallback
  const oldKeyHex = keyData.key;
  _cachedKey = null;
  generateNewKey(oldKeyHex);

  // Step 3: Re-encrypt with the new key
  for (const [key, value] of Object.entries(decrypted)) {
    const encrypted = encrypt(value);
    db.run("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?", [encrypted, key]);
  }

  // Step 4: Persist re-encrypted values
  db.save();
  logger.info('Encryption key rotated successfully', { reEncrypted: Object.keys(decrypted).length });

  // Step 5: Remove the previous key from the key file (cleanup)
  const cleanKeyData = { key: _cachedKey.key, created_at: _cachedKey.created_at };
  fs.writeFileSync(KEY_FILE, JSON.stringify(cleanKeyData, null, 2) + '\n', { mode: 0o600 });
  _cachedKey = cleanKeyData;

  db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", [
    'encryption_key_rotated',
    JSON.stringify({ reEncrypted: Object.keys(decrypted).length }),
  ]);

  return true;
}

// ---------------------------------------------------------------------------
// Rotation cron — daily check
// ---------------------------------------------------------------------------

let _rotationTask = null;

/** Start a daily cron job that checks if key rotation is due. */
function startKeyRotationCron() {
  if (_rotationTask) return;

  _rotationTask = cron.schedule('0 2 * * *', () => {
    try {
      rotateKeyIfDue();
    } catch (err) {
      logger.error('Encryption key rotation failed', { error: err.message });
    }
  });

  logger.info('Encryption key rotation cron started (daily at 02:00)');
}

function stopKeyRotationCron() {
  if (_rotationTask) {
    _rotationTask.stop();
    _rotationTask = null;
  }
}

module.exports = {
  ensureEncryptionKey,
  encrypt,
  decrypt,
  isEncrypted,
  migrateSecretsToEncrypted,
  rotateKeyIfDue,
  startKeyRotationCron,
  stopKeyRotationCron,
};
