/* =============================================
   CertKeeper — Agents Page
   ============================================= */

import { $, $$, show, hide, toast, formatDate, formatDateTime, statusBadge, escapeHtml, confirmModal } from './dom.js';
import { api } from './api.js';
import { refreshTlsState, tlsSource, serviceCertId } from './state.js';

// ---------- State ----------

// Track which agent rows are expanded to show deployments
const expandedAgents = new Set();

// ---------- Lifecycle ----------

export function init() {
  initAgents();
}

export function load() {
  loadAgents();
}

export function leave() {
  // cleanup placeholder — add polling/timer cleanup here if needed
}

// ---------- Load Agents ----------

async function loadAgents() {
  try {
    await refreshTlsState();
    const agents = await api('GET', '/api/agents');
    const tbody = $('#agents-table tbody');
    const empty = $('#agents-empty');
    const newAgentBtn = $('#new-agent-btn');
    const tlsWarning = $('#agents-tls-warning');
    tbody.innerHTML = '';

    // Disable agent creation when server TLS is self-signed
    if (tlsSource() === 'self-signed') {
      newAgentBtn.disabled = true;
      newAgentBtn.title = 'Agent creation requires a managed or custom TLS certificate';
      show(tlsWarning);
    } else {
      newAgentBtn.disabled = false;
      newAgentBtn.title = '';
      hide(tlsWarning);
    }

    if (agents.length === 0) {
      show(empty);
      hide($('#agents-table'));
      return;
    }
    hide(empty);
    show($('#agents-table'));

    for (const agent of agents) {
      const depCount = agent.deployments.length;
      const depLabel = depCount === 1 ? '1 deployment' : `${depCount} deployments`;
      const isExpanded = expandedAgents.has(agent.id);

      const lastContact = agent.last_contact_at
        ? `${formatDate(agent.last_contact_at)}${agent.last_contact_ip ? ` <span style="color:var(--text-muted);font-size:.8rem">(${escapeHtml(agent.last_contact_ip)})</span>` : ''}`
        : '<span style="color:var(--text-muted)">never</span>';

      // Enrollment status column
      let enrollCol = '';
      if (agent.enrolled) {
        const fpShort = agent.cert_fingerprint_short || '?';
        const certExp = agent.cert_expires_at ? formatDate(agent.cert_expires_at) : '—';
        enrollCol = `<span class="badge badge-active">enrolled</span> <span style="font-size:.75rem;color:var(--text-muted)" title="Cert fingerprint: ${escapeHtml(fpShort)}…\nExpires: ${escapeHtml(certExp)}">✓</span>`;
      } else if (agent.has_enrollment_token && !agent.enrollment_token_expired) {
        enrollCol = `<span class="badge badge-staging">pending</span> <span style="font-size:.75rem;color:var(--warning)">⏳ awaiting enrollment</span>`;
      } else {
        enrollCol = `<span class="badge badge-expired">not enrolled</span>`;
      }

      // Status column — combines enabled state + heartbeat liveness + config version
      let statusCol = '';
      if (!agent.enabled) {
        statusCol = '<span class="badge badge-expired">disabled</span>';
      } else if (!agent.enrolled) {
        statusCol = '<span class="badge" style="background:var(--text-muted);color:#fff">unknown</span>';
      } else if (agent.status === 'online' && agent.config_current) {
        statusCol = '<span class="badge badge-active">online</span>';
      } else if (agent.status === 'online' && !agent.config_current) {
        statusCol = '<span class="badge" style="background:#3b82f6;color:#fff" title="Online but hasn\'t picked up latest config yet">online</span>';
      } else if (agent.status === 'offline') {
        statusCol = '<span class="badge badge-error">offline</span>';
      } else {
        statusCol = '<span class="badge" style="background:var(--text-muted);color:#fff">unknown</span>';
      }

      // Pending actions indicator
      if (agent.pending_actions && agent.pending_actions.length > 0) {
        statusCol += ` <span style="font-size:.75rem;color:var(--warning)" title="Pending: ${escapeHtml(agent.pending_actions.join(', '))}">⏳</span>`;
      }

      // Agent row
      const tr = document.createElement('tr');
      tr.className = 'agent-row';
      tr.innerHTML = `
        <td class="agent-expand-cell" style="cursor:pointer;text-align:center;user-select:none" data-id="${agent.id}">${isExpanded ? '▼' : '▶'}</td>
        <td>${escapeHtml(agent.name)}</td>
        <td>${enrollCol}</td>
        <td>${depCount > 0 ? depLabel : '<span style="color:var(--text-muted)">none</span>'}</td>
        <td>${lastContact}</td>
        <td>${statusCol}</td>
        <td>
          <button class="btn btn-sm btn-secondary agent-edit-btn" data-id="${agent.id}">Edit</button>
          <button class="btn btn-sm btn-secondary agent-regen-btn" data-id="${agent.id}" title="Reset enrollment — generates a new enrollment token">🔄 Re-enroll</button>
          ${agent.enrolled ? `<button class="btn btn-sm btn-secondary agent-renew-cert-btn" data-id="${agent.id}" title="Force the agent to renew its authentication certificate on next heartbeat">🔑 Renew Cert</button>` : ''}
          <button class="btn btn-sm ${agent.enabled ? 'btn-muted' : 'btn-secondary'} agent-toggle-btn" data-id="${agent.id}" data-enabled="${agent.enabled ? 1 : 0}">${agent.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-sm btn-danger agent-delete-btn" data-id="${agent.id}" data-name="${escapeHtml(agent.name)}">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);

      // Deployment sub-rows (shown when expanded)
      if (isExpanded) {
        renderDeploymentRows(tbody, agent);
      }
    }

    wireAgentButtons(tbody);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- Deployment Rows ----------

function renderDeploymentRows(tbody, agent) {
  if (agent.deployments.length === 0) {
    const emptyTr = document.createElement('tr');
    emptyTr.className = 'deployment-row';
    emptyTr.innerHTML = `<td></td><td colspan="6" class="deployment-cell"><span style="color:var(--text-muted);font-size:.85rem">No deployments. Add one to distribute a certificate to this agent.</span></td>`;
    tbody.appendChild(emptyTr);
  } else {
    for (const dep of agent.deployments) {
      const domainsText = dep.domains.map((d) => `<code>${escapeHtml(d)}</code>`).join(' ');
      const lastDep = dep.last_deployed_at
        ? formatDate(dep.last_deployed_at)
        : '<span style="color:var(--text-muted)">never</span>';

      const depTr = document.createElement('tr');
      depTr.className = 'deployment-row';
      depTr.innerHTML = `
        <td></td>
        <td class="deployment-cell" style="padding-left:1.5rem">
          <span style="color:var(--text-muted)">├─</span> ${escapeHtml(dep.name)}
        </td>
        <td colspan="2" class="deployment-cell">${domainsText} ${statusBadge(dep.cert_status, false)}</td>
        <td class="deployment-cell">${lastDep}</td>
        <td class="deployment-cell">${dep.enabled ? '<span class="badge badge-active">active</span>' : '<span class="badge badge-expired">disabled</span>'}</td>
        <td class="deployment-cell">
          <button class="btn btn-sm ${dep.enabled ? 'btn-muted' : 'btn-secondary'} dep-toggle-btn" data-agent-id="${agent.id}" data-dep-id="${dep.id}" data-enabled="${dep.enabled ? 1 : 0}">${dep.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-sm btn-danger dep-delete-btn" data-agent-id="${agent.id}" data-dep-id="${dep.id}" data-name="${escapeHtml(dep.name)}">Delete</button>
        </td>
      `;
      tbody.appendChild(depTr);
    }
  }

  // "Add Deployment" row
  const addTr = document.createElement('tr');
  addTr.className = 'deployment-row';
  addTr.innerHTML = `
    <td></td>
    <td colspan="6" class="deployment-cell" style="padding-left:1.5rem">
      <button class="btn btn-sm btn-secondary dep-add-btn" data-agent-id="${agent.id}">➕ Add Deployment</button>
    </td>
  `;
  tbody.appendChild(addTr);
}

// ---------- Button Wiring ----------

function wireAgentButtons(tbody) {
  // Expand / collapse
  $$('.agent-expand-cell', tbody).forEach((cell) => {
    cell.addEventListener('click', () => {
      const id = parseInt(cell.dataset.id, 10);
      if (expandedAgents.has(id)) expandedAgents.delete(id);
      else expandedAgents.add(id);
      loadAgents();
    });
  });

  // Edit agent
  $$('.agent-edit-btn', tbody).forEach((btn) => {
    btn.addEventListener('click', () => openAgentModal(parseInt(btn.dataset.id, 10)));
  });

  // Regenerate enrollment token (re-enroll)
  $$('.agent-regen-btn', tbody).forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!(await confirmModal('Reset this agent\'s enrollment? The agent will need to re-enroll with the new token.', { title: 'Reset Enrollment' }))) return;
      btn.disabled = true;
      try {
        const data = await api('POST', `/api/agents/${btn.dataset.id}/regenerate-token`);
        showTokenModal(data.enrollmentToken, data.enrollmentExpiresAt);
        toast('Enrollment reset — new enrollment token generated', 'success');
      } catch (err) { toast(err.message, 'error'); }
      btn.disabled = false;
    });
  });

  // Queue renew_agent_cert action
  $$('.agent-renew-cert-btn', tbody).forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!(await confirmModal('Force this agent to renew its authentication certificate on the next heartbeat?', { title: 'Force Certificate Renewal' }))) return;
      btn.disabled = true;
      try {
        await api('POST', `/api/agents/${btn.dataset.id}/actions`, { action: 'renew_agent_cert' });
        toast('Certificate renewal queued — agent will renew on next heartbeat', 'success');
        loadAgents();
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    });
  });

  // Toggle agent enabled
  $$('.agent-toggle-btn', tbody).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const nowEnabled = btn.dataset.enabled === '1';
      btn.disabled = true;
      try {
        await api('PATCH', `/api/agents/${btn.dataset.id}`, { enabled: !nowEnabled });
        toast(nowEnabled ? 'Agent disabled' : 'Agent enabled', 'success');
        loadAgents();
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    });
  });

  // Delete agent
  $$('.agent-delete-btn', tbody).forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!(await confirmModal(`Delete agent \u201c${btn.dataset.name}\u201d?\nThis will also remove all its deployments.`, { title: 'Delete Agent', okLabel: 'Delete', danger: true }))) return;
      btn.disabled = true;
      try {
        await api('DELETE', `/api/agents/${btn.dataset.id}`);
        expandedAgents.delete(parseInt(btn.dataset.id, 10));
        toast('Agent deleted', 'success');
        loadAgents();
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    });
  });

  // Toggle deployment enabled
  $$('.dep-toggle-btn', tbody).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const nowEnabled = btn.dataset.enabled === '1';
      btn.disabled = true;
      try {
        await api('PATCH', `/api/agents/${btn.dataset.agentId}/deployments/${btn.dataset.depId}`, { enabled: !nowEnabled });
        toast(nowEnabled ? 'Deployment disabled' : 'Deployment enabled', 'success');
        loadAgents();
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    });
  });

  // Delete deployment
  $$('.dep-delete-btn', tbody).forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!(await confirmModal(`Delete deployment "${btn.dataset.name}"?`, { title: 'Delete Deployment', okLabel: 'Delete', danger: true }))) return;
      btn.disabled = true;
      try {
        await api('DELETE', `/api/agents/${btn.dataset.agentId}/deployments/${btn.dataset.depId}`);
        toast('Deployment deleted', 'success');
        loadAgents();
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    });
  });

  // Add deployment
  $$('.dep-add-btn', tbody).forEach((btn) => {
    btn.addEventListener('click', () => {
      openDeploymentModal(parseInt(btn.dataset.agentId, 10));
    });
  });
}

// ---------- Modals ----------

async function openAgentModal(editId) {
  const modal = $('#agent-modal');
  const title = $('#agent-modal-title');
  const nameInput = $('#agent-name');
  const editIdInput = $('#agent-edit-id');
  const submitBtn = $('#agent-modal-submit');
  const errorEl = $('#agent-form-error');
  hide(errorEl);

  if (editId) {
    title.textContent = 'Edit Agent';
    submitBtn.textContent = 'Save Changes';
    try {
      const agent = await api('GET', `/api/agents/${editId}`);
      nameInput.value = agent.name;
      editIdInput.value = agent.id;
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
  } else {
    title.textContent = 'New Agent';
    submitBtn.textContent = 'Create Agent';
    nameInput.value = '';
    editIdInput.value = '';
  }

  show(modal);
  nameInput.focus();
}

async function openDeploymentModal(agentId) {
  const modal = $('#deployment-modal');
  const certSelect = $('#deployment-cert');
  const nameInput = $('#deployment-name');
  const agentIdInput = $('#deployment-agent-id');
  const editIdInput = $('#deployment-edit-id');
  const submitBtn = $('#deployment-modal-submit');
  const errorEl = $('#deployment-form-error');
  hide(errorEl);

  agentIdInput.value = agentId;
  editIdInput.value = '';
  nameInput.value = '';
  submitBtn.textContent = 'Add';
  $('#deployment-modal-title').textContent = 'Add Deployment';

  // Populate certificate dropdown
  certSelect.innerHTML = '<option value="">— Select a certificate —</option>';
  try {
    const certs = await api('GET', '/api/certs');
    const _serviceCertId = serviceCertId();
    let available = 0;
    for (const cert of certs) {
      // Skip the certificate used for server TLS
      if (_serviceCertId !== null && cert.id === _serviceCertId) continue;

      const domains = cert.domains.join(', ');
      const opt = document.createElement('option');
      opt.value = cert.id;
      opt.textContent = `${domains} (${cert.status}${cert.staging ? ' — staging' : ''})`;
      certSelect.appendChild(opt);
      available++;
    }
    if (available === 0 && certs.length > 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No eligible certificates (server TLS cert excluded)';
      opt.disabled = true;
      certSelect.appendChild(opt);
    }
  } catch {
    certSelect.innerHTML = '<option value="">— Failed to load —</option>';
  }

  show(modal);
  nameInput.focus();
}

function showTokenModal(token, expiresAt) {
  const modal = $('#token-modal');
  const titleEl = $('#token-modal-title');
  const hintEl = $('#token-modal-hint');
  const extraEl = $('#token-modal-extra');
  $('#token-display-value').textContent = token;

  titleEl.textContent = 'Enrollment Token';
  hintEl.textContent = 'Copy this enrollment token now \u2014 it will not be shown again.';
  let extraHtml = '';
  if (expiresAt) {
    extraHtml += `<p style="font-size:.85rem;color:var(--text-muted)">Use this token to enroll the remote agent on your remote host.<br>It will expire at: <strong>${formatDateTime(expiresAt)}</strong></p>`;
  } else {
    extraHtml += '<p style="font-size:.85rem;color:var(--text-muted)">Use this token to enroll the remote agent on your remote host.</p>';
  }
  extraEl.innerHTML = extraHtml;
  show(extraEl);

  show(modal);
}

// ---------- Init (one-time event binding) ----------

function initAgents() {
  // New agent button
  $('#new-agent-btn').addEventListener('click', () => openAgentModal(null));

  // Agent modal cancel
  $('#agent-modal-cancel').addEventListener('click', () => {
    hide($('#agent-modal'));
  });

  // Agent modal form submit
  $('#agent-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = $('#agent-form-error');
    hide(errorEl);

    const name = $('#agent-name').value.trim();
    const editId = $('#agent-edit-id').value;

    if (!name) {
      errorEl.textContent = 'Agent name is required.';
      show(errorEl);
      return;
    }

    const submitBtn = $('#agent-modal-submit');
    submitBtn.disabled = true;

    try {
      if (editId) {
        await api('PATCH', `/api/agents/${editId}`, { name });
        toast('Agent updated', 'success');
        hide($('#agent-modal'));
        loadAgents();
      } else {
        const data = await api('POST', '/api/agents', { name });
        hide($('#agent-modal'));
        if (data.enrollmentToken) {
          showTokenModal(data.enrollmentToken, data.enrollmentExpiresAt);
        }
        toast('Agent created', 'success');
        loadAgents();
      }
    } catch (err) {
      errorEl.textContent = err.message;
      show(errorEl);
    }

    submitBtn.disabled = false;
  });

  // Deployment modal cancel
  $('#deployment-modal-cancel').addEventListener('click', () => {
    hide($('#deployment-modal'));
  });

  // Deployment modal form submit
  $('#deployment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = $('#deployment-form-error');
    hide(errorEl);

    const agentId = $('#deployment-agent-id').value;
    const name = $('#deployment-name').value.trim();
    const certId = parseInt($('#deployment-cert').value, 10);

    if (!name) {
      errorEl.textContent = 'Deployment name is required.';
      show(errorEl);
      return;
    }
    if (!certId) {
      errorEl.textContent = 'Please select a certificate.';
      show(errorEl);
      return;
    }

    const submitBtn = $('#deployment-modal-submit');
    submitBtn.disabled = true;

    try {
      await api('POST', `/api/agents/${agentId}/deployments`, {
        name,
        certificateId: certId,
      });
      hide($('#deployment-modal'));
      expandedAgents.add(parseInt(agentId, 10));
      toast('Deployment added', 'success');
      loadAgents();
    } catch (err) {
      errorEl.textContent = err.message;
      show(errorEl);
    }

    submitBtn.disabled = false;
  });

  // Token modal copy button
  $('#token-copy-btn').addEventListener('click', () => {
    const token = $('#token-display-value').textContent;
    navigator.clipboard.writeText(token).then(() => {
      toast('Token copied to clipboard', 'success');
    }).catch(() => {
      const range = document.createRange();
      range.selectNodeContents($('#token-display-value'));
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      toast('Select and copy the token manually', 'info');
    });
  });

  // Token modal close
  $('#token-modal-close').addEventListener('click', () => {
    hide($('#token-modal'));
  });
}
