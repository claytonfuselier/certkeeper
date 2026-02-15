/* =============================================
   CertKeeper — Frontend App (Vanilla JS)
   ============================================= */

(function () {
  'use strict';

  // ---------- Helpers ----------

  async function api(method, url, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      Object.assign(err, data); // attach full response (e.g. revoked flag)
      throw err;
    }
    return data;
  }

  function $(sel, ctx = document) { return ctx.querySelector(sel); }
  function $$(sel, ctx = document) { return [...ctx.querySelectorAll(sel)]; }

  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  function toast(msg, type = 'info') {
    const container = $('#toast-container');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function formatDate(str) {
    if (!str) return '—';
    const d = new Date(str);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function statusBadge(status, staging) {
    const stagingTag = staging ? ' <span class="badge badge-staging">staging</span>' : '';
    return `<span class="badge badge-${status}">${status}</span>${stagingTag}`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  /**
   * Parse an error_message field which may be JSON (structured) or plain text (legacy).
   * Returns { title, detail, link }.
   */
  function parseErrorMessage(raw) {
    if (!raw) return { title: 'Unknown error', detail: 'No details available.', link: '' };
    try {
      const obj = JSON.parse(raw);
      if (obj.title) return { title: obj.title, detail: obj.detail || '', link: obj.link || '' };
    } catch { /* not JSON — treat as legacy plain text */ }
    return { title: 'Certificate operation failed', detail: raw, link: 'https://community.letsencrypt.org/' };
  }

  function challengeBadge(type) {
    const cls = type === 'dns-01' ? 'dns' : 'http';
    return `<span class="badge badge-${cls}">${type}</span>`;
  }

  // ---------- Auth ----------

  async function checkAuth() {
    try {
      const data = await api('GET', '/api/auth/me');
      if (data.user) return data.user;
    } catch { /* not logged in */ }
    return null;
  }

  async function login(username, password) {
    return api('POST', '/api/auth/login', { username, password });
  }

  async function logout() {
    await api('POST', '/api/auth/logout');
  }

  // ---------- Cloudflare Token State ----------

  let _hasCloudflareToken = false;
  let _cloudflareSource = 'none'; // 'env' | 'database' | 'none'
  let _credentialsSource = 'database'; // 'env' | 'database'

  function updateDns01State() {
    const select = $('#cert-challenge');
    const warning = $('#dns01-no-token');
    if (!select || !warning) return;

    const dns01Option = select.querySelector('option[value="dns-01"]');
    if (!_hasCloudflareToken) {
      // Disable DNS-01 and show warning
      dns01Option.disabled = true;
      if (select.value === 'dns-01') select.value = 'http-01';
      show(warning);
    } else {
      dns01Option.disabled = false;
      select.value = 'dns-01';
      hide(warning);
    }
  }

  // ---------- Navigation ----------

  let currentPage = 'dashboard';

  function navigate(page) {
    currentPage = page;
    $$('.page').forEach(hide);
    show($(`#page-${page}`));
    $$('.nav-link').forEach((el) => {
      el.classList.toggle('active', el.dataset.page === page);
    });
    // Stop cert polling when leaving the certificates page
    if (page !== 'certificates') stopPolling();
    // Load data for the page
    if (page === 'dashboard') loadDashboard();
    if (page === 'certificates') loadCertificates();
    if (page === 'new-cert') updateDns01State();
    if (page === 'settings') loadSettings();
  }

  // ---------- Dashboard ----------

  async function loadDashboard() {
    try {
      const data = await api('GET', '/api/dashboard');
      $('#stat-total').textContent = data.total;
      $('#stat-active').textContent = data.active;
      $('#stat-expiring').textContent = data.expiring;
      $('#stat-errors').textContent = data.errors;

      // Keep cloudflare token state in sync
      _hasCloudflareToken = data.hasCloudflareToken;
      if (data.cloudflareSource) _cloudflareSource = data.cloudflareSource;
      updateDns01State();

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

  // ---------- Certificates ----------

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
      if (currentPage !== 'certificates') return; // stop if user navigated away
      await loadCertificates();
    }, 3000);
  }

  async function loadCertificates() {
    try {
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

      for (const cert of certs) {
        const inProgress = cert.status === 'issuing' || cert.status === 'renewing';
        if (inProgress) hasInProgress = true;

        const canRenew = cert.status === 'active' || cert.status === 'expired';
        const canRetry = cert.status === 'error';
        const canRevoke = cert.certbot_name && !['issuing', 'renewing', 'revoked'].includes(cert.status);
        const canRemove = !['issuing', 'renewing'].includes(cert.status);
        const isRevoked = cert.status === 'revoked';
        const hasError = cert.status === 'error' && cert.error_message;

        const tr = document.createElement('tr');
        if (hasError) tr.classList.add('cert-error-row');
        tr.innerHTML = `
          <td>${cert.domains.map((d) => `<code>${d}</code>`).join(' ')}</td>
          <td>${challengeBadge(cert.challenge_type)}</td>
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
            ${canRetry ? `<button class="btn btn-sm btn-secondary retry-btn" data-id="${cert.id}" data-domains="${encodeURIComponent(JSON.stringify(cert.domains))}" data-challenge="${cert.challenge_type}">Retry</button>` : ''}
            ${isRevoked ? `<button class="btn btn-sm btn-secondary reissue-btn" data-id="${cert.id}" data-domains="${encodeURIComponent(JSON.stringify(cert.domains))}" data-challenge="${cert.challenge_type}">Reissue</button>` : ''}
            ${canRevoke ? `<button class="btn btn-sm btn-danger revoke-btn" data-id="${cert.id}">Revoke</button>` : ''}
            ${canRemove ? `<button class="btn btn-sm ${isRevoked || !canRevoke ? 'btn-danger' : 'btn-muted'} remove-btn" data-id="${cert.id}" title="Remove from tracking${canRevoke ? ' without revoking' : ''}">Remove</button>` : ''}
          </td>
        `;
        tbody.appendChild(tr);

        // Expandable error detail row
        if (hasError) {
          const errInfo = parseErrorMessage(cert.error_message);
          const errTr = document.createElement('tr');
          errTr.classList.add('cert-error-detail');
          errTr.innerHTML = `
            <td colspan="6">
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
            loadCertificates(); // refresh to show 'renewing' badge + start polling
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
            const challengeType = btn.dataset.challenge;
            // Remove the errored entry first, then re-request
            await api('DELETE', `/api/certs/${btn.dataset.id}?action=remove`);
            await api('POST', '/api/certs', { domains, challengeType });
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
            const challengeType = btn.dataset.challenge;
            await api('POST', '/api/certs', { domains, challengeType, overrideRevoked: true });
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

  function initNewCertForm() {
    const form = $('#new-cert-form');
    const domainsInput = $('#cert-domains');
    const challengeSelect = $('#cert-challenge');
    const errorEl = $('#cert-form-error');
    const successEl = $('#cert-form-success');
    const submitBtn = $('#cert-submit-btn');

    // Auto-switch to dns-01 if wildcard detected (only if token is available)
    domainsInput.addEventListener('input', () => {
      const val = domainsInput.value;
      if (val.includes('*') && _hasCloudflareToken) {
        challengeSelect.value = 'dns-01';
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hide(errorEl);
      hide(successEl);

      const raw = domainsInput.value.trim();
      if (!raw) return;

      const domains = raw.split(',').map((d) => d.trim()).filter(Boolean);
      const challengeType = challengeSelect.value;

      // Validate wildcards
      if (domains.some((d) => d.startsWith('*.')) && challengeType !== 'dns-01') {
        errorEl.textContent = 'Wildcard domains require DNS-01 challenge type.';
        show(errorEl);
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting…';

      try {
        await api('POST', '/api/certs', { domains, challengeType });
        form.reset();
        toast('Certificate request submitted — issuing in background…', 'info');
        navigate('certificates'); // navigate to cert list which will poll
      } catch (err) {
        // If a revoked cert exists, offer to override
        if (err.revoked) {
          if (confirm('A revoked certificate exists for these domains. Replace it with a new one?')) {
            try {
              await api('POST', '/api/certs', { domains, challengeType, overrideRevoked: true });
              form.reset();
              toast('Certificate request submitted — issuing in background…', 'info');
              navigate('certificates');
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

  // ---------- Settings ----------

  function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
  }

  function initSettingsTabs() {
    $$('.settings-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('.settings-tab').forEach((t) => t.classList.remove('active'));
        $$('.settings-pane').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        const pane = $(`#settings-${tab.dataset.settingsTab}`);
        if (pane) pane.classList.add('active');
      });
    });
  }

  async function loadSettings() {
    try {
      const data = await api('GET', '/api/settings');

      // ---- Status pane ----
      const srv = data.server || {};
      $('#st-node').textContent = srv.nodeVersion || '—';
      $('#st-platform').textContent = srv.platform && srv.arch ? `${srv.platform} / ${srv.arch}` : '—';
      $('#st-uptime').textContent = srv.uptime ? formatUptime(srv.uptime) : '—';
      $('#st-port').textContent = srv.port || '—';

      const tlsSource = data.tls?.source || 'self-signed';
      $('#st-tls').innerHTML = data.tls?.httpMode
        ? '<span class="badge badge-expired">Disabled (HTTP mode)</span>'
        : tlsSource === 'custom'
          ? '<span class="badge badge-active">Custom / Managed</span>'
          : '<span class="badge badge-pending">Self-signed</span>';

      $('#st-staging').innerHTML = data.staging
        ? '<span class="badge badge-pending">Yes</span>'
        : '<span class="badge badge-active">No</span>';

      const credSrc = data.credentials?.source || 'database';
      $('#st-creds').textContent = credSrc === 'env' ? 'Environment variable' : 'Database (UI)';

      const cfHas = data.cloudflare?.hasToken;
      const cfSrc = data.cloudflare?.source || 'none';
      if (cfHas) {
        const label = cfSrc === 'env' ? 'env' : 'database';
        $('#st-cf').innerHTML = `<span class="badge badge-active">Set</span> <span style="color:var(--text-muted);font-size:.8rem">(${label})</span>`;
      } else {
        $('#st-cf').innerHTML = '<span class="badge badge-expired">Not set</span>';
      }

      const emailVal = data.email?.value || '';
      const emailSrc = data.email?.source || 'none';
      if (emailVal) {
        const label = emailSrc === 'env' ? 'env' : 'database';
        $('#st-email').innerHTML = `${emailVal} <span style="color:var(--text-muted);font-size:.8rem">(${label})</span>`;
      } else {
        $('#st-email').innerHTML = '<span class="badge badge-expired">Not set</span>';
      }

      const schedInfo = data.schedule;
      $('#st-schedule').textContent = schedInfo?.display || '—';

      $('#st-certs-total').textContent = data.certs?.total ?? '—';
      $('#st-certs-active').textContent = data.certs?.active ?? '—';

      // ---- Cloudflare token pane ----
      _hasCloudflareToken = data.cloudflare.hasToken;
      _cloudflareSource = data.cloudflare.source;
      const statusEl = $('#cf-token-status');
      const cfTokenInput = $('#cf-token');
      const cfSubmitBtn = $('#cf-token-form button[type="submit"]');
      const isFromEnv = data.cloudflare.source === 'env';

      if (data.cloudflare.hasToken) {
        const sourceLabel = isFromEnv ? 'environment variable' : 'database (UI)';
        statusEl.innerHTML = `<span class="badge badge-active">Configured</span> <span style="color:var(--text-muted);font-size:.85rem">Source: ${sourceLabel} &nbsp;·&nbsp; ${data.cloudflare.maskedToken}</span>`;
      } else {
        statusEl.innerHTML = '<span class="badge badge-expired">Not configured</span> <span style="color:var(--text-muted);font-size:.85rem">DNS-01 challenges will be unavailable</span>';
      }

      if (isFromEnv) {
        cfTokenInput.disabled = true;
        cfTokenInput.placeholder = 'Managed via environment variable';
        cfSubmitBtn.disabled = true;
        cfSubmitBtn.textContent = 'Set via .env';
      } else {
        cfTokenInput.disabled = false;
        cfTokenInput.placeholder = 'Enter Cloudflare API token';
        cfSubmitBtn.disabled = false;
        cfSubmitBtn.textContent = 'Save Token';
      }

      // ---- Email pane ----
      const emailSource = data.email?.source || 'none';
      const emailValue = data.email?.value || '';
      const emailStatusEl = $('#email-status');
      const emailInput = $('#setting-email-input');
      const emailEnvNotice = $('#email-env-notice');
      const emailSubmitBtn = $('#email-form button[type="submit"]');

      if (emailValue) {
        const sourceLabel = emailSource === 'env' ? 'environment variable' : 'database (UI)';
        emailStatusEl.innerHTML = `<span class="badge badge-active">Set</span> <span style="color:var(--text-muted);font-size:.85rem">${emailValue} &nbsp;·&nbsp; Source: ${sourceLabel}</span>`;
      } else {
        emailStatusEl.innerHTML = '<span class="badge badge-expired">Not set</span> <span style="color:var(--text-muted);font-size:.85rem">Certificates will be registered without email</span>';
      }

      if (emailSource === 'env') {
        show(emailEnvNotice);
        emailInput.disabled = true;
        emailInput.placeholder = 'Managed via environment variable';
        emailSubmitBtn.disabled = true;
        emailSubmitBtn.textContent = 'Set via .env';
      } else {
        hide(emailEnvNotice);
        emailInput.disabled = false;
        emailInput.placeholder = 'you@example.com';
        emailInput.value = emailValue;
        emailSubmitBtn.disabled = false;
        emailSubmitBtn.textContent = 'Save Email';
      }

      // ---- Password pane ----
      _credentialsSource = data.credentials?.source || 'database';
      const pwEnvNotice = $('#pw-env-notice');
      const pwCurrentInput = $('#current-pw');
      const pwNewInput = $('#new-pw');
      const pwSubmitBtn = $('#password-form button[type="submit"]');

      if (_credentialsSource === 'env') {
        show(pwEnvNotice);
        pwCurrentInput.disabled = true;
        pwNewInput.disabled = true;
        pwSubmitBtn.disabled = true;
        pwSubmitBtn.textContent = 'Set via .env';
      } else {
        hide(pwEnvNotice);
        pwCurrentInput.disabled = false;
        pwNewInput.disabled = false;
        pwSubmitBtn.disabled = false;
        pwSubmitBtn.textContent = 'Update Password';
      }

      updateDns01State();

      // ---- TLS pane ----
      const tlsStatusEl = $('#tls-status');
      const tlsHttpMode = data.tls?.httpMode;
      if (tlsHttpMode) {
        tlsStatusEl.innerHTML = '<span class="badge badge-expired">Disabled</span> <span style="color:var(--text-muted);font-size:.85rem">TLS is disabled (USE_HTTP=true) — the server is running plain HTTP</span>';
        // Disable all TLS controls
        const tlsPane = $('#pane-tls');
        tlsPane.querySelectorAll('select, button, textarea').forEach(el => { el.disabled = true; });
        hide($('#tls-managed-section'));
        hide($('#tls-custom-section'));
      } else if (tlsSource === 'custom') {
        tlsStatusEl.innerHTML = '<span class="badge badge-active">Custom</span> <span style="color:var(--text-muted);font-size:.85rem">Using a custom or managed certificate</span>';
      } else {
        tlsStatusEl.innerHTML = '<span class="badge badge-pending">Self-signed</span> <span style="color:var(--text-muted);font-size:.85rem">Auto-generated certificate (browser warning expected)</span>';
      }
      const tlsModeSelect = $('#tls-mode');
      if (!tlsHttpMode) {
        tlsModeSelect.value = tlsSource === 'custom' ? 'custom' : 'self-signed';
        updateTlsSections();
      }

      // ---- Schedule pane ----
      const schedStatusEl = $('#sched-status');
      const schedEnvNotice = $('#sched-env-notice');
      const schedForm = $('#schedule-form');
      const schedSubmitBtn = schedForm.querySelector('button[type="submit"]');

      schedStatusEl.innerHTML = `<span class="badge badge-active">Active</span> <span style="color:var(--text-muted);font-size:.85rem">${schedInfo.display}</span>`;

      if (schedInfo.fromEnv) {
        show(schedEnvNotice);
        schedForm.querySelectorAll('select, input, button').forEach((el) => { el.disabled = true; });
        schedSubmitBtn.textContent = 'Set via .env';
      } else {
        hide(schedEnvNotice);
        schedForm.querySelectorAll('select, input, button').forEach((el) => { el.disabled = false; });
        schedSubmitBtn.textContent = 'Save Schedule';

        if (schedInfo.schedule) {
          const s = schedInfo.schedule;
          const pad = (n) => String(n).padStart(2, '0');
          $('#sched-day1').value = String(s.day1);
          $('#sched-time1').value = `${pad(s.hour1)}:${pad(s.min1)}`;
          $('#sched-day2').value = String(s.day2);
          $('#sched-time2').value = `${pad(s.hour2)}:${pad(s.min2)}`;
        }
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function initCloudflareTokenForm() {
    const form = $('#cf-token-form');
    const errorEl = $('#cf-error');
    const successEl = $('#cf-success');
    const submitBtn = form.querySelector('button[type="submit"]');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hide(errorEl);
      hide(successEl);

      const apiToken = $('#cf-token').value;
      const saving = apiToken.trim() !== '';

      submitBtn.disabled = true;
      submitBtn.textContent = saving ? 'Validating…' : 'Clearing…';

      try {
        const data = await api('PUT', '/api/settings/cloudflare', { apiToken });
        _hasCloudflareToken = data.cloudflare.hasToken;
        successEl.textContent = saving ? 'Token validated and saved.' : 'Token cleared.';
        show(successEl);
        form.reset();
        toast(saving ? 'Cloudflare token saved' : 'Cloudflare token cleared', 'success');
        loadSettings();
      } catch (err) {
        errorEl.textContent = err.message;
        show(errorEl);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save Token';
      }
    });
  }

  function initPasswordForm() {
    const form = $('#password-form');
    const errorEl = $('#pw-error');
    const successEl = $('#pw-success');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hide(errorEl);
      hide(successEl);

      const currentPassword = $('#current-pw').value;
      const newPassword = $('#new-pw').value;

      try {
        await api('POST', '/api/auth/password', { currentPassword, newPassword });
        successEl.textContent = 'Password updated.';
        show(successEl);
        form.reset();
        toast('Password updated', 'success');
      } catch (err) {
        errorEl.textContent = err.message;
        show(errorEl);
      }
    });
  }

  function initEmailForm() {
    const form = $('#email-form');
    const errorEl = $('#email-error');
    const successEl = $('#email-success');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hide(errorEl);
      hide(successEl);

      const email = $('#setting-email-input').value;

      try {
        const data = await api('PUT', '/api/settings/email', { email });
        successEl.textContent = 'Email saved.';
        show(successEl);
        toast('Registration email saved', 'success');
        loadSettings();
      } catch (err) {
        errorEl.textContent = err.message;
        show(errorEl);
      }
    });
  }

  // ---------- TLS Settings ----------

  function initScheduleForm() {
    const form = $('#schedule-form');
    const errorEl = $('#sched-error');
    const successEl = $('#sched-success');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hide(errorEl);
      hide(successEl);

      const day1 = parseInt($('#sched-day1').value, 10);
      const day2 = parseInt($('#sched-day2').value, 10);
      const [h1, m1] = $('#sched-time1').value.split(':').map(Number);
      const [h2, m2] = $('#sched-time2').value.split(':').map(Number);

      if (day1 === day2) {
        errorEl.textContent = 'The two days must be different.';
        show(errorEl);
        return;
      }

      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';

      try {
        await api('PUT', '/api/settings/schedule', {
          day1, hour1: h1, min1: m1,
          day2, hour2: h2, min2: m2,
        });
        successEl.textContent = 'Schedule updated.';
        show(successEl);
        toast('Renewal schedule updated', 'success');
        loadSettings();
      } catch (err) {
        errorEl.textContent = err.message;
        show(errorEl);
      }

      submitBtn.disabled = false;
      submitBtn.textContent = 'Save Schedule';
    });
  }

  function updateTlsSections() {
    const mode = $('#tls-mode').value;
    const managedSection = $('#tls-managed-section');
    const customSection = $('#tls-custom-section');

    if (mode === 'managed') {
      show(managedSection);
      hide(customSection);
      loadManagedCerts();
    } else if (mode === 'custom') {
      hide(managedSection);
      show(customSection);
    } else {
      hide(managedSection);
      hide(customSection);
    }
  }

  async function loadManagedCerts() {
    const select = $('#tls-managed-domain');
    try {
      const certs = await api('GET', '/api/settings/tls/managed');
      select.innerHTML = '';
      if (certs.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No active certificates available';
        opt.disabled = true;
        select.appendChild(opt);
        return;
      }
      for (const cert of certs) {
        const opt = document.createElement('option');
        opt.value = cert.domains[0];
        opt.textContent = cert.domains.join(', ');
        select.appendChild(opt);
      }
    } catch {
      select.innerHTML = '<option value="" disabled>Failed to load certificates</option>';
    }
  }

  function initTlsSettings() {
    const modeSelect = $('#tls-mode');
    const saveBtn = $('#tls-save-btn');
    const errorEl = $('#tls-error');
    const successEl = $('#tls-success');
    const restartNotice = $('#tls-restart-notice');

    modeSelect.addEventListener('change', updateTlsSections);

    saveBtn.addEventListener('click', async () => {
      hide(errorEl);
      hide(successEl);
      hide(restartNotice);

      const mode = modeSelect.value;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Applying…';

      try {
        let body;
        if (mode === 'self-signed') {
          body = { action: 'reset' };
        } else if (mode === 'managed') {
          const domain = $('#tls-managed-domain').value;
          if (!domain) throw new Error('Select a certificate.');
          body = { managedDomain: domain };
        } else {
          const certPem = $('#tls-cert-pem').value.trim();
          const keyPem = $('#tls-key-pem').value.trim();
          if (!certPem || !keyPem) throw new Error('Both certificate and private key are required.');
          body = { certPem, keyPem };
        }

        const data = await api('PUT', '/api/settings/tls', body);
        successEl.textContent = 'TLS certificate updated.';
        show(successEl);
        toast('TLS certificate updated', 'success');

        if (data.restart) {
          show(restartNotice);
        }

        loadSettings();
      } catch (err) {
        errorEl.textContent = err.message;
        show(errorEl);
      }

      saveBtn.disabled = false;
      saveBtn.textContent = 'Apply';
    });
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

  // ---------- Boot ----------

  async function init() {
    let user = null;
    let needsSetup = false;
    let setupEmailFromEnv = false;
    let setupEmailValue = '';

    try {
      const data = await api('GET', '/api/auth/me');
      if (data.user) user = data.user;
    } catch (err) {
      // Check the raw response for needsSetup
      try {
        const res = await fetch('/api/auth/me');
        const data = await res.json();
        if (data.needsSetup) {
          needsSetup = true;
          setupEmailFromEnv = !!data.emailFromEnv;
          setupEmailValue = data.emailValue || '';
        }
      } catch { /* ignore */ }
    }

    if (user) {
      hide($('#login-screen'));
      hide($('#setup-screen'));
      show($('#main-screen'));
      $('#current-user').textContent = user.username;
      navigate('dashboard');
    } else if (needsSetup) {
      hide($('#login-screen'));
      hide($('#main-screen'));
      show($('#setup-screen'));

      // If email is from .env, pre-fill and lock the field
      const setupEmailInput = $('#setup-email');
      if (setupEmailFromEnv) {
        setupEmailInput.value = setupEmailValue;
        setupEmailInput.disabled = true;
        setupEmailInput.placeholder = 'Managed via environment variable';
        // Remove required so the disabled field doesn't block submit
        setupEmailInput.removeAttribute('required');
      }
    } else {
      show($('#login-screen'));
      hide($('#setup-screen'));
      hide($('#main-screen'));
    }

    // Setup form
    $('#setup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = $('#setup-error');
      hide(errorEl);

      const username = $('#setup-username').value.trim();
      const password = $('#setup-password').value;
      const confirm = $('#setup-password-confirm').value;
      const email = $('#setup-email').value.trim();

      if (password !== confirm) {
        errorEl.textContent = 'Passwords do not match.';
        show(errorEl);
        return;
      }

      try {
        const data = await api('POST', '/api/auth/setup', { username, password, email });
        hide($('#setup-screen'));
        show($('#main-screen'));
        $('#current-user').textContent = data.user.username;
        toast('Account created! Welcome.', 'success');
        navigate('dashboard');
      } catch (err) {
        errorEl.textContent = err.message;
        show(errorEl);
      }
    });

    // Login form
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = $('#login-error');
      hide(errorEl);

      const username = $('#username').value;
      const password = $('#password').value;

      try {
        const data = await login(username, password);
        hide($('#login-screen'));
        show($('#main-screen'));
        $('#current-user').textContent = data.user.username;
        navigate('dashboard');
      } catch (err) {
        errorEl.textContent = err.message;
        show(errorEl);
      }
    });

    // Logout
    $('#logout-btn').addEventListener('click', async () => {
      await logout();
      show($('#login-screen'));
      hide($('#main-screen'));
      hide($('#setup-screen'));
      toast('Logged out', 'info');
    });

    // Nav links
    $$('.nav-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        navigate(link.dataset.page);
      });
    });

    // "Go to" links
    $$('[data-goto]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        navigate(el.dataset.goto);
      });
    });

    initNewCertForm();
    initPasswordForm();
    initEmailForm();
    initCloudflareTokenForm();
    initScheduleForm();
    initTlsSettings();
    initSettingsTabs();
    initSyncButton();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
