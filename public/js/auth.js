/* =============================================
   CertKeeper — Auth (Login, Setup, Logout)
   ============================================= */

import { $, show, hide, toast } from './dom.js';
import { api, setCsrfToken } from './api.js';
import { navigate, setAuthenticated } from './router.js';

// ---------- Auth API helpers ----------

export async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (res.ok && data.user) {
      if (data.csrfToken) setCsrfToken(data.csrfToken);
      return { authenticated: true, needsSetup: false, user: data.user };
    }
    if (data.needsSetup) {
      return { authenticated: false, needsSetup: true, emailFromEnv: !!data.emailFromEnv, emailValue: data.emailValue || '' };
    }
  } catch { /* network error */ }
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

    // Client-side validation
    if (!username || username.length < 3) {
      errorEl.textContent = 'Username must be at least 3 characters.';
      show(errorEl);
      return;
    }
    if (!$('#setup-email').disabled && (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      errorEl.textContent = 'Please enter a valid email address.';
      show(errorEl);
      return;
    }
    if (!password || password.length < 8) {
      errorEl.textContent = 'Password must be at least 8 characters.';
      show(errorEl);
      return;
    }
    if (password !== confirm) {
      errorEl.textContent = 'Passwords do not match.';
      show(errorEl);
      return;
    }

    try {
      const data = await api('POST', '/api/auth/setup', { username, password, email });
      if (data.csrfToken) setCsrfToken(data.csrfToken);
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
      if (data.csrfToken) setCsrfToken(data.csrfToken);
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
export async function loadSetup() {
  hide($('#setup-error'));

  // Verify setup is still needed — redirect to login if not
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (res.ok && data.user) {
      navigate('/');
      return;
    }
    if (!data.needsSetup) {
      navigate('/login');
      return;
    }
    if (data.emailFromEnv) {
      const setupEmailInput = $('#setup-email');
      setupEmailInput.value = data.emailValue || '';
      setupEmailInput.disabled = true;
      setupEmailInput.placeholder = 'Managed via environment variable';
      setupEmailInput.removeAttribute('required');
    }
  } catch { /* ignore — field stays default */ }
}
