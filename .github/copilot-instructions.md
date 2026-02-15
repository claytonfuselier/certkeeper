# CertKeeper — Copilot Instructions

## Project Overview

CertKeeper is a lightweight, self-hosted Let's Encrypt certificate manager with a web UI. It wraps certbot to issue, renew, revoke, and monitor SSL/TLS certificates, supporting both HTTP-01 (standalone) and DNS-01 (Cloudflare) challenge types, including wildcards.

## Tech Stack

- **Runtime:** Node.js 24+ (no TypeScript, no transpilation)
- **Framework:** Express 5.x (async route handlers, `req.body` via built-in parser)
- **Database:** SQLite via sql.js (in-memory with debounced file persistence — no native bindings)
- **Frontend:** Vanilla HTML/CSS/JS (single `index.html` SPA with hash-based routing — no build step, no framework)
- **Logging:** Winston with file rotation
- **Scheduling:** node-cron
- **TLS:** selfsigned v5.5.0 for self-signed cert generation (async API, uses `notAfterDate` not `days`)
- **Auth:** bcryptjs + express-session backed by a custom SQLite session store
- **Containerization:** Docker (multi-stage: node:24-alpine for deps → python:3.13-alpine for certbot runtime)

## Architecture

```
src/
├── index.js             # Entry point — HTTPS or HTTP server, startup sequence
├── config.js            # Centralized config from env vars with defaults
├── db.js                # sql.js wrapper with synchronous-style API (run/get/all)
├── logger.js            # Winston setup with file rotation
├── middleware/
│   ├── auth.js          # requireAuth session middleware
│   ├── agentAuth.js     # requireAgentAuth — Bearer token middleware for agent API
│   └── sessionStore.js  # SQLite-backed express-session store
├── routes/
│   ├── auth.js          # Login, logout, first-run setup, password change
│   ├── certs.js         # Certificate CRUD, async issue/renew, retry, revoke
│   ├── dashboard.js     # Stats endpoint
│   ├── settings.js      # Email, Cloudflare, TLS, schedule management
│   ├── agents.js        # Admin CRUD for agents + nested deployment CRUD (session-authed)
│   └── agent-api.js     # Agent-facing API — deployments list, bundle download, heartbeat (token-authed)
└── services/
    ├── certbot.js       # Certbot CLI wrapper (child_process) with error classification
    ├── cloudflare.js    # CF API token validation
    ├── scheduler.js     # Randomized twice-weekly renewal cron
    └── tls.js           # HTTPS cert management (self-signed / custom / managed)

public/
├── index.html           # Single-page app (all views in one file)
├── css/style.css        # Dark-theme styles, CSS variables
└── js/app.js            # All frontend logic (IIFE, hash routing, fetch API calls)
```

## Key Patterns & Conventions

### Backend

- **No TypeScript.** All code is CommonJS (`require`/`module.exports`).
- **Express 5 async handlers.** Route handlers use `async (req, res) => {}` — Express 5 catches rejected promises automatically.
- **Database access** is via `getDb()` which returns a `Database` instance with `run()`, `get()`, and `all()` methods. All are synchronous-style (sql.js runs in-memory). Writes auto-persist to disk with a 500ms debounce.
- **Config is centralized** in `src/config.js`. All env vars have defaults. Never read `process.env` outside config.js.
- **Certbot operations are async.** `issueCertificate()` and `renewCertificate()` spawn child processes and return promises. The route returns 202 immediately; the frontend polls for completion.
- **Error responses** use `{ error: "message" }` JSON. Structured certbot errors use `{ title, detail, link }` stored as JSON in `error_message` column.
- **Audit logging** via `audit_log` table — insert a row for significant actions.
- **`USE_HTTP=true`** disables HTTPS, skips self-signed cert generation, and disables TLS settings in the UI. Cookie `secure` flag also adapts.

### Frontend

- **No framework, no build step.** Vanilla JS inside an IIFE in `app.js`.
- **Hash-based routing** — `#certificates`, `#new-cert`, `#settings`. Views are `<section>` elements toggled via CSS class.
- **`api(method, url, body)`** is the central fetch wrapper. Throws on non-2xx with the full response body attached to the Error object.
- **Settings page** uses a tab layout with 6 tabs: Status, Registration Email, Renew Schedule, Cloudflare API, TLS, Change Password. Tabs use CSS `.settings-pane.active` for show/hide.
- **Toast notifications** via `toast(msg, type)`.
- **CSS uses custom properties** (dark theme): `--bg`, `--text`, `--primary`, `--border`, etc.

### Database Schema (key tables)

- **`certificates`** — `id, domains (space-separated), challenge_type, status (issuing|active|expired|error|revoked|renewing), certbot_name, expires_at, auto_renew, error_message, created_at, updated_at`
- **`users`** — `id, username, password (bcrypt hash)`
- **`settings`** — `key, value` (stores email, CF token, TLS domain, renewal schedule)
- **`audit_log`** — `id, action, details (JSON), created_at`
- **`sessions`** — express-session store
- **`agents`** — `id, name, token_hash (SHA-256), token_prefix (first 8 hex chars for UI display), enabled, last_contact_at, last_contact_ip, created_at, updated_at`
- **`deployments`** — `id, agent_id (FK → agents, CASCADE), certificate_id (FK → certificates, CASCADE), name, enabled, last_deployed_at, last_deployed_hash, created_at, updated_at` — the unit of work that ties an agent to a certificate

### Certificate Lifecycle

1. **Issue:** `POST /api/certs` → validates, deduplicates (409 if exists, override prompt for revoked), inserts row as `issuing`, spawns certbot, returns 202. Frontend polls.
2. **Renew:** `POST /api/certs/:id/renew` → marks `renewing`, spawns `certbot renew --force-renewal`, syncs on success.
3. **Retry:** Frontend deletes errored entry, re-submits same request.
4. **Reissue:** Frontend sends `overrideRevoked: true` to replace a revoked entry.
5. **Revoke:** `DELETE /api/certs/:id?action=revoke` → certbot revoke, keeps row as `revoked`.
6. **Remove:** `DELETE /api/certs/:id?action=remove` → deletes row from DB, no certbot call.

### Renewal Schedule

- Default: randomized twice-weekly (2 days, 3 apart, early-morning hours), persisted in DB `settings` table.
- Override: `RENEWAL_CRON` env var.
- Two independent node-cron tasks (one per day).
- `renewAll()` parses certbot output to detect actual renewals; only syncs DB + refreshes service TLS when something changed.

### TLS Modes

- **Self-signed (default):** Auto-generated via `selfsigned` package, stored in `data/tls/`, auto-renewed when expired.
- **Custom PEM:** User uploads cert + key via settings UI.
- **Managed cert:** User selects an issued Let's Encrypt cert; files are copied to `data/tls/` and auto-refreshed on renewal.
- **HTTP mode (`USE_HTTP=true`):** No TLS, all TLS settings disabled.

### Agents & Deployments

Agents are remote systems (e.g. a future "certkeeper-agent" CLI) that pull certificates from CertKeeper via a token-authenticated API.

- **Agents** represent a remote host. Creating an agent generates a `ck_<64 hex>` bearer token (shown once, stored as SHA-256 hash). Agents authenticate via `Authorization: Bearer ck_...` header.
- **Deployments** tie an agent to a certificate. An agent can have many deployments. Each deployment has a name, references a certificate, and tracks `last_deployed_at` / `last_deployed_hash` so the agent knows when a cert has been renewed.
- **Agent middleware** (`agentAuth.js`) hashes the bearer token, looks up the agent row, updates `last_contact_at`/`last_contact_ip`, and sets `req.agent`.
- **Admin routes** (`/api/agents`) are session-authed and provide full CRUD for agents and their deployments.
- **Agent-facing routes** (`/api/agent`) are token-authed:
  - `GET /api/agent/deployments` — returns the agent's deployments with cert metadata + `content_hash` (SHA-256 of fullchain.pem, truncated to 16 hex chars) so the agent can detect renewals without downloading.
  - `GET /api/agent/deployments/:id/bundle` — returns cert + key PEM files for a specific deployment; updates `last_deployed_at`/`last_deployed_hash`.
  - `POST /api/agent/heartbeat` — keepalive, returns deployment count.
- **Frontend** — Agents page shows an expandable table: each agent row expands to reveal its deployments with inline add/enable/disable/delete controls. Agent create/edit is a simple name-only modal; deployments are added via a separate modal with name + certificate dropdown.

## Guidelines

- Keep dependencies minimal — this is a zero-config, lightweight tool.
- No TypeScript, no bundlers, no frontend frameworks.
- All new env vars must be added to `config.js`, `.env.example`, and the README env table.
- Test with `LETSENCRYPT_STAGING=true` to avoid rate limits.
- Certbot must be installed on the host (or use Docker). The app checks at startup and warns if missing.
- `selfsigned` v5.5.0 quirks: `generate()` is async (returns Promise), ignores `days` option — use `notAfterDate` (Date object).

## To-Do

### Frontend refactor: ES modules + pushState routing

The current frontend is a single `index.html` + single `app.js` IIFE with hash-based routing (`#certificates`, `#settings`). This prevents deep linking and becomes unwieldy as the app grows. The next improvement should split the frontend into ES modules and adopt `history.pushState()` path-based routing.

#### Goals

- **File splitting:** Break `app.js` into ES modules (`<script type="module">`), one per feature area:
  - `js/router.js` — pushState router, route definitions, navigation helpers
  - `js/api.js` — `api()` fetch wrapper, `toast()`, `escapeHtml()`, shared utilities
  - `js/dashboard.js` — dashboard page logic
  - `js/certs.js` — certificate list, new-cert form, detail view, polling
  - `js/agents.js` — agents table, expandable deployments, agent/deployment modals
  - `js/settings.js` — settings tabs (email, schedule, cloudflare, TLS, password)
  - `js/auth.js` — login form, setup flow, session management
  - `js/app.js` — entry point, imports all modules, calls `init()`
- **Path-based routing:** Replace `#certificates` with real URL paths (`/certificates`, `/agents/3`, `/settings/tls`):
  - Use `history.pushState()` / `popstate` event instead of `hashchange`
  - URLs become bookmarkable and shareable (e.g. `/certificates/5` links directly to a cert)
  - Browser back/forward works naturally
- **Server catch-all:** Add a single Express route **after** API routes and static file middleware:
  ```js
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });
  ```
  This ensures all non-API paths serve the SPA shell so the client-side router can handle them.
- **Route structure:**
  - `/` → dashboard
  - `/certificates` → certificate list
  - `/certificates/new` → new certificate form
  - `/certificates/:id` → certificate detail (future)
  - `/agents` → agents list with expandable deployments
  - `/settings` → settings (default tab)
  - `/settings/:tab` → settings with specific tab active (e.g. `/settings/tls`)
  - `/login` → login form (unauthenticated)
  - `/setup` → first-run setup (unauthenticated)
- **`index.html` stays as the SPA shell** — contains the layout (nav, main container), all `<section>` page containers, and modals. No templating engine needed.
- **No build step.** ES modules work natively in all modern browsers. No bundler, no transpiler.
- **No new dependencies.** This is purely a frontend restructure.

#### Migration approach

1. Create `js/router.js` with `pushState` navigation and route matching
2. Extract shared utilities into `js/api.js`
3. Move each page's logic into its own module, exporting an `init()` and `load()` function
4. Update `index.html` to use `<script type="module" src="js/app.js">`
5. Convert all `<a data-page="...">` navigation to use the router's `navigate()` function
6. Add the server-side catch-all route in `src/index.js`
7. Update nav links to use real `href` paths with click interception
