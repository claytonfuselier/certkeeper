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
│   └── sessionStore.js  # SQLite-backed express-session store
├── routes/
│   ├── auth.js          # Login, logout, first-run setup, password change
│   ├── certs.js         # Certificate CRUD, async issue/renew, retry, revoke
│   ├── dashboard.js     # Stats endpoint
│   └── settings.js      # Email, Cloudflare, TLS, schedule management
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

## Guidelines

- Keep dependencies minimal — this is a zero-config, lightweight tool.
- No TypeScript, no bundlers, no frontend frameworks.
- All new env vars must be added to `config.js`, `.env.example`, and the README env table.
- Test with `LETSENCRYPT_STAGING=true` to avoid rate limits.
- Certbot must be installed on the host (or use Docker). The app checks at startup and warns if missing.
- `selfsigned` v5.5.0 quirks: `generate()` is async (returns Promise), ignores `days` option — use `notAfterDate` (Date object).
