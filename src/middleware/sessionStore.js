const session = require('express-session');
const { getDb } = require('../db');

/**
 * A simple SQLite-backed session store using sql.js.
 */
class SqliteSessionStore extends session.Store {
  constructor() {
    super();
  }

  get(sid, callback) {
    try {
      const db = getDb();
      const row = db.get("SELECT sess FROM sessions WHERE sid = ? AND datetime(expired) > datetime('now')", [sid]);
      if (row) {
        callback(null, JSON.parse(row.sess));
      } else {
        callback(null, null);
      }
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      const db = getDb();
      const maxAge = sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : 86400000;
      const expired = new Date(Date.now() + maxAge).toISOString();
      const sessStr = JSON.stringify(sess);

      const existing = db.get('SELECT sid FROM sessions WHERE sid = ?', [sid]);
      if (existing) {
        db.run('UPDATE sessions SET sess = ?, expired = ? WHERE sid = ?', [sessStr, expired, sid]);
      } else {
        db.run('INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?)', [sid, sessStr, expired]);
      }
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      const db = getDb();
      db.run('DELETE FROM sessions WHERE sid = ?', [sid]);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  /** Clean up expired sessions */
  clearExpired() {
    try {
      const db = getDb();
      db.run("DELETE FROM sessions WHERE datetime(expired) <= datetime('now')");
    } catch { /* ignore */ }
  }
}

module.exports = SqliteSessionStore;
