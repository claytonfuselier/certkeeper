const express = require('express');
const http = require('http');
const https = require('https');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { execFile } = require('child_process');

const config = require('./config');
const logger = require('./logger');
const { initDatabase, getDb } = require('./db');
const SqliteSessionStore = require('./middleware/sessionStore');
const scheduler = require('./services/scheduler');
const { validateCloudflareToken } = require('./services/cloudflare');
const { getTlsCredentials } = require('./services/tls');

const authRoutes = require('./routes/auth');
const certsRoutes = require('./routes/certs');
const dashboardRoutes = require('./routes/dashboard');
const notificationsRoutes = require('./routes/notifications');
const settingsRoutes = require('./routes/settings');
const agentsRoutes = require('./routes/agents');
const agentApiRoutes = require('./routes/agent-api');
const { requireAuth } = require('./middleware/auth');

// ---------------------------------------------------------------------------
// Ensure admin user exists (only when credentials are set via .env)
// ---------------------------------------------------------------------------
async function ensureAdminUser() {
  if (!config.admin.fromEnv) return; // No env credentials — user will set up via UI

  const db = getDb();
  const existing = db.get('SELECT id FROM users WHERE username = ?', [config.admin.username]);
  if (!existing) {
    const hash = await bcrypt.hash(config.admin.password, 12);
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [config.admin.username, hash]);
    logger.info('Admin user created from .env', { username: config.admin.username });
  } else {
    // Always sync .env password to the DB so restarts with a new ADMIN_PASSWORD take effect
    const hash = await bcrypt.hash(config.admin.password, 12);
    db.run("UPDATE users SET password = ?, updated_at = datetime('now') WHERE username = ?", [hash, config.admin.username]);
    logger.info('Admin user password synced from .env', { username: config.admin.username });
  }
}

// ---------------------------------------------------------------------------
// Validate Cloudflare API token from .env at startup
// ---------------------------------------------------------------------------
async function validateEnvCloudflareToken() {
  if (!config.cloudflare.apiToken) return; // not set via env — nothing to validate

  logger.info('Validating Cloudflare API token from .env…');
  const result = await validateCloudflareToken(config.cloudflare.apiToken);

  if (!result.valid) {
    logger.error('Cloudflare API token validation failed', { error: result.error });
    console.error(`\n✖  CLOUDFLARE_API_TOKEN is invalid: ${result.error}`);
    console.error('   Fix or remove the token from .env and try again.\n');
    process.exit(1);
  }

  logger.info('Cloudflare API token is valid', {
    status: result.status,
    expiresOn: result.expiresOn || 'never',
  });
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Sessions backed by SQLite
fs.mkdirSync(config.paths.data, { recursive: true });
app.use(session({
  store: new SqliteSessionStore(),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: !config.useHttp,
    maxAge: 24 * 60 * 60 * 1000, // 1 day
  },
}));

// --- API Routes ---
app.use('/api/auth', authRoutes);
app.use('/api/certs', certsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/agents', agentsRoutes);
app.use('/api/agent', agentApiRoutes);

// --- Frontend (static files) ---
app.use(express.static(path.join(__dirname, '..', 'public')));

// SPA fallback: serve index.html for any non-API route
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function start() {
  const banner = [
    '   ____          _   _  __',
    '  / ___|___ _ __| |_| |/ /___  ___ _ __   ___ _ __',
    ' | |   / _ \\ \'__| __| \' // _ \\/ _ \\ \'_ \\ / _ \\ \'__|',
    ' | |__|  __/ |  | |_| . \\  __/  __/ |_) |  __/ |',
    '  \\____\\___|_|   \\__|_|\\_\\___|\\___| .__/ \\___|_|',
    '                                  |_|',
  ].join('\n');

  console.log('\n' + banner + '\n');
  logger.info('CertKeeper starting');

  // Require root (certbot needs write access to /etc/letsencrypt and may bind port 80)
  if (process.getuid && process.getuid() !== 0) {
    console.error('\n✖  CertKeeper must be run as root.');
    console.error('   certbot requires write access to certificate directories and may need to bind port 80.\n');
    console.error('   Run with:  sudo node src/index.js\n');
    process.exit(1);
  }

  await initDatabase();
  await ensureAdminUser();
  await validateEnvCloudflareToken();

  // Check if certbot is available (non-blocking warning)
  await new Promise((resolve) => {
    execFile('certbot', ['--version'], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        logger.warn('certbot is not installed or not in PATH — certificate issue and renewal requests will fail');
        console.warn('\n⚠  certbot was not found on this system.');
        console.warn('   Certificate requests and renewals will fail until certbot is installed.');
        console.warn('   Install: https://certbot.eff.org/instructions\n');
      } else {
        logger.info(`certbot found: ${(stdout || '').trim()}`);
      }
      resolve();
    });
  });

  // Recover certs stuck in 'issuing'/'renewing' from a previous crash
  const db = getDb();
  const stuck = db.all("SELECT id FROM certificates WHERE status IN ('issuing', 'renewing')");
  if (stuck.length > 0) {
    const errPayload = JSON.stringify({
      title: 'Server restarted',
      detail: 'The server was restarted while this certificate operation was in progress. The operation was interrupted and did not complete. Please retry.',
      link: '',
    });
    db.run(
      "UPDATE certificates SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE status IN ('issuing', 'renewing')",
      [errPayload],
    );
    logger.info('Recovered stuck certificates', { count: stuck.length, ids: stuck.map((r) => r.id) });
  }

  // Start server — HTTPS by default, plain HTTP when USE_HTTP=true
  let server;
  if (config.useHttp) {
    server = http.createServer(app);
    server.listen(config.port, config.host, (err) => {
      if (err) {
        logger.error('Failed to bind', { err });
        process.exit(1);
      }
      logger.info(`Server listening on http://${config.host}:${config.port} (TLS: disabled via USE_HTTP)`);
      logger.info(`Staging mode: ${config.letsencrypt.staging}`);
    });
  } else {
    const tls = await getTlsCredentials();
    server = https.createServer({ cert: tls.cert, key: tls.key }, app);
    server.listen(config.port, config.host, (err) => {
      if (err) {
        logger.error('Failed to bind', { err });
        process.exit(1);
      }
      logger.info(`Server listening on https://${config.host}:${config.port} (TLS: ${tls.source})`);
      logger.info(`Staging mode: ${config.letsencrypt.staging}`);
    });
  }

  // Start the auto-renewal cron scheduler
  scheduler.start();
}

start().catch((err) => {
  logger.error('Failed to start', { err });
  process.exit(1);
});
