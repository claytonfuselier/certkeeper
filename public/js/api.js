/* =============================================
   CertKeeper — API Fetch Wrapper
   ============================================= */

import { toast } from './dom.js';
import { navigate } from './router.js';

/**
 * Central fetch wrapper. Throws on non-2xx with the full response body
 * attached to the Error object. Redirects to /login on 401.
 */
export async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !url.includes('/api/auth/')) {
      navigate('/login');
      throw new Error('Session expired');
    }
    const err = new Error(data.error || `Request failed (${res.status})`);
    Object.assign(err, data); // attach full response (e.g. revoked flag)
    throw err;
  }
  return data;
}
