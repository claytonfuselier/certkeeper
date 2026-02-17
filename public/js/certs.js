/* =============================================
   CertKeeper — Certificates Page
   ============================================= */

import { $, $$, show, hide, toast, formatDate, statusBadge, escapeHtml, parseErrorMessage } from './dom.js';
import { api } from './api.js';
import { navigate, currentPage } from './router.js';
import { refreshTlsState, serviceCertId, hasCloudflareToken } from './state.js';

// ---------- Polling ----------

let _pollTimer = null;

function stopPolling() {
  if (_pollTimer) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  _pollTimer = setTimeout(async () => {
    _pollTimer = null;
    if (currentPage() !== 'certificates') return;
    await loadCertificates();
  }, 3000);
}

// ---------- Lifecycle ----------

export function init() {
  initNewCertForm();
  initSyncButton();
}

export function load() {
  updateDns01State();
  loadCertificates();
}

/** Called by the router when navigating away from certificates. */
export function leave() {
  stopPolling();
}

// ---------- Load Certificates ----------

async function loadCertificates() {
  try {
    await refreshTlsState();
    const certs = await api('GET', '/api/certs');
    const tbody = $('#certs-table tbody');
    const empty = $('#certs-empty');

    tbody.innerHTML = '';

    if (certs.length === 0) {
      show(empty);
      stopPolling();
      return;
    }
    hide(empty);

    let hasInProgress = false;
    const _serviceCertId = serviceCertId();

    for (const cert of certs) {
      const inProgress = cert.status === 'issuing' || cert.status === 'renewing';
      if (inProgress) hasInProgress = true;

      const isServiceCert = _serviceCertId !== null && cert.id === _serviceCertId;
      const canRenew = cert.status === 'active' || cert.status === 'expired';
      const canRetry = cert.status === 'error';
      const canRevoke = cert.certbot_name && !['issuing', 'renewing', 'revoked'].includes(cert.status);
      const canRemove = !['issuing', 'renewing'].includes(cert.status);
      const isRevoked = cert.status === 'revoked';
      const hasError = cert.status === 'error' && cert.error_message;

      // Service cert indicator
      const serviceBadge = isServiceCert ? ' <span class="badge" style="background:var(--primary);color:#fff;font-size:.7rem" title="This certificate is used for the server\'s TLS">TLS</span>' : '';

      const tr = document.createElement('tr');
      if (hasError) tr.classList.add('cert-error-row');
      tr.innerHTML = `
        <td>${cert.domains.map((d) => `<code>${escapeHtml(d)}</code>`).join(' ')}${serviceBadge}</td>
        <td>${statusBadge(cert.status, cert.staging)}${inProgress ? ' <span class="spinner"></span>' : ''}${hasError ? ' <button class="btn-error-toggle" title="Show error details">ⓘ</button>' : ''}</td>
        <td>${formatDate(cert.expires_at)}</td>
        <td>
          <label class="toggle">
            <input type="checkbox" data-id="${cert.id}" class="auto-renew-toggle" ${cert.auto_renew ? 'checked' : ''} ${inProgress ? 'disabled' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td>
          <button class="btn btn-sm btn-secondary renew-btn" data-id="${cert.id}" ${canRenew ? '' : 'disabled'}>Renew</button>
          ${canRetry ? `<button class="btn btn-sm btn-secondary retry-btn" data-id="${cert.id}" data-domains="${encodeURIComponent(JSON.stringify(cert.domains))}">Retry</button>` : ''}
          ${isRevoked ? `<button class="btn btn-sm btn-secondary reissue-btn" data-id="${cert.id}" data-domains="${encodeURIComponent(JSON.stringify(cert.domains))}">Reissue</button>` : ''}
          ${canRevoke && !isServiceCert ? `<button class="btn btn-sm btn-danger revoke-btn" data-id="${cert.id}">Revoke</button>` : ''}
          ${canRevoke && isServiceCert ? `<button class="btn btn-sm btn-danger revoke-btn" data-id="${cert.id}" disabled title="Switch TLS to a different certificate before revoking">Revoke</button>` : ''}
          ${canRemove && !isServiceCert ? `<button class="btn btn-sm ${isRevoked || !canRevoke ? 'btn-danger' : 'btn-muted'} remove-btn" data-id="${cert.id}" title="Remove from tracking${canRevoke ? ' without revoking' : ''}">Remove</button>` : ''}
          ${canRemove && isServiceCert ? `<button class="btn btn-sm ${isRevoked || !canRevoke ? 'btn-danger' : 'btn-muted'} remove-btn" data-id="${cert.id}" disabled title="Switch TLS to a different certificate before removing">Remove</button>` : ''}
        </td>
      `;
      tbody.appendChild(tr);

      // Expandable error detail row
      if (hasError) {
        const errInfo = parseErrorMessage(cert.error_message);
        const errTr = document.createElement('tr');
        errTr.classList.add('cert-error-detail');
        errTr.innerHTML = `
          <td colspan="5">
            <div class="error-detail-box">
              <strong>⚠ ${escapeHtml(errInfo.title)}</strong>
              <p>${escapeHtml(errInfo.detail)}</p>
              ${errInfo.link ? `<a href="${escapeHtml(errInfo.link)}" target="_blank" rel="noopener">Learn more →</a>` : ''}
            </div>
          </td>
        `;
        tbody.appendChild(errTr);

        // Toggle visibility on ⓘ click
        const toggleBtn = tr.querySelector('.btn-error-toggle');
        toggleBtn.addEventListener('click', () => {
          errTr.classList.toggle('expanded');
          toggleBtn.textContent = errTr.classList.contains('expanded') ? '✕' : 'ⓘ';
        });
      }
    }

    // Event listeners
    $$('.auto-renew-toggle', tbody).forEach((input) => {
      input.addEventListener('change', async (e) => {
        try {
          await api('PATCH', `/api/certs/${e.target.dataset.id}`, { auto_renew: e.target.checked });
          toast('Auto-renew updated', 'success');
        } catch (err) { toast(err.message, 'error'); }
      });
    });

    $$('.renew-btn', tbody).forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Force renew this certificate?')) return;
        btn.disabled = true;
        try {
          await api('POST', `/api/certs/${btn.dataset.id}/renew`);
          toast('Renewal started — processing in background…', 'info');
          loadCertificates();
        } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
      });
    });

    $$('.revoke-btn', tbody).forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Revoke this certificate? It will be marked as revoked but kept in the list.')) return;
        btn.disabled = true;
        try {
          await api('DELETE', `/api/certs/${btn.dataset.id}?action=revoke`);
          toast('Certificate revoked', 'success');
          loadCertificates();
        } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
      });
    });

    $$('.retry-btn', tbody).forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Retry issuing this certificate?')) return;
        btn.disabled = true;
        try {
          const domains = JSON.parse(decodeURIComponent(btn.dataset.domains));
          await api('DELETE', `/api/certs/${btn.dataset.id}?action=remove`);
          await api('POST', '/api/certs', { domains });
          toast('Retry started — processing in background…', 'info');
          loadCertificates();
        } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
      });
    });

    $$('.reissue-btn', tbody).forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Reissue a new certificate for these domains?')) return;
        btn.disabled = true;
        try {
          const domains = JSON.parse(decodeURIComponent(btn.dataset.domains));
          await api('POST', '/api/certs', { domains, overrideRevoked: true });
          toast('Reissue started — processing in background…', 'info');
          loadCertificates();
        } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
      });
    });

    $$('.remove-btn', tbody).forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this certificate from tracking? The certificate will not be revoked.')) return;
        btn.disabled = true;
        try {
          await api('DELETE', `/api/certs/${btn.dataset.id}?action=remove`);
          toast('Certificate removed from tracking', 'success');
          loadCertificates();
        } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
      });
    });

    // Auto-poll while any cert is in progress
    if (hasInProgress) {
      startPolling();
    } else {
      stopPolling();
    }
  } catch (err) {
    toast(err.message, 'error');
    stopPolling();
  }
}

// ---------- New Certificate Form ----------

function updateDns01State() {
  const warning = $('#dns01-no-token');
  if (!warning) return;

  const noToken = !hasCloudflareToken();

  // Show/hide warning message
  if (noToken) {
    show(warning);
  } else {
    hide(warning);
  }

  // Disable submit button + domains input when no token
  const submitBtn = $('#cert-submit-btn');
  const domainsInput = $('#cert-domains');
  if (submitBtn) {
    submitBtn.disabled = noToken;
    submitBtn.title = noToken ? 'Cloudflare API token required' : '';
  }
  if (domainsInput) {
    domainsInput.disabled = noToken;
  }

  // Disable "New" button on certificates list page
  const newBtn = $('#new-cert-btn');
  if (newBtn) {
    if (noToken) {
      newBtn.classList.add('disabled');
      newBtn.setAttribute('aria-disabled', 'true');
      newBtn.title = 'Cloudflare API token required';
    } else {
      newBtn.classList.remove('disabled');
      newBtn.removeAttribute('aria-disabled');
      newBtn.title = '';
    }
  }
}

function initNewCertForm() {
  const form = $('#new-cert-form');
  const domainsInput = $('#cert-domains');
  const errorEl = $('#cert-form-error');
  const successEl = $('#cert-form-success');
  const submitBtn = $('#cert-submit-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hide(errorEl);
    hide(successEl);

    const raw = domainsInput.value.trim();
    if (!raw) return;

    const domains = raw.split(',').map((d) => d.trim()).filter(Boolean);

    if (!hasCloudflareToken()) {
      errorEl.textContent = 'A Cloudflare API token is required. Add one in Settings → Cloudflare API.';
      show(errorEl);
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    try {
      await api('POST', '/api/certs', { domains });
      form.reset();
      toast('Certificate request submitted — issuing in background…', 'info');
      navigate('/certificates');
    } catch (err) {
      // If a revoked cert exists, offer to override
      if (err.revoked) {
        if (confirm('A revoked certificate exists for these domains. Replace it with a new one?')) {
          try {
            await api('POST', '/api/certs', { domains, overrideRevoked: true });
            form.reset();
            toast('Certificate request submitted — issuing in background…', 'info');
            navigate('/certificates');
          } catch (err2) {
            errorEl.textContent = err2.message;
            show(errorEl);
            toast(err2.message, 'error');
          }
        }
      } else {
        errorEl.textContent = err.message;
        show(errorEl);
        toast(err.message, 'error');
      }
    }

    submitBtn.disabled = false;
    submitBtn.textContent = 'Request Certificate';
  });
}

// ---------- New Cert Page Load ----------

export function loadNewCert() {
  updateDns01State();
}

// ---------- Sync Button ----------

function initSyncButton() {
  $('#sync-btn').addEventListener('click', async () => {
    const btn = $('#sync-btn');
    btn.disabled = true;
    btn.textContent = '🔄 Syncing…';
    try {
      await api('POST', '/api/certs/sync');
      toast('Sync complete', 'success');
      loadCertificates();
    } catch (err) {
      toast(err.message, 'error');
    }
    btn.disabled = false;
    btn.textContent = '🔄 Sync';
  });
}
