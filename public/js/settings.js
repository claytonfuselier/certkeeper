/* =============================================
   CertKeeper — Settings Page
   ============================================= */

import { $, $$, show, hide, toast, formatUptime, escapeHtml } from './dom.js';
import { api } from './api.js';
import {
  setCloudflareToken, setCloudflareSource, setCredentialsSource,
  setTlsSource, setAgentCount, setServiceCertId,
  hasCloudflareToken, agentCount,
} from './state.js';

// ---------- Lifecycle ----------

export function init() {
  initSettingsTabs();
  initCloudflareTokenForm();
  initPasswordForm();
  initEmailForm();
  initScheduleForm();
  initTlsSettings();
  initAgentSettingsForm();
}

export function load(params) {
  loadSettings();

  // If a tab is specified in the route (e.g. /settings/tls), activate that tab
  if (params && params.tab) {
    activateSettingsTab(params.tab);
  }
}

// ---------- Tab Navigation ----------

function activateSettingsTab(tabName) {
  $$('.settings-tab[data-settings-tab]').forEach((t) => t.classList.remove('active'));
  $$('#page-settings .settings-pane').forEach((p) => p.classList.remove('active'));
  const tab = $(`.settings-tab[data-settings-tab="${tabName}"]`);
  if (tab) tab.classList.add('active');
  const pane = $(`#settings-${tabName}`);
  if (pane) pane.classList.add('active');
}

function initSettingsTabs() {
  $$('.settings-tab[data-settings-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      activateSettingsTab(tab.dataset.settingsTab);
    });
  });
}

// ---------- Load Settings ----------

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
    setTlsSource(tlsSource);
    setAgentCount(data.agents?.count || 0);
    setServiceCertId(data.tls?.serviceCertId || null);

    $('#st-tls').innerHTML = tlsSource === 'custom'
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
      $('#st-email').innerHTML = `${escapeHtml(emailVal)} <span style="color:var(--text-muted);font-size:.8rem">(${label})</span>`;
    } else {
      $('#st-email').innerHTML = '<span class="badge badge-expired">Not set</span>';
    }

    const schedInfo = data.schedule;
    $('#st-schedule').textContent = schedInfo?.display || '—';

    $('#st-certs-total').textContent = data.certs?.total ?? '—';
    $('#st-certs-active').textContent = data.certs?.active ?? '—';

    // ---- Cloudflare token pane ----
    setCloudflareToken(data.cloudflare.hasToken);
    setCloudflareSource(data.cloudflare.source);
    const statusEl = $('#cf-token-status');
    const cfTokenInput = $('#cf-token');
    const cfSubmitBtn = $('#cf-token-form button[type="submit"]');
    const isFromEnv = data.cloudflare.source === 'env';

    if (data.cloudflare.hasToken) {
      const sourceLabel = isFromEnv ? 'environment variable' : 'database (UI)';
      statusEl.innerHTML = `<span class="badge badge-active">Configured</span> <span style="color:var(--text-muted);font-size:.85rem">Source: ${sourceLabel} &nbsp;·&nbsp; ${escapeHtml(data.cloudflare.maskedToken)}</span>`;
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
      emailStatusEl.innerHTML = `<span class="badge badge-active">Set</span> <span style="color:var(--text-muted);font-size:.85rem">${escapeHtml(emailValue)} &nbsp;·&nbsp; Source: ${sourceLabel}</span>`;
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
    setCredentialsSource(data.credentials?.source || 'database');
    const credSource = data.credentials?.source || 'database';
    const pwEnvNotice = $('#pw-env-notice');
    const pwCurrentInput = $('#current-pw');
    const pwNewInput = $('#new-pw');
    const pwSubmitBtn = $('#password-form button[type="submit"]');

    if (credSource === 'env') {
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

    // ---- TLS pane ----
    const tlsStatusEl = $('#tls-status');
    if (tlsSource === 'custom') {
      tlsStatusEl.innerHTML = '<span class="badge badge-active">Custom</span> <span style="color:var(--text-muted);font-size:.85rem">Using a custom or managed certificate</span>';
    } else {
      tlsStatusEl.innerHTML = '<span class="badge badge-pending">Self-signed</span> <span style="color:var(--text-muted);font-size:.85rem">Auto-generated certificate (browser warning expected)</span>';
    }
    const tlsModeSelect = $('#tls-mode');
    tlsModeSelect.value = tlsSource === 'custom' ? 'custom' : 'self-signed';

    // Disable switching to self-signed when agents exist
    const selfSignedOpt = tlsModeSelect.querySelector('option[value="self-signed"]');
    const selfSignedWarning = $('#tls-selfsigned-warning');
    if (agentCount() > 0) {
      selfSignedOpt.disabled = true;
      selfSignedOpt.textContent = 'Self-signed (unavailable — agents exist)';
      show(selfSignedWarning);
    } else {
      selfSignedOpt.disabled = false;
      selfSignedOpt.textContent = 'Self-signed (default)';
      hide(selfSignedWarning);
    }

    updateTlsSections();

    // ---- Schedule pane ----
    const schedStatusEl = $('#sched-status');
    const schedEnvNotice = $('#sched-env-notice');
    const schedForm = $('#schedule-form');
    const schedSubmitBtn = schedForm.querySelector('button[type="submit"]');

    schedStatusEl.innerHTML = `<span class="badge badge-active">Active</span> <span style="color:var(--text-muted);font-size:.85rem">${escapeHtml(schedInfo.display)}</span>`;

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

    // ---- Agent monitoring pane ----
    loadAgentSettings();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- Cloudflare Token Form ----------

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
      setCloudflareToken(data.cloudflare.hasToken);
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

// ---------- Email Form ----------

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
      await api('PUT', '/api/settings/email', { email });
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

// ---------- Password Form ----------

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

// ---------- Schedule Form ----------

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

// ---------- TLS Settings ----------

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

  modeSelect.addEventListener('change', updateTlsSections);

  saveBtn.addEventListener('click', async () => {
    hide(errorEl);
    hide(successEl);

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

      loadSettings();
    } catch (err) {
      errorEl.textContent = err.message;
      show(errorEl);
    }

    saveBtn.disabled = false;
    saveBtn.textContent = 'Apply';
  });
}

// ---------- Agent Settings ----------

async function loadAgentSettings() {
  try {
    const data = await api('GET', '/api/settings/agents');
    const intervalMinutes = Math.round(data.heartbeat_interval / 60);
    $('#agent-heartbeat-interval').value = intervalMinutes;
    $('#agent-offline-threshold').value = data.offline_threshold;
    updateAgentSettingsCalc();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function updateAgentSettingsCalc() {
  const interval = parseInt($('#agent-heartbeat-interval').value, 10) || 3;
  const threshold = parseInt($('#agent-offline-threshold').value, 10) || 3;
  const totalMin = interval * threshold;
  $('#agent-settings-calc').textContent = `Agents will be flagged as offline after ${totalMin} minute${totalMin !== 1 ? 's' : ''} of silence (${interval} min × ${threshold} missed).`;
}

function initAgentSettingsForm() {
  const form = $('#agent-settings-form');
  const errorEl = $('#agent-settings-error');
  const successEl = $('#agent-settings-success');

  $('#agent-heartbeat-interval').addEventListener('input', updateAgentSettingsCalc);
  $('#agent-offline-threshold').addEventListener('input', updateAgentSettingsCalc);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hide(errorEl);
    hide(successEl);

    const heartbeat_interval_minutes = parseInt($('#agent-heartbeat-interval').value, 10);
    const offline_threshold = parseInt($('#agent-offline-threshold').value, 10);

    if (!heartbeat_interval_minutes || heartbeat_interval_minutes < 1) {
      errorEl.textContent = 'Heartbeat interval must be at least 1 minute.';
      show(errorEl);
      return;
    }
    if (!offline_threshold || offline_threshold < 1) {
      errorEl.textContent = 'Offline threshold must be at least 1.';
      show(errorEl);
      return;
    }

    try {
      await api('PUT', '/api/settings/agents', { heartbeat_interval_minutes, offline_threshold });
      successEl.textContent = 'Agent monitoring settings saved. Agents will pick up the new interval on their next heartbeat.';
      show(successEl);
      toast('Agent settings saved', 'success');
    } catch (err) {
      errorEl.textContent = err.message;
      show(errorEl);
    }
  });
}
