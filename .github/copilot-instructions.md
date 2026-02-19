# CertKeeper — Copilot Instructions

## Project Overview

CertKeeper is a lightweight, self-hosted Let's Encrypt certificate manager with a web UI. It wraps certbot to issue, renew, revoke, and monitor SSL/TLS certificates using DNS-01 challenges via Cloudflare, including wildcards. It includes an agent system for distributing certificates to remote hosts via mTLS.

## Tech Stack

- **Runtime:** Node.js 24+ (no TypeScript, no transpilation)
- **Framework:** Express 5.x (async route handlers, `req.body` via built-in parser)
- **Database:** SQLite via sql.js (in-memory with debounced file persistence — no native bindings)
- **Frontend:** Vanilla HTML/CSS/JS (single `index.html` SPA with pushState routing — no build step, no framework). ES modules split across 11 files in `public/js/`.
- **Logging:** Winston with file rotation
- **Scheduling:** node-cron
- **TLS:** selfsigned v5.5.0 for self-signed cert generation (async API, uses `notAfterDate` not `days`)
- **Crypto:** Pure Node.js `crypto` module for internal CA (RSA key gen, X.509 cert signing, DER/ASN.1 encoding — no openssl dependency)
- **Auth:** bcryptjs + express-session backed by a custom SQLite session store
- **Containerization:** Docker (multi-stage: node:24-alpine for deps → python:3.13-alpine for certbot runtime)
- **Packaging:** nfpm for `.deb`/`.rpm` generation; install script for automated setup; systemd for service management

## Architecture

```
src/
├── index.js             # Entry point — HTTPS server with mTLS, startup sequence
├── config.js            # Centralized config from env vars with defaults
├── db.js                # sql.js wrapper with synchronous-style API (run/get/all)
├── logger.js            # Winston setup with file rotation
├── middleware/
│   ├── auth.js          # requireAuth session middleware
│   ├── agentAuth.js     # mTLS agent certificate auth + enrollment token auth for agents
│   ├── csrf.js          # CSRF synchronizer token middleware
│   └── sessionStore.js  # SQLite-backed express-session store
├── routes/
│   ├── auth.js          # Login, logout, first-run setup, password change
│   ├── certs.js         # Certificate CRUD, async issue/renew, retry, revoke
│   ├── dashboard.js     # Stats endpoint
│   ├── notifications.js # Notification channel CRUD (7 channels, per-event toggles)
│   ├── settings.js      # Email, Cloudflare, TLS, schedule, agent monitoring settings
│   ├── agents.js        # Admin CRUD for agents + nested deployment CRUD (session-authed)
│   └── agent-api.js     # Agent-facing API — enroll, renew-cert, heartbeat, deployments (mTLS-authed)
└── services/
    ├── ca.js            # Internal Certificate Authority (RSA 4096, pure Node.js crypto)
    ├── certbot.js       # Certbot CLI wrapper (child_process) with error classification
    ├── cloudflare.js    # CF API token validation
    ├── configHelpers.js # Shared config resolution (env var > DB, with decryption)
    ├── encryption.js    # AES-256-GCM encryption for secrets at rest + key rotation
    ├── scheduler.js     # Randomized twice-weekly renewal cron
    ├── agentMonitor.js  # Agent liveness cron (every 1 min, offline detection)
    └── tls.js           # HTTPS cert management (self-signed / custom / managed)

install/
├── certkeeper.service   # systemd unit file
├── certkeeper.env       # Default env file template for /etc/certkeeper/
├── nfpm.yaml            # nfpm config for .deb/.rpm package generation
├── postinstall.sh       # Package post-install script (user, dirs, service)
└── preremove.sh         # Package pre-remove script (stop service)

.github/workflows/
├── docker-publish.yml   # Build and push Docker image to GHCR
└── release.yml          # Build .deb/.rpm/tarball on GitHub Release

install.sh               # Root-level install/uninstall script

public/
├── index.html           # Single-page app (all views in one file)
├── css/style.css        # Dark-theme styles, CSS variables
└── js/                  # ES modules (no build step)
    ├── app.js           # Entry point — imports all modules, registers routes, boots app
    ├── router.js        # pushState router with auth guards and route lifecycle
    ├── api.js           # Centralized fetch wrapper with 401 redirect
    ├── dom.js           # Shared DOM utilities ($, toast, escapeHtml, formatDate, etc.)
    ├── state.js         # Global TLS/agent state management
    ├── auth.js          # Login, setup, logout, session check
    ├── dashboard.js     # Dashboard stats and audit log
    ├── certs.js         # Certificate CRUD, polling, new-cert form
    ├── agents.js        # Agents table, deployments, modals, TLS safety guards
    ├── notifications.js # Notification channel tabs (7 channels), per-event toggles
    └── settings.js      # Settings tabs (status, Let's Encrypt, Cloudflare, TLS, agents, password)
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

### Frontend

- **No framework, no build step.** Vanilla JS using native ES modules (`<script type="module">`).
- **Path-based routing** via `history.pushState()` — `/certificates`, `/agents`, `/settings/tls`, `/notifications/slack`. Views are `<div>` page containers toggled by the router.
- **ES modules** split across 11 files in `public/js/`: `app.js` (entry point), `router.js`, `api.js`, `dom.js`, `state.js`, `auth.js`, `dashboard.js`, `certs.js`, `agents.js`, `notifications.js`, `settings.js`.
- **Module lifecycle:** Each page module exports `init()` (once at startup, binds listeners), `load(params)` (on each navigation), and optionally `leave()` (cleanup on route exit).
- **`api(method, url, body)`** is the central fetch wrapper (`api.js`). Throws on non-2xx, redirects to `/login` on 401.
- **Settings page** uses a tab layout with 6 tabs: Status, Let's Encrypt, Cloudflare API, TLS, Agents, Change Password. Tabs use CSS `.settings-pane.active` for show/hide.
- **Notifications** is a separate page at `/notifications` with 7 channel sub-tabs, deep-linkable via `/notifications/:channel`.
- **Toast notifications** via `toast(msg, type)` from `dom.js`.
- **CSS uses custom properties** (dark theme): `--bg`, `--text`, `--primary`, `--border`, etc.

### Database Schema (key tables)

- **`certificates`** — `id, domains (space-separated), status (pending|issuing|active|expired|error|revoked|renewing), certbot_name, issued_at, expires_at, last_renewed_at, auto_renew, staging, error_message, created_at, updated_at`
- **`users`** — `id, username, password (bcrypt hash), created_at, updated_at`
- **`settings`** — `key, value, updated_at` (stores email, CF token (encrypted), TLS domain, renewal schedule, notification configs (encrypted), agent monitoring settings)
- **`audit_log`** — `id, action, details (JSON), created_at`
- **`sessions`** — `sid, sess, expired` (express-session store)
- **`agents`** — `id, name, enrollment_token_hash, enrollment_expires_at, cert_fingerprint (SHA-256, UNIQUE), cert_expires_at, prev_cert_fingerprint (UNIQUE), prev_cert_expires_at, cert_serial, enabled, status (online/offline/NULL), next_contact_at, config_version, pending_actions (JSON), last_contact_at, last_contact_ip, created_at, updated_at`
- **`deployments`** — `id, agent_id (FK → agents, CASCADE), certificate_id (FK → certificates, CASCADE), name, enabled, last_deployed_at, last_deployed_hash, created_at, updated_at` — ties an agent to a certificate

### Security

- **CSRF protection:** Synchronizer token pattern (`csrf.js`). Token stored in session, sent via `X-CSRF-Token` header. Validated on POST/PUT/PATCH/DELETE for session-authed routes. Exempt: agent API (mTLS), login/setup (pre-session), unauthenticated requests.
- **Encryption at rest:** AES-256-GCM (`encryption.js`) for all secret settings values (`cloudflare_api_token`, all `notif_*` configs). Key stored in `data/.encryption-key`, auto-rotated every 30 days with crash-safe `previous_key` fallback.
- **XSS prevention:** All user-supplied content passes through `escapeHtml()` before DOM insertion. No raw `innerHTML` with unsanitized input.
- **SQL injection prevention:** All queries use parameterized statements. Integer route params validated with `parseIntId()` before reaching any query.
- **Session security:** Server-side SQLite session store. Auto-generated 48-byte session secret. Auth routes return only `id`/`username` — no password hashes.
- **Secret masking:** GET responses for notification channels and Cloudflare tokens return `hasToken: true` instead of raw values.

### Certificate Lifecycle

1. **Issue:** `POST /api/certs` → validates, deduplicates (409 if exists, override prompt for revoked), inserts row as `issuing`, spawns certbot, returns 202. Frontend polls.
2. **Renew:** `POST /api/certs/:id/renew` → marks `renewing`, spawns `certbot renew --force-renewal`, syncs on success.
3. **Retry:** Frontend deletes errored entry, re-submits same request.
4. **Reissue:** Frontend sends `overrideRevoked: true` to replace a revoked entry.
5. **Revoke:** `DELETE /api/certs/:id?action=revoke` → certbot revoke, keeps row as `revoked`.
6. **Remove:** `DELETE /api/certs/:id?action=remove` → deletes row from DB + cert files from disk, no certbot revoke.
7. **Default delete:** `DELETE /api/certs/:id` (no action) → certbot revoke, then remove from DB.

### Renewal Schedule

- Default: randomized twice-weekly (2 days, 3 apart, early-morning hours), persisted in DB `settings` table.
- Override: `RENEWAL_CRON` env var.
- Two independent node-cron tasks (one per day).
- `renewAll()` parses certbot output to detect actual renewals; only syncs DB + refreshes service TLS when something changed.

### TLS Modes

- **Self-signed (default):** Auto-generated via `selfsigned` package, stored in `data/tls/`, auto-renewed when expired.
- **Custom PEM:** User uploads cert + key via settings UI.
- **Managed cert:** User selects an issued Let's Encrypt cert; files are copied to `data/tls/` and auto-refreshed on renewal.

### TLS / Agent Safety Guards

Four protections enforce separation between server TLS and agent infrastructure:

1. **No agents on self-signed:** Agent creation is blocked (`POST /api/agents` → 400) when the server uses a self-signed TLS certificate. Agents cannot verify the server's identity during enrollment. The UI disables the "New Agent" button with an explanatory warning banner.
2. **No self-signed while agents exist:** Switching TLS back to self-signed (`PUT /api/settings/tls` with `action: reset` → 409) is blocked when any agents exist. The UI disables the self-signed option in the TLS mode dropdown with a warning message.
3. **No revoke/remove of the active TLS cert:** Revoking or removing the certificate currently used for server TLS (`DELETE /api/certs/:id` → 409) is blocked. The UI disables the Revoke and Remove buttons on the TLS cert with tooltip explanations ("Switch TLS to a different certificate first"). The cert shows a "TLS" badge in the certificate list.
4. **No deploying the TLS cert to agents:** Creating or updating a deployment with the server's TLS certificate (`POST/PATCH deployments` → 400) is blocked. The UI excludes it from the deployment certificate dropdown entirely. This prevents agents from obtaining the server's private key, which would let them impersonate the server.

`GET /api/settings` returns `tls.serviceDomain`, `tls.serviceCertId`, and `agents.count` so the frontend can enforce all of these client-side as disabled states + messaging.

### Notifications

Notification configs are stored in `settings` as JSON values keyed by `notif_<channel>`. Each channel config includes an `enabled` flag, channel-specific connection details, and an `events` array.

- **Channels (7):** Email, Webhook, Pushover, Gotify, Slack, Discord, Telegram.
- **Certificate events:** `issued`, `renewed`, `expiry_warning`, `error`, `revoked`.
- **Agent events:** `agent_offline`, `agent_online`.
- **Routes:** `GET /api/notifications` returns all channel configs. `PUT /api/notifications/<channel>` saves a channel config. `POST /api/notifications/<channel>/test` sends a test notification (stub — sending not yet implemented).
- **Secrets are masked** in GET responses (e.g. `hasToken: true` instead of the raw token). On PUT, if a secret field is omitted, the existing value is preserved.
- **Event validation:** `validateEvents()` filters the events array to only known values. The `VALID_EVENTS` constant in `notifications.js` defines the valid set.

### Agents & Deployments

Agents are remote systems (e.g. a "certkeeper-agent" CLI) that pull certificates from CertKeeper. All agents use **mTLS** (mutual TLS) authentication with a one-time enrollment token for initial bootstrap.

- **Agents** represent a remote host. Creating an agent generates a one-time **enrollment token** (`cke_<64 hex>`, valid 1 hour). The agent exchanges the token + a locally-generated CSR at `POST /api/agent/enroll` to receive an agent certificate signed by CertKeeper's internal CA. After enrollment, all auth is via the agent certificate.
- **Internal CA** (`src/services/ca.js`) generates a 4096-bit RSA root CA on first use (stored in `data/ca/`). Signs agent CSRs with 45-day agent certificates (`AGENT_CERT_DAYS = 45`). Pure Node.js crypto — no openssl dependency. All ASN.1/DER encoding is hand-rolled.
- **Enrollment flow:** Agent generates key pair → creates CSR → `POST /api/agent/enroll` with Bearer token → receives signed cert + CA cert → enrollment token is burned.
- **Cert renewal:** Agent calls `POST /api/agent/renew-cert` (authenticated by current cert) with a new CSR → receives a fresh cert. The old fingerprint is preserved in `prev_cert_fingerprint` and both certs are accepted until the old one naturally expires. Fully automated.
- **Re-enrollment:** If an agent's cert expires (e.g. prolonged outage), the admin clicks "Re-enroll" to generate a new enrollment token. The agent re-registers with a fresh key pair. Deployments and all configuration are preserved.
- **HTTPS server** is configured with `requestCert: true, rejectUnauthorized: false` — requests agent certs but doesn't reject browsers without them. The internal CA cert is in the server's `ca` array so Node verifies agent certs.
- **Agent middleware** (`agentAuth.js`) extracts the agent cert fingerprint from the TLS socket, looks it up in the `agents` table (checking both `cert_fingerprint` and `prev_cert_fingerprint`), verifies the agent is enabled and the cert hasn't expired. Sets `req.agent` with the full agent row.
- **Deployments** tie an agent to a certificate. An agent can have many deployments. Each deployment has a name, references a certificate, and tracks `last_deployed_at` / `last_deployed_hash` so the agent knows when a cert has been renewed.
- **Admin routes** (`/api/agents`) are session-authed and provide full CRUD for agents and their deployments. Includes `GET /api/agents/ca-cert` for downloading the CA certificate.
- **Agent-facing routes** (`/api/agent`) are mTLS-authed:
  - `POST /api/agent/enroll` — enrollment-token-authed CSR signing (one-time bootstrap)
  - `POST /api/agent/renew-cert` — mTLS-authed cert renewal with dual-fingerprint grace period
  - `GET /api/agent/deployments` — returns the agent's deployments with cert metadata + `content_hash` (SHA-256 of fullchain.pem, truncated to 16 hex chars) so the agent can detect renewals without downloading.
  - `GET /api/agent/deployments/:id/bundle` — returns cert + key PEM files for a specific deployment; updates `last_deployed_at`/`last_deployed_hash`.
  - `POST /api/agent/heartbeat` — keepalive with config versioning. Returns deployment count, cert expiry, `heartbeat_interval` (seconds), `config_version`, and `actions` array (server→agent commands). Agent sends `{ config_version }` in request body to acknowledge settings.
  - `GET /api/agent/time` — unauthenticated server clock for agent time-skew detection.
- **Heartbeat monitoring:** Agents check in every `agent_heartbeat_interval` seconds (default 180 = 3 min, configurable in Settings → Agents). The server calculates `next_contact_at` on each heartbeat. A cron job (`agentMonitor.js`) runs every minute and flags agents as `offline` when `next_contact_at + (interval × threshold)` has passed. Default threshold: 3 missed heartbeats. State transitions (`agent_offline` / `agent_online`) are logged to audit_log and will trigger notifications when the notification service dispatch is implemented.
- **Config versioning:** A global `agent_config_version` integer (in `settings` table) is incremented when agent monitoring settings change. The heartbeat response includes the latest version; the agent acknowledges it in the next heartbeat request. The agents table stores each agent's acknowledged `config_version`. The UI shows a blue badge when an agent is online but hasn't picked up the latest config.
- **Actions:** Admins can queue actions for agents via `POST /api/agents/:id/actions`. Actions are stored in `pending_actions` (JSON array) on the agent row and delivered in the heartbeat response, then cleared. Supported actions: `renew_agent_cert` (force cert renewal), `update_agent` (stub for future self-update). Duplicate actions are not added.
- **Fingerprint collision handling:** Both enrollment and cert renewal check for SHA-256 fingerprint collisions against all other agents' `cert_fingerprint` and `prev_cert_fingerprint`. Returns 409 with `retry: true` on collision.
- **Frontend** — Agents page shows an expandable table: each agent row expands to reveal its deployments with inline add/enable/disable/delete controls. Agent creation generates an enrollment token shown once. Deployments are added via a separate modal with name + certificate dropdown. Status badges: green (online + current config), blue (online + stale config), red (offline), gray (unknown/not enrolled).

### Startup Sequence

1. Initialize database (SQLite), run migrations
2. Initialize encryption — ensure AES-256-GCM key exists, migrate plaintext secrets
3. Ensure admin user from env (if `ADMIN_USERNAME`/`ADMIN_PASSWORD` set)
4. Validate Cloudflare token from env (if set — exits on failure)
5. Check certbot availability (non-blocking warning if missing)
6. Recover certificates stuck in `issuing`/`renewing` from crash → mark as `error`
7. Load TLS credentials (self-signed / custom / managed)
8. Initialize internal CA for mTLS (`ensureCA()`)
9. Start HTTPS server with `requestCert: true` and CA in trust chain
10. Start renewal scheduler (node-cron)
11. Start agent monitor (node-cron, every 1 minute)
12. Start encryption key rotation cron (daily check, 30-day rotation)

## Guidelines

- Keep dependencies minimal — this is a zero-config, lightweight tool.
- No TypeScript, no bundlers, no frontend frameworks.
- All new env vars must be added to `config.js`, `.env.example`, and documented.
- Test with `LETSENCRYPT_STAGING=true` to avoid rate limits.
- Certbot must be installed on the host (or use Docker). The app checks at startup and warns if missing.
- `selfsigned` v5.5.0 quirks: `generate()` is async (returns Promise), ignores `days` option — use `notAfterDate` (Date object).
- The internal CA (`ca.js`) is pure Node.js crypto. All ASN.1/DER encoding is done manually. Do not add openssl as a dependency.
- Domains in the `certificates` table are stored as **space-separated strings** (e.g. `"example.com *.example.com"`). Routes split them into arrays for API responses: `cert.domains.split(' ')`.
- **Keep install infrastructure current.** When adding new env vars, changing paths, adding dependencies, or modifying the startup sequence, update the corresponding install files: `install/certkeeper.env`, `install/certkeeper.service`, `install/nfpm.yaml`, `install/postinstall.sh`, `install.sh`, `docs/installation.md`, and `docs/configuration.md`.

### Installation & Packaging

- **Install script** (`install.sh`): Detects distro, installs deps (Node.js, certbot), downloads `.deb`/`.rpm` from GitHub Releases (falls back to tarball), sets up systemd service. Supports `--uninstall` and `--yes` (non-interactive).
- **System packages** (`.deb`/`.rpm`): Built via nfpm (`install/nfpm.yaml`). Version comes from `package.json`. Packages include app code + `node_modules` at `/opt/certkeeper/`, systemd unit, and env file.
- **systemd unit** (`install/certkeeper.service`): Runs as root (certbot requirement), with `ProtectSystem=strict` and other hardening. Reads env from `/etc/certkeeper/certkeeper.env`.
- **System user:** `certkeeper` (no-login) — owns data/log/config dirs. Service runs as root but dirs are `root:certkeeper` for group read.
- **System paths:** App at `/opt/certkeeper/`, data at `/var/lib/certkeeper/`, logs at `/var/log/certkeeper/`, config at `/etc/certkeeper/`, certs at `/etc/letsencrypt/`.
- **Docker image:** Published to GHCR via `.github/workflows/docker-publish.yml`. Tagged `latest` + `v{version}` on main, `dev` + `v{version}-dev` on other branches.
- **Release packages:** Built via `.github/workflows/release.yml` on GitHub Release publish. Produces `.deb`, `.rpm`, and `.tar.gz` for amd64 and arm64.
- **Certbot conflict detection:** Install script and postinstall check for active `certbot.timer` and `/etc/cron.d/certbot`, warn and offer to disable.
