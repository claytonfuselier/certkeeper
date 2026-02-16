/* =============================================
   CertKeeper — Auth (Login, Setup, Logout)
   ============================================= */

import { $, show, hide, toast } from './dom.js';
import { api } from './api.js';
import { navigate, setAuthenticated } from './router.js';

// ---------- Auth API helpers ----------

export async function checkAuth() {
  try {
    const data = await api('GET', '/api/auth/me');
    if (data.user) return { authenticated: true, needsSetup: false, user: data.user };
  } catch { /* not logged in */ }

  // Check if first-run setup is needed
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (data.needsSetup) {
      return { authenticated: false, needsSetup: true, emailFromEnv: !!data.emailFromEnv, emailValue: data.emailValue || '' };
    }
  } catch { /* ignore */ }

  return { authenticated: false, needsSetup: false };
}

// ---------- Lifecycle ----------

export function init() {
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
      setAuthenticated(true);
      $('#current-user').textContent = data.user.username;
      toast('Account created! Welcome.', 'success');
      navigate('/');
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
      const data = await api('POST', '/api/auth/login', { username, password });
      setAuthenticated(true);
      $('#current-user').textContent = data.user.username;
      navigate('/');
    } catch (err) {
      errorEl.textContent = err.message;
      show(errorEl);
    }
  });

  // Logout
  $('#logout-btn').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout');
    setAuthenticated(false);
    toast('Logged out', 'info');
    navigate('/login');
  });
}

/** Called when navigating to /login. */
export function loadLogin() {
  // Clear any previous error
  hide($('#login-error'));
}

/** Called when navigating to /setup. */
export function loadSetup(params, authState) {
  hide($('#setup-error'));

  // If email is from .env, pre-fill and lock the field
  if (authState && authState.emailFromEnv) {
    const setupEmailInput = $('#setup-email');
    setupEmailInput.value = authState.emailValue || '';
    setupEmailInput.disabled = true;
    setupEmailInput.placeholder = 'Managed via environment variable';
    setupEmailInput.removeAttribute('required');
  }
}
