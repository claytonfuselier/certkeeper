/* =============================================
   CertKeeper — Global App State
   ============================================= */

import { api } from './api.js';

// ---------- State ----------

let _hasCloudflareToken = false;
let _cloudflareSource = 'none'; // 'env' | 'database' | 'none'
let _credentialsSource = 'database'; // 'env' | 'database'
let _tlsSource = 'self-signed'; // 'self-signed' | 'custom'
let _agentCount = 0;
let _serviceCertId = null; // certificate ID used for server TLS, or null

// ---------- Getters ----------

export function hasCloudflareToken() { return _hasCloudflareToken; }
export function cloudflareSource() { return _cloudflareSource; }
export function credentialsSource() { return _credentialsSource; }
export function tlsSource() { return _tlsSource; }
export function agentCount() { return _agentCount; }
export function serviceCertId() { return _serviceCertId; }

// ---------- Setters (for sync from dashboard/settings loads) ----------

export function setCloudflareToken(has) { _hasCloudflareToken = has; }
export function setCloudflareSource(src) { _cloudflareSource = src; }
export function setCredentialsSource(src) { _credentialsSource = src; }
export function setTlsSource(src) { _tlsSource = src; }
export function setAgentCount(n) { _agentCount = n; }
export function setServiceCertId(id) { _serviceCertId = id; }

// ---------- Refresh from API ----------

/** Refresh TLS / agent global state from settings API (lightweight). */
export async function refreshTlsState() {
  try {
    const data = await api('GET', '/api/settings');
    _tlsSource = data.tls?.source || 'self-signed';
    _agentCount = data.agents?.count || 0;
    _serviceCertId = data.tls?.serviceCertId || null;
  } catch { /* best effort — globals retain previous values */ }
}
