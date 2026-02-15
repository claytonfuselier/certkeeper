const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Load .env — optional; all values have sensible defaults
// ---------------------------------------------------------------------------
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath, quiet: true });
}

// ---------------------------------------------------------------------------
// Data directory (resolved early — session secret may live here)
// ---------------------------------------------------------------------------
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

// ---------------------------------------------------------------------------
// Session secret: env var → file on disk → auto-generate and persist
// ---------------------------------------------------------------------------
const SECRET_FILE = path.join(dataDir, '.session-secret');

function resolveSessionSecret() {
  // 1. Env var takes priority
  const envVal = (process.env.SESSION_SECRET || '').trim();
  if (envVal) return envVal;

  // 2. Read from persisted file
  if (fs.existsSync(SECRET_FILE)) {
    const stored = fs.readFileSync(SECRET_FILE, 'utf-8').trim();
    if (stored) return stored;
  }

  // 3. Auto-generate a cryptographically random secret and persist it
  const generated = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(SECRET_FILE, generated + '\n', { mode: 0o600 });
  return generated;
}

const sessionSecret = resolveSessionSecret();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const errors = [];

const PLACEHOLDER_SECRETS = ['change-me-to-a-random-string', 'change-me', 'dev-secret-change-me'];

// Registration email is optional in .env — can be set via UI on first visit
const rawLetsencryptEmail = (process.env.LETSENCRYPT_EMAIL || '').trim();
// Only reject if explicitly set to the placeholder
if (rawLetsencryptEmail === 'you@example.com') {
  errors.push('LETSENCRYPT_EMAIL still has the placeholder value — set a real email or comment out the line');
}

// Admin credentials are optional — if absent, user is prompted on first visit
const adminUsername = (process.env.ADMIN_USERNAME || '').trim();
const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();

// If one is set, both must be set, and password must not be a placeholder
if (adminUsername || adminPassword) {
  if (!adminUsername) errors.push('ADMIN_USERNAME is required when ADMIN_PASSWORD is set');
  if (!adminPassword) {
    errors.push('ADMIN_PASSWORD is required when ADMIN_USERNAME is set');
  } else if (PLACEHOLDER_SECRETS.includes(adminPassword)) {
    errors.push(`ADMIN_PASSWORD still has the placeholder value "${adminPassword}" — set a real value`);
  }
}

// Cloudflare token: if the env var line is present and uncommented but empty, that's an error
const rawCfToken = process.env.CLOUDFLARE_API_TOKEN;
const cloudflareApiToken = (rawCfToken || '').trim();
// Only error if the key is explicitly set to empty (not commented-out / missing)
if (rawCfToken !== undefined && rawCfToken.trim() === '') {
  errors.push('CLOUDFLARE_API_TOKEN is set but empty — provide a token or comment out / remove the line');
}

if (errors.length > 0) {
  console.error('\n✖  Invalid configuration:\n');
  errors.forEach((e) => console.error(`   • ${e}`));
  console.error('\n   Edit your .env file and try again.\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Export config
// ---------------------------------------------------------------------------
module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'production',
  useHttp: process.env.USE_HTTP === 'true',

  sessionSecret,

  admin: {
    username: adminUsername || '',
    password: adminPassword || '',
    fromEnv: !!(adminUsername && adminPassword),
  },

  letsencrypt: {
    staging: process.env.LETSENCRYPT_STAGING === 'true',
    email: rawLetsencryptEmail || '',
    emailFromEnv: !!rawLetsencryptEmail,
  },

  cloudflare: {
    apiToken: cloudflareApiToken,
  },

  paths: {
    data: dataDir,
    logs: process.env.LOG_DIR || path.join(__dirname, '..', 'logs'),
    db: path.join(dataDir, 'certkeeper.db'),
    certbotConfig: process.env.CERTBOT_CONFIG_DIR || '/etc/letsencrypt',
    certbotWork: process.env.CERTBOT_WORK_DIR || '/var/lib/letsencrypt',
    get certbotLogs() { return this.logs; },
    cloudflareIni: path.join(dataDir, 'cloudflare.ini'),
  },

  renewalCron: process.env.RENEWAL_CRON || '',
  renewalCronFromEnv: !!process.env.RENEWAL_CRON,
};
