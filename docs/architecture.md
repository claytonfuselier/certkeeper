# Architecture

Technical reference for CertKeeper's internal structure, database schema, and design patterns.

---

## Directory Structure

```
src/
├── index.js              Entry point — HTTPS server with mTLS, startup sequence
├── config.js             Centralized config from env vars with defaults
├── db.js                 sql.js wrapper with synchronous-style API (run/get/all)
├── logger.js             Winston setup with file rotation
├── middleware/
│   ├── auth.js           requireAuth session middleware
│   ├── agentAuth.js      mTLS agent certificate auth + enrollment token auth
│   └── sessionStore.js   SQLite-backed express-session store
├── routes/
│   ├── auth.js           Login, logout, first-run setup, password change
│   ├── certs.js          Certificate CRUD, async issue/renew, retry, revoke
│   ├── dashboard.js      Stats endpoint
│   ├── notifications.js  Notification channel CRUD (7 channels, per-event toggles)
│   ├── settings.js       Email, Cloudflare, TLS, schedule, agent monitoring settings
│   ├── agents.js         Admin CRUD for agents + nested deployment CRUD (session-authed)
│   └── agent-api.js      Agent-facing API — enroll, renew-cert, heartbeat, deployments (mTLS-authed)
└── services/
    ├── ca.js             Internal Certificate Authority (RSA 4096, pure Node.js crypto)
    ├── certbot.js        Certbot CLI wrapper (child_process) with error classification
    ├── cloudflare.js     CF API token validation
    ├── scheduler.js      Randomized twice-weekly renewal cron
    ├── agentMonitor.js   Agent liveness cron (every 1 min, offline detection)
    └── tls.js            HTTPS cert management (self-signed / custom / managed)

public/
├── index.html            Single-page app (all views in one file)
├── css/style.css         Dark-theme styles, CSS variables
└── js/                   ES modules (no build step)
    ├── app.js            Entry point — imports all modules, registers routes, boots app
    ├── router.js         pushState router with auth guards and route lifecycle
    ├── api.js            Centralized fetch wrapper with 401 redirect
    ├── dom.js            Shared DOM utilities ($, toast, escapeHtml, formatDate, etc.)
    ├── state.js          Global TLS/agent state management
    ├── auth.js           Login, setup, logout, session check
    ├── dashboard.js      Dashboard stats and audit log
    ├── certs.js          Certificate CRUD, polling, new-cert form
    ├── agents.js         Agents table, deployments, modals, TLS safety guards
    ├── notifications.js  Notification channel tabs (7 channels), per-event toggles
    └── settings.js       Settings tabs (status, Let's Encrypt, Cloudflare, TLS, agents, password)

data/                     Runtime data (created automatically)
├── certkeeper.db         SQLite database file
├── .session-secret       Auto-generated session signing key
├── tls/                  Server TLS certificates
│   ├── cert.pem
│   └── key.pem
├── ca/                   Internal CA for mTLS
│   ├── ca-cert.pem
│   └── ca-key.pem
└── cloudflare.ini        Certbot DNS plugin credentials
```

---

## Database

CertKeeper uses **sql.js** — a WebAssembly build of SQLite that runs entirely in-process with no native bindings. The database loads into memory at startup and persists to disk with a **500ms debounced write** after every mutation.

### Access Pattern

```js
const { getDb } = require('./db');
const db = getDb();

db.run('INSERT INTO audit_log (action, details) VALUES (?, ?)', ['cert_request', JSON.stringify(data)]);
const cert = db.get('SELECT * FROM certificates WHERE id = ?', [id]);
const all = db.all('SELECT * FROM certificates ORDER BY created_at DESC');
db.exec('PRAGMA foreign_keys = ON;'); // DDL / multi-statement
```

- `run(sql, params)` — returns `{ changes, lastInsertRowid }`
- `get(sql, params)` — returns first row as object, or `undefined`
- `all(sql, params)` — returns array of row objects
- `exec(sql)` — executes raw SQL (DDL, multi-statement)

All methods are synchronous (in-memory). Writes trigger a debounced `_scheduleSave()` that flushes to `data/certkeeper.db` after 500ms of inactivity.

### Schema

#### `users`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | Primary key, autoincrement |
| `username` | TEXT | Unique, NOT NULL, min 3 chars |
| `password` | TEXT | bcrypt hash |
| `created_at` | TEXT | `datetime('now')` |
| `updated_at` | TEXT | `datetime('now')` |

#### `certificates`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | Primary key, autoincrement |
| `domains` | TEXT | **Space-separated** (e.g. `"example.com *.example.com"`) |
| `status` | TEXT | `pending`, `issuing`, `renewing`, `active`, `expired`, `revoked`, `error` |
| `issued_at` | TEXT | Timestamp |
| `expires_at` | TEXT | Timestamp |
| `last_renewed_at` | TEXT | Timestamp |
| `auto_renew` | INTEGER | 1 (enabled) or 0 |
| `certbot_name` | TEXT | Certbot certificate name for CLI operations |
| `staging` | INTEGER | 1 if issued against Let's Encrypt staging, 0 for production |
| `error_message` | TEXT | JSON string `{ title, detail, link }` for structured errors |
| `created_at` | TEXT | `datetime('now')` |
| `updated_at` | TEXT | `datetime('now')` |

> Domains are stored space-separated in the DB. API responses split them into arrays: `cert.domains.split(' ')`.

#### `settings`
| Column | Type | Notes |
|--------|------|-------|
| `key` | TEXT | Primary key |
| `value` | TEXT | String or JSON |
| `updated_at` | TEXT | `datetime('now')` |

Key settings values:
- `letsencrypt_email` — Let's Encrypt registration email
- `cloudflare_api_token` — Cloudflare API token (plaintext)
- `tls_managed_domain` — domain of managed cert (TLS source is detected from files on disk, not stored)
- `renewal_schedule` — renewal schedule as JSON (contains day1/day2 specs)
- `agent_heartbeat_interval` — seconds (default `180`)
- `agent_offline_threshold` — missed heartbeats (default `3`)
- `agent_config_version` — global integer, incremented on settings change
- `notif_<channel>` — JSON notification channel config (e.g. `notif_email`, `notif_slack`)

#### `agents`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | Primary key, autoincrement |
| `name` | TEXT | Human-readable label |
| `enrollment_token_hash` | TEXT | bcrypt hash of one-time enrollment token |
| `enrollment_expires_at` | TEXT | Token TTL (1 hour from generation) |
| `cert_fingerprint` | TEXT | SHA-256 of current agent cert, **UNIQUE** |
| `cert_expires_at` | TEXT | Current cert expiry |
| `prev_cert_fingerprint` | TEXT | Previous cert fingerprint, **UNIQUE** (grace period) |
| `prev_cert_expires_at` | TEXT | Previous cert expiry |
| `cert_serial` | INTEGER | Monotonically increasing serial number |
| `enabled` | INTEGER | 1 (active) or 0 (disabled) |
| `status` | TEXT | `online`, `offline`, or NULL (unknown/not enrolled) |
| `next_contact_at` | TEXT | Expected next heartbeat deadline |
| `config_version` | INTEGER | Last acknowledged config version |
| `pending_actions` | TEXT | JSON array of queued actions |
| `last_contact_at` | TEXT | Last heartbeat timestamp |
| `last_contact_ip` | TEXT | Last known IP address |
| `created_at` | TEXT | `datetime('now')` |
| `updated_at` | TEXT | `datetime('now')` |

The `cert_fingerprint` and `prev_cert_fingerprint` columns are both UNIQUE. During cert renewal, the old fingerprint moves to `prev_cert_fingerprint` so both the old and new certs are accepted until the old one naturally expires.

#### `deployments`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | Primary key, autoincrement |
| `agent_id` | INTEGER | FK → `agents(id)` ON DELETE CASCADE |
| `certificate_id` | INTEGER | FK → `certificates(id)` ON DELETE CASCADE |
| `name` | TEXT | Deployment label (e.g. `nginx-proxy`) |
| `enabled` | INTEGER | 1 or 0 |
| `last_deployed_at` | TEXT | When the bundle was last downloaded |
| `last_deployed_hash` | TEXT | SHA-256 hash of last downloaded fullchain.pem (16 hex chars) |
| `created_at` | TEXT | `datetime('now')` |
| `updated_at` | TEXT | `datetime('now')` |

#### `audit_log`
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | Primary key, autoincrement |
| `action` | TEXT | Action identifier (e.g. `cert_request`, `cert_renewed`, `agent_online`) |
| `details` | TEXT | JSON string with contextual data |
| `created_at` | TEXT | `datetime('now')` |

#### `sessions`
| Column | Type | Notes |
|--------|------|-------|
| `sid` | TEXT | Primary key, session ID |
| `sess` | TEXT | Serialized session data |
| `expired` | TEXT | Expiry timestamp |

### Migrations

Migrations run inline in `db.js` during `initDatabase()`. Each migration inspects the current table DDL and applies changes only if needed:

1. **Certificate status migration** — recreates the `certificates` table with `issuing`/`renewing` in the CHECK constraint
2. **Staging column** — adds `staging INTEGER` column
3. **Legacy cleanup** — drops old `agent_cert_scopes` table if present
4. **Agent mTLS columns** — adds enrollment, fingerprint, and serial columns
5. **Dual fingerprint** — adds `prev_cert_fingerprint` / `prev_cert_expires_at`
6. **Heartbeat columns** — adds `status`, `next_contact_at`, `config_version`, `pending_actions`
7. **Agent settings seed** — inserts default `agent_heartbeat_interval`, `agent_offline_threshold`, `agent_config_version` into `settings`

---

## Startup Sequence

Defined in `src/index.js` `start()`:

1. **Initialize database** — load or create SQLite, run all migrations
2. **Ensure admin user** — if `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars are set, create or sync the admin account
3. **Validate Cloudflare token** — if `CLOUDFLARE_API_TOKEN` env is set, validate against the CF API; exit on failure
4. **Check certbot** — `execFile('certbot', ['--version'])`, warn (non-blocking) if not found
5. **Recover stuck certs** — any certificates in `issuing`/`renewing` status from a prior crash → mark as `error`
6. **Load TLS credentials** — self-signed (generated via `selfsigned` package), custom PEM, or managed Let's Encrypt cert
7. **Initialize internal CA** — `ensureCA()` generates or loads the RSA 4096-bit root CA from `data/ca/`
8. **Start HTTPS server** — `requestCert: true, rejectUnauthorized: false` with the internal CA cert in the trust chain
9. **Start renewal scheduler** — two node-cron tasks (randomized twice-weekly)
10. **Start agent monitor** — node-cron task every 1 minute

---

## Key Design Patterns

### Async Certbot Operations

Certificate issuance and renewal are long-running operations (certbot spawns a child process). Routes return **HTTP 202** immediately with the certificate in `issuing`/`renewing` status. The frontend polls `GET /api/certs/:id` until the status changes.

```
POST /api/certs → inserts row (status: issuing) → spawns certbot → returns 202
                                                    ↓
                                       (certbot completes)
                                                    ↓
                                     updates row: status → active / error
```

### Debounced Database Persistence

sql.js runs entirely in memory. On every `run()` or `exec()` call, a 500ms debounce timer starts. When the timer fires, the full database is exported with `db.export()` and written to disk. This avoids excessive I/O during burst writes while ensuring data survives crashes (max 500ms data loss).

### mTLS Agent Authentication

The HTTPS server is configured with `requestCert: true` but `rejectUnauthorized: false`. This allows browser users (no agent cert) and agents (with agent cert signed by the internal CA) to use the same server.

The `agentAuth.js` middleware:
1. Extracts the agent certificate from the TLS socket (`req.socket.getPeerCertificate()`)
2. Verifies the cert was issued by the internal CA (`authorized` flag from Node.js TLS)
3. Computes the SHA-256 fingerprint
4. Looks up the agent by `cert_fingerprint` or `prev_cert_fingerprint`
5. Checks the agent is `enabled` and the cert hasn't expired
6. Sets `req.agent` with the full agent row

### Dual Fingerprint Grace Period

When an agent renews its agent certificate:
- The new fingerprint goes into `cert_fingerprint`
- The old fingerprint moves to `prev_cert_fingerprint`
- Both are accepted for authentication
- When `prev_cert_expires_at` passes, the old cert is naturally rejected

This prevents connection errors during the renewal window.

### Config Versioning

Agent monitoring settings have a global `agent_config_version` integer stored in `settings`. When settings change:
1. The version is incremented
2. The heartbeat response includes the new version
3. The agent acknowledges the version in its next heartbeat request body
4. The UI shows a badge when an agent's `config_version` < the global version

### Fingerprint Collision Handling

SHA-256 fingerprint collisions are astronomically unlikely but handled defensively. Both enrollment and cert renewal check the incoming fingerprint against all agents' `cert_fingerprint` and `prev_cert_fingerprint` columns. A collision returns 409 with `{ retry: true }`, instructing the agent to regenerate its key pair and try again.

---

## Certificate Lifecycle

```
 ┌───────────────────────────────────────────────────┐
 │                Certificate States                  │
 │                                                    │
 │  POST /api/certs                                   │
 │       │                                            │
 │       ▼                                            │
 │   ┌─────────┐  certbot ok   ┌────────┐            │
 │   │ issuing │──────────────▶│ active │◀─┐         │
 │   └────┬────┘               └───┬────┘  │         │
 │        │ certbot fail           │       │         │
 │        ▼                        │ renew │         │
 │   ┌─────────┐               ┌───┴──────┐│         │
 │   │  error  │               │ renewing ├┘         │
 │   └─────────┘               └──────────┘          │
 │                                 │                  │
 │                          DELETE ?action=            │
 │                          ┌──────┴──────┐           │
 │                          ▼             ▼           │
 │                     ┌─────────┐   (removed         │
 │                     │ revoked │    from DB)         │
 │                     └─────────┘                    │
 └───────────────────────────────────────────────────┘
```

**Statuses:** `pending`, `issuing`, `renewing`, `active`, `expired`, `revoked`, `error`

---

## TLS Modes

The server's own HTTPS certificate can come from three sources:

| Mode | Source | Behavior |
|------|--------|----------|
| **Self-signed** | `selfsigned` npm package | Default. Auto-generated on first start, stored in `data/tls/`. Auto-renewed when expired. |
| **Custom PEM** | User upload via Settings UI | Cert + key PEM files uploaded and stored in `data/tls/`. |
| **Managed** | A CertKeeper-managed Let's Encrypt cert | Certs copied from certbot's live directory to `data/tls/`. Auto-refreshed on renewal. |

After changing TLS settings, the server requires a restart for the new certificate to take effect.

---

## Renewal Schedule

The auto-renewal scheduler runs twice weekly on two different days:

- **Default:** Two days are randomly selected at startup (3+ days apart), with random early-morning hours
- **Override:** The `RENEWAL_CRON` env var replaces the default with a single cron expression
- **Database:** Schedule is persisted in the `settings` table so it survives restarts

Two independent `node-cron` tasks are registered (one per day). `renewAll()` runs `certbot renew`, parses the output to detect actual renewals, and only syncs DB / refreshes TLS when something changed.

---

## Internal CA

The internal CA (`src/services/ca.js`) provides mTLS agent certificates for agent authentication:

- **Key type:** RSA 4096-bit
- **CA lifetime:** 10-year self-signed root
- **Agent cert lifetime:** 45 days (`AGENT_CERT_DAYS = 45`)
- **Storage:** `data/ca/ca-cert.pem` and `data/ca/ca-key.pem`
- **Implementation:** Pure Node.js `crypto` module — all ASN.1/DER encoding is hand-rolled, no openssl dependency
- **CSR processing:** Agents generate their own key pairs and submit CSRs; the CA signs them and returns the certificate

---

## Agent Monitor

A `node-cron` job runs every minute (`agentMonitor.js`):

1. Queries all agents where `status = 'online'` and `next_contact_at` is set
2. Calculates the deadline: `next_contact_at + (heartbeat_interval × offline_threshold)`
3. If the deadline has passed, marks the agent as `offline`
4. Logs state transitions to `audit_log` (entries like `agent_offline`)
5. Will trigger notification dispatch when the notification service is fully implemented

---

## Frontend Architecture

### Stack
- Vanilla HTML/CSS/JS — no framework, no build step
- Single `index.html` SPA with `<div>` page containers for each view
- ES modules (`<script type="module">`) split across 11 files in `public/js/`
- Path-based routing via `history.pushState()` with `popstate` listener
- Dark theme via CSS custom properties

### Key Patterns
- **`api(method, url, body)`** — central fetch wrapper (`api.js`), throws on non-2xx, redirects to `/login` on 401
- **`toast(msg, type)`** — notification toasts (`dom.js`)
- **Router** — `router.js` with auth guards, `init`/`load`/`leave` lifecycle per module, `<a href>` click interception
- **State** — `state.js` manages global TLS/agent state with getters, setters, and `refreshTlsState()`
- **Settings tabs** — 6 tabs (`Status`, `Let's Encrypt`, `Cloudflare API`, `TLS`, `Agents`, `Change Password`) using CSS `.settings-pane.active`
- **Notifications** — separate page at `/notifications` with 7 channel sub-tabs, deep-linkable via `/notifications/:channel`
- **Agent table** — expandable rows with inline deployment management
- **Polling** — certificate issuance/renewal uses polling with `GET /api/certs`, stopped via `leave()` lifecycle hook
