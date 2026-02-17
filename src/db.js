const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');

let _db = null;

/**
 * Thin wrapper around sql.js that provides a convenient synchronous-looking API.
 */
class Database {
  constructor(sqlDb, filePath) {
    this._db = sqlDb;
    this._filePath = filePath;
    this._saveTimer = null;
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveToDisk();
    }, 500);
  }

  _saveToDisk() {
    try {
      const data = this._db.export();
      fs.writeFileSync(this._filePath, Buffer.from(data));
    } catch (err) {
      logger.error('Failed to save database', { err: err.message });
    }
  }

  /** Execute SQL that doesn't return rows. Returns { changes, lastInsertRowid }. */
  run(sql, params = []) {
    this._db.run(sql, params);
    const changes = this._db.getRowsModified();
    let lastInsertRowid = 0;
    if (sql.trimStart().substring(0, 6).toUpperCase() === 'INSERT') {
      const lastRow = this._db.exec('SELECT last_insert_rowid() as id');
      lastInsertRowid = lastRow.length > 0 ? lastRow[0].values[0][0] : 0;
    }
    this._scheduleSave();
    return { changes, lastInsertRowid };
  }

  /** Execute SQL and return all rows as an array of objects. */
  all(sql, params = []) {
    const stmt = this._db.prepare(sql);
    if (params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  /** Execute SQL and return the first row as an object, or undefined. */
  get(sql, params = []) {
    const rows = this.all(sql, params);
    return rows.length > 0 ? rows[0] : undefined;
  }

  /** Execute raw SQL (DDL, multi-statement). */
  exec(sql) {
    this._db.exec(sql);
    this._scheduleSave();
  }

  /** Force save to disk now. */
  save() {
    this._saveToDisk();
  }

  /** Upsert a row in the settings table. */
  upsertSetting(key, value) {
    this.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      [key, value],
    );
  }
}

/**
 * Convert a JS Date to SQLite datetime string (YYYY-MM-DD HH:MM:SS).
 */
function toSqliteDatetime(date) {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/** Parse pending_actions JSON from an agent row into an array. */
function parsePendingActions(agent) {
  if (!agent.pending_actions) return [];
  try {
    const arr = JSON.parse(agent.pending_actions);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function initDatabase() {
  if (_db) return _db;

  const SQL = await initSqlJs();

  let sqlDb;
  if (fs.existsSync(config.paths.db)) {
    const buffer = fs.readFileSync(config.paths.db);
    sqlDb = new SQL.Database(buffer);
  } else {
    sqlDb = new SQL.Database();
  }

  _db = new Database(sqlDb, config.paths.db);

  _db.exec('PRAGMA foreign_keys = ON;');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT    NOT NULL UNIQUE,
      password    TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS certificates (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      domains         TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','issuing','renewing','active','expired','revoked','error')),
      issued_at       TEXT,
      expires_at      TEXT,
      last_renewed_at TEXT,
      auto_renew      INTEGER NOT NULL DEFAULT 1,
      certbot_name    TEXT,
      error_message   TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action      TEXT NOT NULL,
      details     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid        TEXT PRIMARY KEY,
      sess       TEXT NOT NULL,
      expired    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ---- Migrations ----

  // Migrate certificates table to support 'issuing' and 'renewing' statuses.
  // SQLite CHECK constraints can't be altered, so we recreate the table if needed.
  try {
    const tableInfo = _db._db.exec(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='certificates'"
    );
    const ddl = tableInfo.length > 0 && tableInfo[0].values.length > 0
      ? tableInfo[0].values[0][0]
      : '';
    if (ddl && !ddl.includes('issuing')) {
      logger.info('Migrating certificates table to support issuing/renewing statuses');
      _db.exec(`
        CREATE TABLE certificates_new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          domains         TEXT    NOT NULL,
          status          TEXT    NOT NULL DEFAULT 'pending'
                            CHECK(status IN ('pending','issuing','renewing','active','expired','revoked','error')),
          issued_at       TEXT,
          expires_at      TEXT,
          last_renewed_at TEXT,
          auto_renew      INTEGER NOT NULL DEFAULT 1,
          certbot_name    TEXT,
          error_message   TEXT,
          created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO certificates_new (id, domains, status, issued_at, expires_at, last_renewed_at, auto_renew, certbot_name, error_message, created_at, updated_at)
          SELECT id, domains, status, issued_at, expires_at, last_renewed_at, auto_renew, certbot_name, error_message, created_at, updated_at FROM certificates;
        DROP TABLE certificates;
        ALTER TABLE certificates_new RENAME TO certificates;
      `);
    }
  } catch (migErr) {
    logger.error('Certificate table migration failed', { err: migErr.message });
  }

  // Add 'staging' column to certificates if missing
  try {
    const tableInfo = _db._db.exec(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='certificates'"
    );
    const ddl = tableInfo.length > 0 && tableInfo[0].values.length > 0
      ? tableInfo[0].values[0][0]
      : '';
    if (ddl && !ddl.includes('staging')) {
      logger.info('Adding staging column to certificates table');
      _db.exec("ALTER TABLE certificates ADD COLUMN staging INTEGER NOT NULL DEFAULT 0");
    }
  } catch (migErr) {
    logger.error('Staging column migration failed', { err: migErr.message });
  }

  // Drop challenge_type column (DNS-01 only — HTTP-01 support removed)
  try {
    const tableInfo = _db._db.exec(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='certificates'"
    );
    const ddl = tableInfo.length > 0 && tableInfo[0].values.length > 0
      ? tableInfo[0].values[0][0]
      : '';
    if (ddl && ddl.includes('challenge_type')) {
      logger.info('Dropping challenge_type column from certificates table (DNS-01 only)');
      _db.exec(`
        CREATE TABLE certificates_new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          domains         TEXT    NOT NULL,
          status          TEXT    NOT NULL DEFAULT 'pending'
                            CHECK(status IN ('pending','issuing','renewing','active','expired','revoked','error')),
          issued_at       TEXT,
          expires_at      TEXT,
          last_renewed_at TEXT,
          auto_renew      INTEGER NOT NULL DEFAULT 1,
          certbot_name    TEXT,
          error_message   TEXT,
          staging         INTEGER NOT NULL DEFAULT 0,
          created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO certificates_new (id, domains, status, issued_at, expires_at, last_renewed_at, auto_renew, certbot_name, error_message, staging, created_at, updated_at)
          SELECT id, domains, status, issued_at, expires_at, last_renewed_at, auto_renew, certbot_name, error_message, COALESCE(staging, 0), created_at, updated_at FROM certificates;
        DROP TABLE certificates;
        ALTER TABLE certificates_new RENAME TO certificates;
      `);
    }
  } catch (migErr) {
    logger.error('challenge_type column migration failed', { err: migErr.message });
  }

  // Create agents table (for certkeeper-agent auth — mTLS with enrollment token bootstrap)
  _db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      name                    TEXT    NOT NULL,
      enrollment_token_hash   TEXT,
      enrollment_expires_at   TEXT,
      cert_fingerprint        TEXT    UNIQUE,
      cert_expires_at         TEXT,
      prev_cert_fingerprint   TEXT    UNIQUE,
      prev_cert_expires_at    TEXT,
      cert_serial             INTEGER NOT NULL DEFAULT 0,
      enabled                 INTEGER NOT NULL DEFAULT 1,
      status                  TEXT,
      next_contact_at         TEXT,
      config_version          INTEGER NOT NULL DEFAULT 0,
      pending_actions         TEXT,
      last_contact_at         TEXT,
      last_contact_ip         TEXT,
      created_at              TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id        INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      certificate_id  INTEGER NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,
      name            TEXT    NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,
      last_deployed_at    TEXT,
      last_deployed_hash  TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ---- Agent / deployment migrations ----

  // Drop old agent_cert_scopes table if it exists (replaced by deployments)
  try {
    const oldTable = _db._db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_cert_scopes'"
    );
    if (oldTable.length > 0 && oldTable[0].values.length > 0) {
      logger.info('Dropping legacy agent_cert_scopes table (replaced by deployments)');
      _db.exec('DROP TABLE IF EXISTS agent_cert_scopes');
    }
  } catch (migErr) {
    logger.error('agent_cert_scopes migration failed', { err: migErr.message });
  }

  // Add mTLS columns to agents table if missing (migration from older schema)
  try {
    const agentDDL = _db._db.exec(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'"
    );
    const ddl = agentDDL.length > 0 && agentDDL[0].values.length > 0
      ? agentDDL[0].values[0][0]
      : '';
    if (ddl && !ddl.includes('cert_fingerprint')) {
      logger.info('Migrating agents table to support mTLS authentication');
      _db.exec('ALTER TABLE agents ADD COLUMN enrollment_token_hash TEXT');
      _db.exec('ALTER TABLE agents ADD COLUMN enrollment_expires_at TEXT');
      _db.exec('ALTER TABLE agents ADD COLUMN cert_fingerprint TEXT UNIQUE');
      _db.exec('ALTER TABLE agents ADD COLUMN cert_expires_at TEXT');
      _db.exec('ALTER TABLE agents ADD COLUMN prev_cert_fingerprint TEXT');
      _db.exec('ALTER TABLE agents ADD COLUMN prev_cert_expires_at TEXT');
      _db.exec('ALTER TABLE agents ADD COLUMN cert_serial INTEGER NOT NULL DEFAULT 0');
    }
    // Add prev_cert columns if missing (migration from single-fingerprint schema)
    if (ddl && ddl.includes('cert_fingerprint') && !ddl.includes('prev_cert_fingerprint')) {
      logger.info('Migrating agents table to support dual cert fingerprints');
      _db.exec('ALTER TABLE agents ADD COLUMN prev_cert_fingerprint TEXT');
      _db.exec('ALTER TABLE agents ADD COLUMN prev_cert_expires_at TEXT');
    }
  } catch (migErr) {
    logger.error('Agent mTLS migration failed', { err: migErr.message });
  }

  // Add heartbeat / status columns to agents if missing
  try {
    const agentDDL = _db._db.exec(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'"
    );
    const ddl = agentDDL.length > 0 && agentDDL[0].values.length > 0
      ? agentDDL[0].values[0][0]
      : '';
    if (ddl && !ddl.includes('next_contact_at')) {
      logger.info('Migrating agents table to support heartbeat monitoring');
      _db.exec("ALTER TABLE agents ADD COLUMN status TEXT");
      _db.exec("ALTER TABLE agents ADD COLUMN next_contact_at TEXT");
      _db.exec("ALTER TABLE agents ADD COLUMN config_version INTEGER NOT NULL DEFAULT 0");
      _db.exec("ALTER TABLE agents ADD COLUMN pending_actions TEXT");
    }
  } catch (migErr) {
    logger.error('Agent heartbeat migration failed', { err: migErr.message });
  }

  // Add unique constraint on deployments(agent_id, certificate_id) if missing
  try {
    const idxExists = _db._db.exec(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_deployments_agent_cert'"
    );
    if (idxExists.length === 0 || idxExists[0].values.length === 0) {
      _db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_agent_cert ON deployments(agent_id, certificate_id)');
      logger.info('Added unique index on deployments(agent_id, certificate_id)');
    }
  } catch (migErr) {
    logger.error('Deployments unique index migration failed', { err: migErr.message });
  }

  // Seed default agent monitoring settings if not present
  const agentDefaults = {
    agent_heartbeat_interval: '180',   // 3 minutes (in seconds)
    agent_offline_threshold: '3',      // missed heartbeats
    agent_config_version: '1',         // global config version — incremented on setting changes
  };
  for (const [key, value] of Object.entries(agentDefaults)) {
    const existing = _db.get('SELECT key FROM settings WHERE key = ?', [key]);
    if (!existing) {
      _db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
    }
  }

  _db.save();
  logger.info('Database initialized', { path: config.paths.db });

  return _db;
}

function getDb() {
  if (!_db) throw new Error('Database not initialized — call initDatabase() first');
  return _db;
}

/**
 * Parse a route parameter as a positive integer ID.
 * Returns the integer or null if invalid.
 */
function parseIntId(val) {
  const id = Number(val);
  if (!Number.isInteger(id) || id < 1) return null;
  return id;
}

module.exports = { initDatabase, getDb, toSqliteDatetime, parsePendingActions, parseIntId };
