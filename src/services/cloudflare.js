const logger = require('../logger');

const CF_VERIFY_URL = 'https://api.cloudflare.com/client/v4/user/tokens/verify';

/**
 * Validate a Cloudflare API token by calling the /user/tokens/verify endpoint.
 * Returns { valid: true, status, expiresOn } on success,
 * or { valid: false, error } on failure.
 */
async function validateCloudflareToken(token) {
  if (!token || !token.trim()) {
    return { valid: false, error: 'Token is empty' };
  }

  try {
    const res = await fetch(CF_VERIFY_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await res.json();

    if (data.success && data.result?.status === 'active') {
      return {
        valid: true,
        status: data.result.status,
        expiresOn: data.result.expires_on || null,
      };
    }

    // Token verified but not active (e.g. expired, disabled)
    if (data.result?.status) {
      return { valid: false, error: `Token status: ${data.result.status}` };
    }

    // API returned errors
    const errMsg = (data.errors || []).map((e) => e.message).join('; ') || 'Unknown error';
    return { valid: false, error: errMsg };
  } catch (err) {
    logger.error('Cloudflare token validation failed', { err: err.message });
    return { valid: false, error: `Network error: ${err.message}` };
  }
}

module.exports = { validateCloudflareToken };
