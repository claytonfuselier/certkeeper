/* =============================================
   CertKeeper — DOM Utilities
   ============================================= */

export function $(sel, ctx = document) { return ctx.querySelector(sel); }
export function $$(sel, ctx = document) { return [...ctx.querySelectorAll(sel)]; }

export function show(el) { el.classList.remove('hidden'); }
export function hide(el) { el.classList.add('hidden'); }

export function toast(msg, type = 'info') {
  const container = $('#toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

export function formatDate(str) {
  if (!str) return '—';
  const d = new Date(str);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(str) {
  if (!str) return '—';
  const d = new Date(str);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function statusBadge(status, staging) {
  const stagingTag = staging ? ' <span class="badge badge-staging">staging</span>' : '';
  return `<span class="badge badge-${status}">${status}</span>${stagingTag}`;
}

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

/**
 * Parse an error_message field which may be JSON (structured) or plain text (legacy).
 * Returns { title, detail, link }.
 */
export function parseErrorMessage(raw) {
  if (!raw) return { title: 'Unknown error', detail: 'No details available.', link: '' };
  try {
    const obj = JSON.parse(raw);
    if (obj.title) return { title: obj.title, detail: obj.detail || '', link: obj.link || '' };
  } catch { /* not JSON — treat as legacy plain text */ }
  return { title: 'Certificate operation failed', detail: raw, link: 'https://community.letsencrypt.org/' };
}

export function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

/**
 * Show a themed confirm dialog. Returns a Promise that resolves to true/false.
 * @param {string} message — the question to display
 * @param {object} [opts]
 * @param {string} [opts.title='Confirm']  — modal heading
 * @param {string} [opts.okLabel='Confirm'] — label for the confirm button
 * @param {boolean} [opts.danger=false] — if true, confirm button uses btn-danger style
 */
export function confirmModal(message, { title = 'Confirm', okLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = $('#confirm-modal');
    const titleEl = $('#confirm-modal-title');
    const msgEl = $('#confirm-modal-message');
    const okBtn = $('#confirm-modal-ok');
    const cancelBtn = $('#confirm-modal-cancel');

    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = okLabel;

    // Style the confirm button
    okBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';

    function cleanup(result) {
      hide(overlay);
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onBackdrop(e) { if (e.target === overlay) cleanup(false); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);

    show(overlay);
    okBtn.focus();
  });
}
