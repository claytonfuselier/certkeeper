const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');

// Ensure data directory exists
fs.mkdirSync(config.paths.data, { recursive: true });

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
    const lastRow = this._db.exec('SELECT last_insert_rowid() as id');
    const lastInsertRowid = lastRow.length > 0 ? lastRow[0].values[0][0] : 0;
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
      challenge_type  TEXT    NOT NULL CHECK(challenge_type IN ('http-01','dns-01')),
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
          challenge_type  TEXT    NOT NULL CHECK(challenge_type IN ('http-01','dns-01')),
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
        INSERT INTO certificates_new SELECT * FROM certificates;
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

  _db.save();
  logger.info('Database initialized', { path: config.paths.db });

  return _db;
}

function getDb() {
  if (!_db) throw new Error('Database not initialized — call initDatabase() first');
  return _db;
}

module.exports = { initDatabase, getDb };
