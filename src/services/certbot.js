const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const { getDb } = require('../db');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a command and return { code, stdout, stderr }.
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: 300_000, ...opts }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        return resolve({
          code: 'ENOENT',
          stdout: '',
          stderr: `"${cmd}" was not found. Make sure certbot is installed and available in your PATH.`,
        });
      }
      if (err && err.killed) {
        return resolve({
          code: 'TIMEOUT',
          stdout: stdout || '',
          stderr: 'certbot timed out after 5 minutes. The operation took too long to complete.',
        });
      }
      resolve({ code: err ? err.code ?? 1 : 0, stdout: stdout || '', stderr: stderr || '' });
    });
    child.stdout?.on('data', (d) => logger.debug(`[certbot] ${d}`));
    child.stderr?.on('data', (d) => logger.debug(`[certbot:err] ${d}`));
  });
}

/**
 * Classify a certbot error into a user-friendly { title, detail, link } object.
 */
function classifyError(code, rawMsg) {
  const msg = (rawMsg || '').toLowerCase();

  if (code === 'ENOENT') {
    return {
      title: 'certbot not found',
      detail: 'The certbot CLI is not installed or not in the system PATH. Install it via your package manager (e.g. apt install certbot) or use the Docker image which includes it.',
      link: 'https://certbot.eff.org/instructions',
    };
  }
  if (code === 'TIMEOUT') {
    return {
      title: 'Operation timed out',
      detail: 'certbot did not finish within 5 minutes. This can happen with slow DNS propagation or network issues. Try again, or increase the timeout if this persists.',
      link: 'https://community.letsencrypt.org/',
    };
  }
  if (msg.includes('too many certificates') || msg.includes('rate limit')) {
    return {
      title: 'Rate limit reached',
      detail: "Let's Encrypt limits how many certificates you can issue per domain per week. Wait and try again later, or use staging mode for testing.",
      link: 'https://letsencrypt.org/docs/rate-limits/',
    };
  }
  if (msg.includes('unauthorized') || msg.includes('challenge failed') || msg.includes('validation')) {
    return {
      title: 'Domain validation failed',
      detail: 'The ACME challenge could not be verified. For HTTP-01, ensure port 80 is open and the domain points to this server. For DNS-01, verify your Cloudflare API token has the correct zone permissions.',
      link: 'https://letsencrypt.org/docs/challenge-types/',
    };
  }
  if (msg.includes('dns') || msg.includes('cloudflare') || msg.includes('propagation')) {
    return {
      title: 'DNS error',
      detail: 'There was a problem with DNS verification. Ensure your Cloudflare API token is valid and has Zone → DNS → Edit permissions for the domain.',
      link: 'https://certbot-dns-cloudflare.readthedocs.io/',
    };
  }
  if (msg.includes('connection') || msg.includes('timeout') || msg.includes('network')) {
    return {
      title: 'Network error',
      detail: "Could not reach the Let's Encrypt servers. Check your internet connection and firewall settings.",
      link: 'https://community.letsencrypt.org/',
    };
  }
  if (msg.includes('port 80') || msg.includes('address already in use') || msg.includes('bind')) {
    return {
      title: 'Port 80 in use',
      detail: 'HTTP-01 challenges require port 80 to be available. Stop any web server or process using port 80, or switch to DNS-01 challenge type.',
      link: 'https://letsencrypt.org/docs/challenge-types/#http-01-challenge',
    };
  }
  if (msg.includes('permission') || msg.includes('access denied') || msg.includes('eacces')) {
    return {
      title: 'Permission denied',
      detail: 'certbot does not have the required filesystem permissions. Ensure it can write to the certificate directories (typically /etc/letsencrypt).',
      link: 'https://certbot.eff.org/docs/using.html',
    };
  }
  // Fallback
  return {
    title: 'Certificate operation failed',
    detail: rawMsg || 'An unknown error occurred. Check the server logs for more details.',
    link: 'https://community.letsencrypt.org/',
  };
}

/**
 * Build the base certbot args (paths, email, agree-tos, non-interactive).
 */
/**
 * Resolve the registration email: env var wins, then DB fallback.
 */
function getLetsencryptEmail() {
  const envEmail = config.letsencrypt.email;
  if (envEmail) return envEmail;

  try {
    const db = getDb();
    const row = db.get("SELECT value FROM settings WHERE key = 'letsencrypt_email'");
    return row ? row.value : '';
  } catch {
    return '';
  }
}

function baseArgs() {
  const args = [
    '--non-interactive',
    '--agree-tos',
    '--config-dir', config.paths.certbotConfig,
    '--work-dir', config.paths.certbotWork,
    '--logs-dir', config.paths.certbotLogs,
  ];

  const email = getLetsencryptEmail();
  if (email) {
    args.push('--email', email);
  } else {
    args.push('--register-unsafely-without-email');
  }

  if (config.letsencrypt.staging) {
    args.push('--staging');
  }

  return args;
}

/**
 * Resolve the Cloudflare API token: env var wins, then DB fallback.
 */
function getCloudflareToken() {
  const envToken = config.cloudflare.apiToken;
  if (envToken) return envToken;

  try {
    const db = getDb();
    const row = db.get("SELECT value FROM settings WHERE key = 'cloudflare_api_token'");
    return row ? row.value : '';
  } catch {
    return '';
  }
}

/**
 * Ensure the Cloudflare credentials INI file exists.
 */
function ensureCloudflareIni() {
  const token = getCloudflareToken();
  if (!token) {
    throw new Error('Cloudflare API token is not configured — set it in Settings or via CLOUDFLARE_API_TOKEN env var');
  }
  const ini = `dns_cloudflare_api_token = ${token}\n`;
  fs.mkdirSync(path.dirname(config.paths.cloudflareIni), { recursive: true });
  fs.writeFileSync(config.paths.cloudflareIni, ini, { mode: 0o600 });
}

/**
 * Parse "certbot certificates" output to structured data.
 */
function parseCertbotCertificates(stdout) {
  const certs = [];
  const blocks = stdout.split(/- - - - -/).filter(Boolean);

  for (const block of blocks) {
    const nameMatch = block.match(/Certificate Name:\s*(.+)/);
    const domainsMatch = block.match(/Domains:\s*(.+)/);
    const expiryMatch = block.match(/Expiry Date:\s*([^\(]+)/);
    const validMatch = block.match(/VALID:\s*(\d+)\s*day/i) || block.match(/INVALID/i);

    if (nameMatch) {
      certs.push({
        certbotName: nameMatch[1].trim(),
        domains: domainsMatch ? domainsMatch[1].trim().split(/\s+/) : [],
        expiresAt: expiryMatch ? expiryMatch[1].trim() : null,
        valid: validMatch && !validMatch[0].includes('INVALID'),
      });
    }
  }
  return certs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Issue a new certificate.
 * @param {Object} opts
 * @param {string[]} opts.domains - e.g. ['example.com', '*.example.com']
 * @param {'http-01'|'dns-01'} opts.challengeType
 * @returns {{ success: boolean, message: string }}
 */
async function issueCertificate({ domains, challengeType }) {
  const args = ['certonly', ...baseArgs()];

  // Domain flags
  for (const d of domains) {
    args.push('-d', d);
  }

  if (challengeType === 'dns-01') {
    ensureCloudflareIni();
    args.push(
      '--dns-cloudflare',
      '--dns-cloudflare-credentials', config.paths.cloudflareIni,
      '--dns-cloudflare-propagation-seconds', '30',
    );
  } else {
    // http-01 standalone — certbot will spin up its own mini-server on port 80
    args.push('--standalone');
  }

  logger.info('Issuing certificate', { domains, challengeType });
  const { code, stdout, stderr } = await run('certbot', args);

  if (code !== 0) {
    const rawMsg = (stderr || stdout || '').trim() || 'certbot exited with an error';
    const classified = classifyError(code, rawMsg);
    logger.error('certbot issue failed', { code, rawMsg, classified: classified.title });
    return { success: false, message: rawMsg, error: classified };
  }

  logger.info('Certificate issued successfully', { domains });
  return { success: true, message: 'Certificate issued' };
}

/**
 * Renew a specific certificate by its certbot name.
 */
async function renewCertificate(certName) {
  const args = ['renew', ...baseArgs(), '--cert-name', certName, '--force-renewal'];

  logger.info('Renewing certificate', { certName });
  const { code, stdout, stderr } = await run('certbot', args);

  if (code !== 0) {
    const rawMsg = (stderr || stdout || '').trim() || 'certbot renew failed';
    const classified = classifyError(code, rawMsg);
    logger.error('certbot renew failed', { code, rawMsg, classified: classified.title });
    return { success: false, message: rawMsg, error: classified };
  }

  return { success: true, message: 'Certificate renewed' };
}

/**
 * Renew all certificates that are due.
 */
async function renewAll() {
  const args = ['renew', ...baseArgs()];

  logger.info('Checking certificates for renewal');
  const { code, stdout, stderr } = await run('certbot', args);

  if (code !== 0) {
    const msg = stderr || stdout || 'certbot renew failed';
    logger.error('certbot renew-all failed', { code, msg });
    return { success: false, message: msg };
  }

  // Detect whether certbot actually renewed anything
  const output = stdout || '';
  const renewed = (output.match(/Congratulations|Successfully received|renewed/gi) || []).length > 0;
  const skipped = output.includes('not yet due for renewal') || output.includes('No renewals were attempted');

  if (renewed) {
    logger.info('Certificates were renewed', { output: output.slice(0, 500) });
  } else if (skipped) {
    logger.info('No certificates due for renewal — all skipped');
  } else {
    logger.info('Renewal check complete', { output: output.slice(0, 500) });
  }

  return { success: true, renewed, message: output };
}

/**
 * Revoke a certificate by certbot name.
 */
async function revokeCertificate(certName) {
  const certPath = path.join(config.paths.certbotConfig, 'live', certName, 'cert.pem');
  const args = ['revoke', ...baseArgs(), '--cert-path', certPath, '--delete-after-revoke'];

  logger.info('Revoking certificate', { certName });
  const { code, stdout, stderr } = await run('certbot', args);

  if (code !== 0) {
    const msg = stderr || stdout || 'certbot revoke failed';
    logger.error('certbot revoke failed', { code, msg });
    return { success: false, message: msg };
  }

  return { success: true, message: 'Certificate revoked and deleted' };
}

/**
 * List certificates known to certbot.
 */
async function listCertbotCertificates() {
  const args = ['certificates', ...baseArgs()];
  const { code, stdout, stderr } = await run('certbot', args);

  if (code !== 0) {
    logger.error('certbot certificates failed', { stderr });
    return [];
  }

  return parseCertbotCertificates(stdout);
}

/**
 * Synchronize the local DB with what certbot actually has on disk.
 */
async function syncCertificates() {
  const onDisk = await listCertbotCertificates();
  const db = getDb();

  for (const cert of onDisk) {
    const existing = db.get('SELECT id FROM certificates WHERE certbot_name = ?', [cert.certbotName]);
    const domains = cert.domains.join(' ');
    const expiresAt = cert.expiresAt || null;
    const status = cert.valid ? 'active' : 'expired';

    if (existing) {
      db.run(`
        UPDATE certificates SET domains = ?, status = ?, expires_at = ?, updated_at = datetime('now')
        WHERE id = ?
      `, [domains, status, expiresAt, existing.id]);
    } else {
      db.run(`
        INSERT INTO certificates (domains, challenge_type, status, expires_at, certbot_name, issued_at)
        VALUES (?, 'http-01', ?, ?, ?, datetime('now'))
      `, [domains, status, expiresAt, cert.certbotName]);
    }
  }

  logger.info('Certificate sync complete', { count: onDisk.length });
}

module.exports = {
  issueCertificate,
  renewCertificate,
  renewAll,
  revokeCertificate,
  listCertbotCertificates,
  syncCertificates,
  getCloudflareToken,
};
