/* =============================================
   CertKeeper — pushState Router
   ============================================= */

import { $, $$, show, hide } from './dom.js';

// ---------- Route Registry ----------

/**
 * Each route module can export:
 *   init()          — called once at startup to bind event listeners
 *   load(params)    — called each time the route is navigated to
 *   leave()         — called when navigating away (optional cleanup)
 */
const routes = [];
let currentRoute = null;
let currentPageId = null;
let _isAuthenticated = false;
let _authCheckFn = null; // set by app.js

// ---------- API ----------

/**
 * Register a route.
 * @param {string} path — URL pattern, e.g. '/certificates' or '/settings/:tab'
 * @param {string} pageId — DOM id of the page div (without #), e.g. 'page-certificates'
 * @param {object} module — { init?, load?, leave? }
 * @param {object} [opts] — { public: true } for unauthenticated routes
 */
export function registerRoute(path, pageId, module, opts = {}) {
  // Convert path pattern to regex: '/settings/:tab' → /^\/settings\/([^/]+)$/
  const paramNames = [];
  const regexStr = path.replace(/:([^/]+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  const regex = new RegExp(`^${regexStr}$`);
  routes.push({ path, regex, paramNames, pageId, module, public: opts.public || false });
}

/**
 * Set the function used to check authentication state.
 * Must return { authenticated: boolean, needsSetup: boolean }.
 */
export function setAuthCheck(fn) {
  _authCheckFn = fn;
}

/** Mark user as authenticated. */
export function setAuthenticated(val) {
  _isAuthenticated = val;
}

/** Get current authentication state. */
export function isAuthenticated() {
  return _isAuthenticated;
}

/**
 * Navigate to a path. Updates the URL and renders the matched route.
 * @param {string} path — e.g. '/certificates' or '/settings/tls'
 * @param {object} [opts] — { replace: true } to use replaceState instead of pushState
 */
export function navigate(path, opts = {}) {
  if (path === window.location.pathname) {
    // Same path — just re-run load
    _render(path);
    return;
  }
  if (opts.replace) {
    history.replaceState(null, '', path);
  } else {
    history.pushState(null, '', path);
  }
  _render(path);
}

/** Get the currently active page id (e.g. 'dashboard'). */
export function currentPage() {
  return currentPageId;
}

/**
 * Start the router. Call once after all routes are registered.
 * Handles initial page load + popstate for back/forward.
 */
export function startRouter() {
  window.addEventListener('popstate', () => {
    _render(window.location.pathname);
  });

  // Intercept all <a> clicks with href paths
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link) return;
    // Block clicks on disabled links
    if (link.getAttribute('aria-disabled') === 'true') {
      e.preventDefault();
      return;
    }
    const href = link.getAttribute('href');
    // Skip external links, hash links, and non-path links
    if (!href || href.startsWith('http') || href.startsWith('#') || href.startsWith('mailto:') || link.target === '_blank') return;
    // Only intercept paths that start with /
    if (href.startsWith('/')) {
      e.preventDefault();
      navigate(href);
    }
  });

  // Render the initial route
  _render(window.location.pathname);
}

// ---------- Internal ----------

function _matchRoute(path) {
  for (const route of routes) {
    const match = path.match(route.regex);
    if (match) {
      const params = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
      return { route, params };
    }
  }
  return null;
}

async function _render(path) {
  const matched = _matchRoute(path);

  if (!matched) {
    // Unknown route — redirect to dashboard
    navigate('/', { replace: true });
    return;
  }

  const { route, params } = matched;

  // Auth guard
  if (!route.public && !_isAuthenticated) {
    // Check auth state
    if (_authCheckFn) {
      const state = await _authCheckFn();
      if (state.needsSetup) {
        if (path !== '/setup') {
          navigate('/setup', { replace: true });
          return;
        }
      } else if (!state.authenticated) {
        if (path !== '/login') {
          navigate('/login', { replace: true });
          return;
        }
      } else {
        _isAuthenticated = true;
      }
    } else {
      navigate('/login', { replace: true });
      return;
    }
  }

  // Redirect authenticated users away from login/setup
  if (_isAuthenticated && (path === '/login' || path === '/setup')) {
    navigate('/', { replace: true });
    return;
  }

  // Call leave() on the previous route
  if (currentRoute && currentRoute.module.leave) {
    currentRoute.module.leave();
  }

  // Show/hide screens for auth vs main app pages
  const loginScreen = $('#login-screen');
  const setupScreen = $('#setup-screen');
  const mainScreen = $('#main-screen');

  if (path === '/login') {
    show(loginScreen);
    hide(setupScreen);
    hide(mainScreen);
  } else if (path === '/setup') {
    hide(loginScreen);
    show(setupScreen);
    hide(mainScreen);
  } else {
    hide(loginScreen);
    hide(setupScreen);
    show(mainScreen);

    // Show/hide page divs
    $$('.page').forEach(p => hide(p));
    const pageEl = $(`#${route.pageId}`);
    if (pageEl) show(pageEl);

    // Update nav link active state — match by the first path segment
    const basePath = '/' + (path.split('/')[1] || '');
    $$('.nav-link').forEach((el) => {
      const linkPath = el.getAttribute('href');
      el.classList.toggle('active', linkPath === basePath || (basePath === '/' && linkPath === '/'));
    });
  }

  currentRoute = route;
  currentPageId = route.pageId.replace('page-', '');

  // Call load() on the new route
  if (route.module.load) {
    route.module.load(params);
  }
}
