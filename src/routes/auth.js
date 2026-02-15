const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const config = require('../config');
const logger = require('../logger');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const db = getDb();
    const user = db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.user = { id: user.id, username: user.username };

    logger.info('User logged in', { username });
    db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", ['login', username]);

    return res.json({ ok: true, user: { username: user.username } });
  } catch (err) {
    logger.error('Login error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  const username = req.session?.user?.username;
  req.session.destroy(() => {
    if (username) {
      const db = getDb();
      db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", ['logout', username]);
    }
    res.json({ ok: true });
  });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (req.session?.user) {
    return res.json({ user: req.session.user });
  }

  // Check if any user exists — if not, the frontend should show the setup screen
  const db = getDb();
  const userCount = db.get('SELECT COUNT(*) as count FROM users').count;
  if (userCount === 0) {
    return res.status(401).json({
      user: null,
      needsSetup: true,
      emailFromEnv: config.letsencrypt.emailFromEnv,
      emailValue: config.letsencrypt.email || '',
    });
  }

  return res.status(401).json({ user: null });
});

// POST /api/auth/setup — create initial admin user (only when no users exist)
router.post('/setup', async (req, res) => {
  try {
    const db = getDb();
    const userCount = db.get('SELECT COUNT(*) as count FROM users').count;

    if (userCount > 0) {
      return res.status(400).json({ error: 'Setup already complete — a user already exists' });
    }

    const { username, password, email } = req.body || {};

    if (!username || typeof username !== 'string' || username.trim().length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Validate email before creating the user
    if (!config.letsencrypt.emailFromEnv) {
      if (!email || typeof email !== 'string' || !email.trim()) {
        return res.status(400).json({ error: 'Registration email is required' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
    }

    const hash = await bcrypt.hash(password, 12);
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username.trim(), hash]);

    // Save registration email (already validated above)
    if (!config.letsencrypt.emailFromEnv) {
      const existing = db.get("SELECT key FROM settings WHERE key = 'letsencrypt_email'");
      if (existing) {
        db.run("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'letsencrypt_email'", [email.trim()]);
      } else {
        db.run("INSERT INTO settings (key, value) VALUES ('letsencrypt_email', ?)", [email.trim()]);
      }
      logger.info('Registration email saved during setup', { email: email.trim() });
    }

    logger.info('Initial admin user created via setup', { username: username.trim() });
    db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", ['setup', `User "${username.trim()}" created`]);

    // Auto-login
    req.session.user = {
      id: db.get('SELECT id FROM users WHERE username = ?', [username.trim()]).id,
      username: username.trim(),
    };

    return res.json({ ok: true, user: { username: username.trim() } });
  } catch (err) {
    logger.error('Setup error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/password
router.post('/password', async (req, res) => {
  try {
    if (!req.session?.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Reject if credentials are managed via .env
    if (config.admin.fromEnv) {
      return res.status(400).json({ error: 'Credentials are managed via environment variables. Update .env and restart the server.' });
    }

    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Both current and new passwords required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const db = getDb();
    const user = db.get('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    db.run("UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?", [hash, user.id]);

    logger.info('Password changed', { username: user.username });
    db.run("INSERT INTO audit_log (action, details) VALUES (?, ?)", ['password_change', user.username]);

    return res.json({ ok: true });
  } catch (err) {
    logger.error('Password change error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
