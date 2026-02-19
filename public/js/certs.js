/* =============================================
   CertKeeper — Certificates Page
   ============================================= */

import { $, $$, show, hide, toast, formatDate, formatDateTime, statusBadge, escapeHtml, parseErrorMessage, confirmModal } from './dom.js';
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
  initBulkActions();
  initSelectAll();
}

export async function load() {
  await refreshTlsState();
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
    const certs = await api('GET', '/api/certs');
    const tbody = $('#certs-table tbody');
    const empty = $('#certs-empty');

    tbody.innerHTML = '';

    if (certs.length === 0) {
      show(empty);
      hide($('#cert-action-bar'));
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
      const hasError = cert.status === 'error' && cert.error_message;

      // Service cert indicator
      const serviceBadge = isServiceCert ? ' <span class="badge" style="background:var(--primary);color:#fff;font-size:.7rem" title="This certificate is used for the server\'s TLS">TLS</span>' : '';

      const tr = document.createElement('tr');
      if (hasError) tr.classList.add('cert-error-row');
      tr.innerHTML = `
        <td><input type="checkbox" class="cert-select" data-id="${cert.id}" ${inProgress ? 'disabled' : ''}></td>
        <td>${cert.domains.filter(Boolean).map((d) => `<span class="cert-domain">${escapeHtml(d)}</span>`).join(' ') || '<span class="text-muted">No domains</span>'}${serviceBadge}</td>
        <td>${statusBadge(cert.status, cert.staging)}${inProgress ? ' <span class="spinner"></span>' : ''}${hasError ? ' <button class="btn-error-toggle" title="Show error details">ⓘ</button>' : ''}</td>
        <td>${formatDateTime(cert.expires_at)}</td>
        <td>
          <label class="toggle">
            <input type="checkbox" data-id="${cert.id}" class="auto-renew-toggle" ${cert.auto_renew ? 'checked' : ''} ${inProgress ? 'disabled' : ''}>
            <span class="toggle-slider"></span>
          </label>
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

    // Event listeners — auto-renew inline toggle
    $$('.auto-renew-toggle', tbody).forEach((input) => {
      input.addEventListener('change', async (e) => {
        try {
          await api('PATCH', `/api/certs/${e.target.dataset.id}`, { auto_renew: e.target.checked });
          toast('Auto-renew updated', 'success');
        } catch (err) { toast(err.message, 'error'); }
      });
    });

    // Checkbox selection listeners
    $$('.cert-select', tbody).forEach((cb) => {
      cb.addEventListener('change', updateSelectionState);
    });

    // Reset select-all checkbox
    $('#cert-select-all').checked = false;
    updateSelectionState();

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

// ---------- Selection & Bulk Actions ----------

function getSelectedIds() {
  return $$('.cert-select:checked').map((cb) => parseInt(cb.dataset.id, 10));
}

function updateSelectionState() {
  const selected = getSelectedIds();
  const count = selected.length;
  const actionBar = $('#cert-action-bar');
  const countEl = $('#cert-selected-count');

  if (count > 0) {
    show(actionBar);
    countEl.textContent = `${count} selected`;
    $('#bulk-renew-btn').disabled = false;
    $('#bulk-revoke-btn').disabled = false;
    $('#bulk-remove-btn').disabled = false;
  } else {
    show(actionBar);
    countEl.textContent = '0 selected';
    $('#bulk-renew-btn').disabled = true;
    $('#bulk-revoke-btn').disabled = true;
    $('#bulk-remove-btn').disabled = true;
  }

  // Update select-all checkbox state
  const allCheckboxes = $$('.cert-select:not(:disabled)');
  const allChecked = allCheckboxes.length > 0 && allCheckboxes.every((cb) => cb.checked);
  const someChecked = allCheckboxes.some((cb) => cb.checked);
  const selectAll = $('#cert-select-all');
  selectAll.checked = allChecked;
  selectAll.indeterminate = someChecked && !allChecked;
}

function initSelectAll() {
  $('#cert-select-all').addEventListener('change', (e) => {
    const checked = e.target.checked;
    $$('.cert-select:not(:disabled)').forEach((cb) => { cb.checked = checked; });
    updateSelectionState();
  });
}

async function executeBulkAction(action, confirmMsg) {
  const ids = getSelectedIds();
  if (ids.length === 0) {
    toast('No certificates selected', 'error');
    return;
  }
  if (!(await confirmModal(confirmMsg, { title: 'Bulk Action', okLabel: action === 'remove' || action === 'revoke' ? action.charAt(0).toUpperCase() + action.slice(1) : 'Confirm', danger: action === 'remove' || action === 'revoke' }))) return;

  try {
    const result = await api('POST', '/api/certs/bulk', { ids, action });
    if (result.succeeded > 0) {
      toast(`${result.succeeded} certificate${result.succeeded !== 1 ? 's' : ''} updated`, 'success');
    }
    if (result.failed > 0) {
      toast(`${result.failed} failed: ${result.errors.map((e) => e.error).join(', ')}`, 'error');
    }
    loadCertificates();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function initBulkActions() {
  $('#bulk-renew-btn').addEventListener('click', () => {
    executeBulkAction('renew', `Renew ${getSelectedIds().length} selected certificate(s)?`);
  });
  $('#bulk-revoke-btn').addEventListener('click', () => {
    executeBulkAction('revoke', `Revoke ${getSelectedIds().length} selected certificate(s)? They will be marked as revoked but kept in the list.`);
  });
  $('#bulk-remove-btn').addEventListener('click', () => {
    executeBulkAction('remove', `Remove ${getSelectedIds().length} selected certificate(s) from tracking? They will not be revoked.`);
  });
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
        if (await confirmModal('A revoked certificate exists for these domains. Replace it with a new one?', { title: 'Certificate Exists', okLabel: 'Replace' })) {
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

export async function loadNewCert() {
  await refreshTlsState();
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
