/* =============================================
   CertKeeper — Dashboard Page
   ============================================= */

import { $, toast, formatDate } from './dom.js';
import { api } from './api.js';
import { setCloudflareToken, setCloudflareSource } from './state.js';

// ---------- Lifecycle ----------

export function load() {
  loadDashboard();
}

// ---------- Internal ----------

async function loadDashboard() {
  try {
    const data = await api('GET', '/api/dashboard');
    $('#stat-total').textContent = data.total;
    $('#stat-active').textContent = data.active;
    $('#stat-expiring').textContent = data.expiring;
    $('#stat-errors').textContent = data.errors;

    // Keep cloudflare token state in sync
    setCloudflareToken(data.hasCloudflareToken);
    if (data.cloudflareSource) setCloudflareSource(data.cloudflareSource);

    const tbody = $('#audit-table tbody');
    tbody.innerHTML = '';
    for (const row of data.recentAudit) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${formatDate(row.created_at)}</td>
        <td>${row.action}</td>
        <td style="color:var(--text-muted)">${row.details || ''}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}
