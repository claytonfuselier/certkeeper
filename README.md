# 🔒 CertKeeper
[![Version](https://img.shields.io/github/package-json/v/claytonfuselier/certkeeper)](#)
[![License](https://img.shields.io/github/license/claytonfuselier/certkeeper)](#)
[![Last Commit](https://img.shields.io/github/last-commit/claytonfuselier/certkeeper)](#)
[![Node](https://img.shields.io/badge/node-24%2B-green)](https://nodejs.org/)
[![Express](https://img.shields.io/github/package-json/dependency-version/claytonfuselier/certkeeper/express)](#)

A lightweight, self-hosted Let's Encrypt certificate manager with a web UI.  
Supports **HTTP-01** and **DNS-01** (Cloudflare) challenge types, including **wildcard certificates**.

<br>

## Features

- **Zero-config startup** — no `.env` file required; configure everything through the first-run setup screen
- **HTTPS by default** — auto-generates a self-signed TLS certificate on first run; upgrade to a managed Let's Encrypt cert or upload your own PEM files
- **Multi-domain & wildcard certificates** via Let's Encrypt
- **HTTP-01** (standalone) and **DNS-01** (Cloudflare API) challenge support
- **Web dashboard** — issue, renew, revoke, and monitor certificates
- **Agent system** — token-authenticated agents with deployments pull certificates from CertKeeper for distribution to remote hosts
- **Smart automatic renewal** — randomized twice-weekly schedule (configurable), with managed TLS cert auto-sync
- **SQLite storage** — zero external dependencies, no database server needed
- **File logging** with automatic rotation (5 MB × 5 files)
- **Runs natively** or in **Docker**

<br>

## Quick Start

### Prerequisites

| Native | Docker |
|--------|--------|
| Node.js 24+ | Docker & Docker Compose |
| certbot + certbot-dns-cloudflare | _(included in image)_ |

### 1. Clone & install

```bash
git clone https://github.com/your-user/certkeeper.git
cd certkeeper
npm install
```

**That's it.** No `.env` file is needed — the app works out of the box. On first visit you'll create an admin account and configure settings through the web UI.

### 2a. Run natively

```bash
sudo npm start
```

> **Root is required.** certbot needs write access to `/etc/letsencrypt` and may need to bind port 80 for HTTP-01 challenges. The app will exit with an error if not run as root.

Open `https://localhost:3000` — you'll be guided through initial setup (admin account, registration email, etc.).

> The server uses HTTPS with an auto-generated self-signed certificate. Your browser will show a security warning — this is expected. You can upgrade to a trusted certificate later via the TLS settings.

### 2b. Run with Docker

```bash
docker compose up -d
```

This builds the image and starts the container. Data is persisted via bind mounts into the project directory:

| Host Path | Container Path | Purpose |
|-----------|----------------|---------|
| `./letsencrypt/` | `/etc/letsencrypt` | Certificate files |
| `./data/` | `/app/data` | SQLite database, session secret, Cloudflare config |
| `./logs/` | `/app/logs` | Application and certbot logs |

To rebuild after code changes:

```bash
docker compose up -d --build
```

### Optional: environment overrides

All settings have built-in defaults and can be managed through the web UI. To override any default at the environment level, create a `.env` file (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `production` | Node environment |
| `USE_HTTP` | `false` | Disable HTTPS and run plain HTTP — for use behind a reverse proxy, Codespaces, etc. |
| `SESSION_SECRET` | *(auto-generated)* | Session encryption key — auto-generated and persisted to `./data/.session-secret` if not set |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | *(web UI setup)* | If set, overrides DB credentials and disables password changes in the UI |
| `LETSENCRYPT_EMAIL` | *(web UI)* | Registration email — if set, overrides the UI value |
| `LETSENCRYPT_STAGING` | `false` | Use Let's Encrypt staging server for testing |
| `CLOUDFLARE_API_TOKEN` | *(web UI)* | If set, overrides the UI value and is validated against the Cloudflare API |
| `RENEWAL_CRON` | *(random)* | Cron expression for auto-renewal — if unset, a random twice-weekly early-morning schedule is generated and persisted |
| `LOG_DIR` | `./logs` | Application and certbot log directory |
| `CERTBOT_CONFIG_DIR` | `/etc/letsencrypt` | Certbot config root |
| `CERTBOT_WORK_DIR` | `/var/lib/letsencrypt` | Certbot working directory |
| `DATA_DIR` | `./data` | App data directory (SQLite DB, session secret) |

When running in Docker, uncomment the `env_file` lines in `docker-compose.yml` to load your `.env`.

<br>

## Architecture

```
certkeeper/
├── public/                  # Frontend (vanilla HTML/CSS/JS)
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── src/
│   ├── index.js             # Express server entry point
│   ├── config.js            # Environment config with defaults
│   ├── db.js                # SQLite schema & connection
│   ├── logger.js            # Winston logger with file rotation
│   ├── middleware/
│   │   ├── auth.js          # Session auth middleware
│   │   ├── agentAuth.js     # Bearer token auth for agent API
│   │   └── sessionStore.js  # SQLite-backed session store
│   ├── routes/
│   │   ├── auth.js          # Login / logout / setup / password
│   │   ├── certs.js         # Certificate CRUD + async issue/renew
│   │   ├── dashboard.js     # Dashboard stats
│   │   ├── settings.js      # Email, Cloudflare, TLS & schedule management
│   │   ├── agents.js        # Admin CRUD for agents + deployments (session-authed)
│   │   └── agent-api.js     # Agent-facing API — deployments, bundles, heartbeat (token-authed)
│   └── services/
│       ├── certbot.js       # Certbot CLI wrapper with error classification
│       ├── cloudflare.js    # Cloudflare API token validation
│       ├── scheduler.js     # Randomized twice-weekly auto-renewal
│       └── tls.js           # HTTPS cert management (self-signed / custom / managed)
├── Dockerfile               # Multi-stage: Node 24 deps → Python 3.13/certbot runtime
├── docker-compose.yml
├── .env.example
└── package.json
```

### How it works

1. The Express server starts over **HTTPS** — on first run it auto-generates a self-signed TLS certificate.
   - This can be modified in settings: select a managed Let's Encrypt cert (automatically imported when renewed) or upload custom PEM files manually.
2. On first visit, a setup screen guides you through admin account creation and registration email (required for Let's Encrypt), unless defined with environment varaiables.
3. When you request a certificate, the backend spawns `certbot certonly` as an async child process — the UI polls for completion.
4. For **HTTP-01**, certbot runs in standalone mode (needs port 80).
5. For **DNS-01**, certbot uses the Cloudflare plugin with your API token.
6. Certificate metadata and status are tracked in SQLite for the dashboard.
7. A randomized twice-weekly cron schedule (two early-morning runs, 3 days apart) runs `certbot renew` to keep certificates fresh. The schedule is persisted in the database and can be customised in the UI or overridden via `RENEWAL_CRON`.
8.  If the process crashes while a certificate is being issued/renewed, operations are automatically recovered on the next startup.

<br>

## API Reference

All API routes are prefixed with `/api`. Authenticated routes require a valid session.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/auth/login` | No | Log in |
| `POST` | `/api/auth/logout` | No | Log out |
| `GET` | `/api/auth/me` | No | Get current user / setup status |
| `POST` | `/api/auth/setup` | No | First-run setup (create admin + email) |
| `POST` | `/api/auth/password` | Yes | Change password |
| `GET` | `/api/dashboard` | Yes | Dashboard stats |
| `GET` | `/api/certs` | Yes | List all certificates |
| `GET` | `/api/certs/:id` | Yes | Get certificate details |
| `POST` | `/api/certs` | Yes | Request new certificate (async — returns 202) |
| `POST` | `/api/certs/:id/renew` | Yes | Force renew a certificate (async — returns 202) |
| `PATCH` | `/api/certs/:id` | Yes | Update cert settings |
| `DELETE` | `/api/certs/:id` | Yes | Revoke & delete a certificate |
| `POST` | `/api/certs/sync` | Yes | Sync DB with certbot on disk |
| `GET` | `/api/settings` | Yes | Get current settings, overrides & system status |
| `PUT` | `/api/settings/email` | Yes | Update Let's Encrypt registration email |
| `PUT` | `/api/settings/cloudflare` | Yes | Update & validate Cloudflare API token |
| `PUT` | `/api/settings/tls` | Yes | Upload custom TLS cert/key or select a managed cert |
| `GET` | `/api/settings/tls/managed` | Yes | List managed certs available for TLS |
| `GET` | `/api/settings/schedule` | Yes | Get current renewal schedule |
| `PUT` | `/api/settings/schedule` | Yes | Update renewal schedule (days & times) |
| `GET` | `/api/agents` | Yes | List all agents with deployments |
| `GET` | `/api/agents/:id` | Yes | Get agent detail |
| `POST` | `/api/agents` | Yes | Create agent (returns token once) |
| `PATCH` | `/api/agents/:id` | Yes | Update agent name or enabled state |
| `DELETE` | `/api/agents/:id` | Yes | Delete agent + all its deployments |
| `POST` | `/api/agents/:id/regenerate-token` | Yes | Regenerate agent token |
| `GET` | `/api/agents/:id/deployments` | Yes | List deployments for an agent |
| `POST` | `/api/agents/:id/deployments` | Yes | Add a deployment to an agent |
| `PATCH` | `/api/agents/:agentId/deployments/:depId` | Yes | Update deployment (enable/disable) |
| `DELETE` | `/api/agents/:agentId/deployments/:depId` | Yes | Delete a deployment |
| `GET` | `/api/agent/deployments` | Token | List this agent's deployments + cert metadata |
| `GET` | `/api/agent/deployments/:id/bundle` | Token | Download cert + key PEM bundle for a deployment |
| `POST` | `/api/agent/heartbeat` | Token | Agent keepalive / check-in |

### Request a certificate

```json
POST /api/certs
{
  "domains": ["example.com", "*.example.com"],
  "challengeType": "dns-01"
}
```

Returns `202 Accepted` — poll `GET /api/certs/:id` until `status` changes from `issuing` to `valid` or `error`.

<br>

## Agents & Deployments

CertKeeper includes an **agent system** for distributing certificates to remote hosts. A future `certkeeper-agent` CLI will connect to CertKeeper, discover its deployments, and pull certificate bundles.

### Concepts

| Term | Description |
|------|-------------|
| **Agent** | Represents a remote host. Creates a bearer token (`ck_<64 hex>`) shown once at creation. |
| **Deployment** | Ties an agent to a certificate. An agent can have many deployments. Each tracks `last_deployed_at` and `last_deployed_hash` to detect renewals. |

### Admin workflow

1. Create an agent in **Agents** → copy the generated token.
2. Expand the agent row and click **Add Deployment** — pick a name and a certificate.
3. Install the token on the remote host. When the agent connects, it calls `GET /api/agent/deployments` to discover its work.

### Agent-facing API (token-authed)

All agent endpoints require `Authorization: Bearer ck_...`.

| Endpoint | Description |
|----------|-------------|
| `GET /api/agent/deployments` | Returns deployments with cert metadata and a `content_hash` (SHA-256 of `fullchain.pem`, 16 hex chars). The agent compares this to its local hash to detect renewals without downloading. |
| `GET /api/agent/deployments/:id/bundle` | Returns `fullchain`, `cert`, and `key` PEM contents. Updates `last_deployed_at` / `last_deployed_hash`. |
| `POST /api/agent/heartbeat` | Keepalive — returns agent info and deployment count. |

<br>

## Cloudflare API Token

For DNS-01 challenges, create a Cloudflare API token with these permissions:

1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Create a token with **Zone → DNS → Edit** permission
3. Scope it to the zones you need
4. Add the token in **Settings → Cloudflare API Token** in the web UI, or set `CLOUDFLARE_API_TOKEN` in `.env`

The token is validated against the Cloudflare API when saved.

<br>

## TLS / HTTPS

The server always runs over HTTPS. On first start, a **self-signed certificate** is generated automatically into `./data/tls/`. You can upgrade it in three ways:

| Method | How |
|--------|-----|
| **Managed cert** | Issue a certificate through the dashboard, then select it in **Settings → TLS** — the server copies the cert files and uses them for HTTPS. When the cert is renewed, the files are automatically refreshed. |
| **Custom PEM upload** | Upload your own `cert.pem` + `key.pem` in **Settings → TLS**. |
| **Self-signed (default)** | No action needed — auto-generated and auto-renewed every 14 days. |

TLS certificate files are stored in `./data/tls/` and persisted via the `./data/` bind mount in Docker.

<br>

## Logging

All logs are written to `./logs/` (configurable via `LOG_DIR`):

- **`app.log`** — application logs (auto-rotated: 5 MB × 5 files)
- **certbot output** — certbot logs are directed to the same directory

Logs are also printed to the console (stdout).

<br>

## Development

```bash
npm install
# Optionally create .env with LETSENCRYPT_STAGING=true for testing
npm run dev     # Uses --watch for auto-restart
```

<br>

## License
This project is open source and available under the [MIT License](LICENSE).