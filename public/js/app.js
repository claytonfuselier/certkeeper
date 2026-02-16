/* =============================================
   CertKeeper — App Entry Point (ES Module)
   ============================================= */

import { $, toast } from './dom.js';
import { registerRoute, setAuthCheck, setAuthenticated, startRouter } from './router.js';
import { checkAuth, init as initAuth, loadLogin, loadSetup } from './auth.js';
import * as dashboard from './dashboard.js';
import * as certs from './certs.js';
import * as agents from './agents.js';
import * as notifications from './notifications.js';
import * as settings from './settings.js';

// ---------- Global Error Handling ----------

window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || 'An unexpected error occurred';
  // Don't double-toast for session expired (handled by api.js)
  if (msg !== 'Session expired') {
    toast(msg, 'error');
  }
});

// ---------- Auth Check (used by router) ----------

let _cachedAuthState = null;

async function authCheck() {
  if (_cachedAuthState) return _cachedAuthState;
  _cachedAuthState = await checkAuth();
  return _cachedAuthState;
}

/** Clear cached auth state (e.g. after login/logout). */
export function clearAuthCache() {
  _cachedAuthState = null;
}

// ---------- Route Registration ----------

// Public routes (no auth required)
registerRoute('/login', 'login-screen', {
  load: () => loadLogin(),
}, { public: true });

registerRoute('/setup', 'setup-screen', {
  load: () => loadSetup({}, _cachedAuthState),
}, { public: true });

// Authenticated routes
registerRoute('/', 'page-dashboard', dashboard);
registerRoute('/certificates', 'page-certificates', certs);
registerRoute('/certificates/new', 'page-new-cert', {
  load: () => certs.loadNewCert(),
});
registerRoute('/agents', 'page-agents', agents);
registerRoute('/notifications', 'page-notifications', notifications);
registerRoute('/notifications/:channel', 'page-notifications', notifications);
registerRoute('/settings', 'page-settings', settings);
registerRoute('/settings/:tab', 'page-settings', settings);

// ---------- Boot ----------

async function init() {
  // Set auth check for the router
  setAuthCheck(authCheck);

  // Check auth state before initializing
  const authState = await checkAuth();
  _cachedAuthState = authState;

  if (authState.authenticated) {
    setAuthenticated(true);
    $('#current-user').textContent = authState.user.username;
  }

  // Initialize all modules (bind event listeners — once only)
  initAuth();
  certs.init();
  agents.init();
  notifications.init();
  settings.init();

  // Start the router — renders the current URL
  startRouter();
}

document.addEventListener('DOMContentLoaded', init);
