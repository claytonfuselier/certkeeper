const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const { getDb } = require('../db');
const { getEffectiveCloudflareToken, getEffectiveLetsencryptEmail } = require('./configHelpers');

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
      detail: 'The DNS-01 challenge could not be verified. Ensure your Cloudflare API token has the correct zone permissions for the domain.',
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
      title: 'Port conflict',
      detail: 'A port conflict was detected during certificate issuance. This is unexpected with DNS-01 challenges.',
      link: 'https://community.letsencrypt.org/',
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

function baseArgs() {
  const args = [
    '--non-interactive',
    '--agree-tos',
    '--config-dir', config.paths.certbotConfig,
    '--work-dir', config.paths.certbotWork,
    '--logs-dir', config.paths.certbotLogs,
  ];

  const email = getEffectiveLetsencryptEmail();
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
 * Ensure the Cloudflare credentials INI file exists.
 */
function ensureCloudflareIni() {
  const token = getEffectiveCloudflareToken();
  if (!token) {
    throw new Error('Cloudflare API token is not configured — set it in Settings or via CLOUDFLARE_API_TOKEN env var');
  }
  const ini = `dns_cloudflare_api_token = ${token}\n`;
  fs.mkdirSync(path.dirname(config.paths.cloudflareIni), { recursive: true });
  fs.writeFileSync(config.paths.cloudflareIni, ini, { mode: 0o600 });
}

/**
 * Delete the Cloudflare credentials INI file from disk.
 */
function deleteCloudflareIni() {
  try {
    fs.unlinkSync(config.paths.cloudflareIni);
    logger.info('Deleted cloudflare.ini from disk');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn('Failed to delete cloudflare.ini', { err: err.message });
    }
  }
}

/**
 * Parse "certbot certificates" output to structured data.
 */
function parseCertbotCertificates(stdout) {
  const certs = [];
  const blocks = stdout.split(/- - - - -/).filter(Boolean);

  for (const block of blocks) {
    const nameMatch = block.match(/Certificate Name:\s*(.+)/);
    // Domains may span multiple lines; capture the first line then any continuation
    // lines that are indented (certbot indents overflow domains).
    let domains = [];
    const domainsMatch = block.match(/Domains:\s*(.+(?:\n\s{2,}.+)*)/);
    if (domainsMatch) {
      domains = domainsMatch[1].trim().split(/\s+/).filter(Boolean);
    }
    const expiryMatch = block.match(/Expiry Date:\s*([^\(]+)/);
    const validMatch = block.match(/VALID:\s*(\d+)\s*day/i) || block.match(/INVALID[:\s]*([\w_]*)/i);

    if (nameMatch) {
      const isInvalid = validMatch && validMatch[0].includes('INVALID');
      const isTestCert = isInvalid && /TEST_CERT/.test(validMatch[0]);

      certs.push({
        certbotName: nameMatch[1].trim(),
        domains,
        expiresAt: expiryMatch ? expiryMatch[1].trim() : null,
        valid: validMatch && !isInvalid,
        staging: isTestCert,
      });
    }
  }
  return certs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Issue a new certificate via DNS-01 (Cloudflare).
 * @param {Object} opts
 * @param {string[]} opts.domains - e.g. ['example.com', '*.example.com']
 * @returns {{ success: boolean, message: string }}
 */
async function issueCertificate({ domains }) {
  const args = ['certonly', ...baseArgs()];

  // Domain flags
  for (const d of domains) {
    args.push('-d', d);
  }

  // DNS-01 via Cloudflare
  ensureCloudflareIni();
  args.push(
    '--dns-cloudflare',
    '--dns-cloudflare-credentials', config.paths.cloudflareIni,
    '--dns-cloudflare-propagation-seconds', '30',
  );

  logger.info('Issuing certificate', { domains });
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

  // certbot may output certificate info to stderr instead of stdout
  const output = stdout || stderr || '';
  return parseCertbotCertificates(output);
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
      // Never overwrite domains with empty data from a parse failure
      if (domains) {
        db.run(`
          UPDATE certificates SET domains = ?, status = ?, expires_at = ?, staging = ?, updated_at = datetime('now')
          WHERE id = ? AND status NOT IN ('issuing', 'renewing')
        `, [domains, status, expiresAt, cert.staging ? 1 : 0, existing.id]);
      } else {
        db.run(`
          UPDATE certificates SET status = ?, expires_at = ?, staging = ?, updated_at = datetime('now')
          WHERE id = ? AND status NOT IN ('issuing', 'renewing')
        `, [status, expiresAt, cert.staging ? 1 : 0, existing.id]);
      }
    } else if (domains) {
      db.run(`
        INSERT INTO certificates (domains, status, expires_at, certbot_name, staging, issued_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `, [domains, status, expiresAt, cert.certbotName, cert.staging ? 1 : 0]);
    } else {
      logger.warn('Skipping certbot certificate with no domains', { certbotName: cert.certbotName });
    }
  }

  logger.info('Certificate sync complete', { count: onDisk.length });
}

/**
 * Delete a certificate from disk by certbot name (no revocation).
 */
async function deleteCertificate(certName) {
  const args = ['delete', ...baseArgs(), '--cert-name', certName];

  logger.info('Deleting certificate from disk', { certName });
  const { code, stdout, stderr } = await run('certbot', args);

  if (code !== 0) {
    const msg = stderr || stdout || 'certbot delete failed';
    logger.error('certbot delete failed', { code, msg });
    return { success: false, message: msg };
  }

  return { success: true, message: 'Certificate deleted from disk' };
}

module.exports = {
  issueCertificate,
  renewCertificate,
  renewAll,
  revokeCertificate,
  deleteCertificate,
  listCertbotCertificates,
  syncCertificates,
  ensureCloudflareIni,
  deleteCloudflareIni,
};
