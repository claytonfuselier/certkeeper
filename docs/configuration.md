# Configuration

All configuration is optional. CertKeeper works out of the box with no `.env` file and no environment variables — everything can be configured through the web UI.

---

## Environment Variables

Set these in a `.env` file in the project root, or pass them as environment variables. Every variable has a built-in default.

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTPS server port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `production` | Node.js environment |
| `SESSION_SECRET` | *(auto-generated)* | Session signing key. If not set, a cryptographically random value is generated and stored in `data/.session-secret`. Only set this if you need a specific value (e.g. shared across multiple instances). |

### Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_USERNAME` | *(none)* | Admin username. If omitted, you create an account on first visit via the setup wizard. |
| `ADMIN_PASSWORD` | *(none)* | Admin password. If set via env, password changes are disabled in the UI. |

If either `ADMIN_USERNAME` or `ADMIN_PASSWORD` is set, both must be set. The env password is synced to the database on every startup, so changing the env var and restarting updates the password.

### Let's Encrypt

| Variable | Default | Description |
|----------|---------|-------------|
| `LETSENCRYPT_EMAIL` | *(none)* | Registration email. If omitted, set via the web UI. If set via env, the UI field is read-only. |
| `LETSENCRYPT_STAGING` | `false` | Set to `true` to use the Let's Encrypt staging server (avoids rate limits during testing). |

### Cloudflare

| Variable | Default | Description |
|----------|---------|-------------|
| `CLOUDFLARE_API_TOKEN` | *(none)* | API token for DNS-01 challenges. Can also be set in Settings → Cloudflare API. If set via env, it takes priority over the database value. Validated against the Cloudflare API at startup — the app exits if invalid. |

#### Creating a Cloudflare API Token

CertKeeper requires a scoped API **token** (not the legacy global API key) with permission to edit DNS records.

1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token**
3. Use the **Edit zone DNS** template, or create a custom token with:
   - **Permissions:** Zone → DNS → Edit
   - **Zone Resources:** Include → Specific zone (or All zones)
4. Copy the token and enter it in CertKeeper (Settings → Cloudflare API) or set `CLOUDFLARE_API_TOKEN` in your environment

For detailed steps, see the [Cloudflare documentation on creating API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/).

### Paths

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `./data` | Application data directory (database, TLS certs, CA, cloudflare.ini) |
| `LOG_DIR` | `./logs` | Log directory for app logs and certbot logs |
| `CERTBOT_CONFIG_DIR` | `/etc/letsencrypt` | Where certbot reads/writes certificate data |
| `CERTBOT_WORK_DIR` | `/var/lib/letsencrypt` | Certbot working directory |

---

## Docker

### Quick Start

```yaml
# docker-compose.yml
services:
  certkeeper:
    build: .
    container_name: certkeeper
    restart: unless-stopped
    ports:
      - "3000:3000"    # HTTPS web UI
    volumes:
      - ./letsencrypt:/etc/letsencrypt
      - ./data:/app/data
      - ./logs:/app/logs
    environment:
      - NODE_ENV=production
```

```bash
docker compose up -d
```

Open `https://localhost:3000` to run the setup wizard.

### Build Details

The Dockerfile uses a **multi-stage build**:

1. **Stage 1** (`node:24-alpine`) — installs Node.js dependencies with `npm ci --omit=dev`
2. **Stage 2** (`python:3.13-alpine`) — final image with certbot, the Cloudflare DNS plugin, Node.js runtime, and `tini` as PID 1

The final image includes:
- Node.js (from Alpine packages)
- Python 3.13 + certbot + certbot-dns-cloudflare
- tini (for proper signal handling)

### Volumes

| Mount | Container Path | Purpose |
|-------|----------------|---------|
| `./letsencrypt` | `/etc/letsencrypt` | Certbot certificate storage |
| `./data` | `/app/data` | SQLite database, internal CA, TLS certs, session secret |
| `./logs` | `/app/logs` | Application logs and certbot logs |

### Ports

| Port | Purpose |
|------|---------|
| `3000` | HTTPS web UI and agent API |

### Using a `.env` File

Uncomment the `env_file` section in `docker-compose.yml`:

```yaml
    env_file:
      - .env
```

Or pass individual variables in the `environment` block:

```yaml
    environment:
      - NODE_ENV=production
      - LETSENCRYPT_EMAIL=you@example.com
      - LETSENCRYPT_STAGING=true
```

---

## Native (No Docker)

### Install Script (recommended)

The easiest way to install natively. See the [Installation Guide](installation.md) for full details.

```bash
curl -fsSL https://raw.githubusercontent.com/claytonfuselier/certkeeper/main/install.sh | sudo bash
```

After installation, configure via `/etc/certkeeper/certkeeper.env` and manage with `systemctl`.

### Prerequisites (manual install)
- **Node.js 24+**
- **certbot** installed and in PATH ([install guide](https://certbot.eff.org/instructions))
- For DNS-01 challenges: `certbot-dns-cloudflare` plugin
- **Root access** — certbot needs write access to `/etc/letsencrypt`

### Setup

```bash
git clone https://github.com/claytonfuselier/certkeeper.git
cd certkeeper
npm install --omit=dev
sudo node src/index.js
```

### Directory Layout

After first run (manual/dev install from git clone):
```
certkeeper/
├── data/
│   ├── certkeeper.db        # SQLite database
│   ├── .session-secret       # Auto-generated session key
│   ├── .encryption-key       # AES-256-GCM key for secrets at rest
│   ├── tls/                  # Server HTTPS certificate
│   │   ├── cert.pem
│   │   └── key.pem
│   ├── ca/                   # Internal CA for mTLS
│   │   ├── ca-cert.pem
│   │   ├── ca-key.pem
│   │   └── crl.pem
│   └── cloudflare.ini        # Certbot DNS credentials
└── logs/
    └── app.log               # Rotated: 5 MB × 5 files
```

System install (via install script or `.deb`/`.rpm`):
```
/opt/certkeeper/              Application code
/etc/certkeeper/
└── certkeeper.env            Environment overrides
/var/lib/certkeeper/          Persistent data (DATA_DIR)
├── certkeeper.db
├── .encryption-key
├── .session-secret
├── ca/
└── tls/
/var/log/certkeeper/          Log files (LOG_DIR)
└── app.log
/etc/letsencrypt/             Certbot certificate store
```

---

## Logging

CertKeeper uses Winston with file rotation:

| File | Size | Rotation |
|------|------|----------|
| `logs/app.log` | 5 MB per file | 5 files max |

Log levels: `error`, `warn`, `info`, `debug`. Certbot output is also logged to this directory.

Console output is enabled in development (`NODE_ENV=development`).

---

## Notification Channels

Notification configs are managed in Settings → Notifications. Each channel has an `enabled` flag, connection details, and per-event toggles.

### Events

**Certificate events:**
| Event | Trigger |
|-------|---------|
| `issued` | New certificate successfully issued |
| `renewed` | Certificate successfully renewed |
| `expiry_warning` | Certificate approaching expiry |
| `error` | Certificate operation failed |
| `revoked` | Certificate revoked |

**Agent events:**
| Event | Trigger |
|-------|---------|
| `agent_offline` | Agent missed heartbeat threshold |
| `agent_online` | Previously-offline agent checked in |

### Channel Configuration

#### Email
| Field | Required | Description |
|-------|----------|-------------|
| `enabled` | Yes | Enable/disable channel |
| `to` | Yes | Recipient email address |
| `events` | Yes | Array of event names to subscribe to |

#### Webhook
| Field | Required | Description |
|-------|----------|-------------|
| `enabled` | Yes | Enable/disable channel |
| `url` | Yes | Webhook URL (POST) |
| `secret` | No | HMAC signing secret for payload verification |
| `events` | Yes | Array of event names |

#### Pushover
| Field | Required | Description |
|-------|----------|-------------|
| `enabled` | Yes | Enable/disable channel |
| `userKey` | Yes | Your Pushover user key |
| `appToken` | Yes | Pushover application token |
| `events` | Yes | Array of event names |

#### Gotify
| Field | Required | Description |
|-------|----------|-------------|
| `enabled` | Yes | Enable/disable channel |
| `url` | Yes | Gotify server URL |
| `appToken` | Yes | Application token |
| `priority` | No | Message priority (default: 5) |
| `events` | Yes | Array of event names |

#### Slack
| Field | Required | Description |
|-------|----------|-------------|
| `enabled` | Yes | Enable/disable channel |
| `webhookUrl` | Yes | Slack incoming webhook URL |
| `channel` | No | Override channel (e.g. `#certs`) |
| `events` | Yes | Array of event names |

#### Discord
| Field | Required | Description |
|-------|----------|-------------|
| `enabled` | Yes | Enable/disable channel |
| `webhookUrl` | Yes | Discord webhook URL |
| `events` | Yes | Array of event names |

#### Telegram
| Field | Required | Description |
|-------|----------|-------------|
| `enabled` | Yes | Enable/disable channel |
| `botToken` | Yes | Telegram bot token |
| `chatId` | Yes | Chat/group ID |
| `events` | Yes | Array of event names |

### Secret Handling

Secrets (tokens, keys) are **encrypted at rest** in the database using AES-256-GCM. The encryption key is stored separately in `data/.encryption-key` and rotated automatically every 30 days.

In API responses, secrets are **masked**:
- Token fields appear as `hasToken: true` / `hasSecret: true` instead of the raw value
- On PUT, omitting a secret field preserves the existing stored value
- Sending a new value overwrites it

---

## Agent Monitoring Settings

Configured in Settings → Agents tab, or via `GET`/`PUT /api/settings/agents`.

| Setting | Default | Description |
|---------|---------|-------------|
| Heartbeat interval | 3 minutes (180s) | How often agents should check in |
| Offline threshold | 3 missed heartbeats | How many missed heartbeats before marking offline |

Changing these settings increments the global `agent_config_version`. Agents pick up the new version on their next heartbeat and acknowledge it. The UI shows a blue badge on agents that haven't yet acknowledged the latest config.

---

## TLS Configuration

Three modes, configured in Settings → TLS:

| Mode | Description |
|------|-------------|
| **Self-signed** | Default. Auto-generated at startup, stored in `data/tls/`. Browsers will show a certificate warning. |
| **Custom PEM** | Upload your own cert + key PEM files via the Settings UI. |
| **Managed** | Select one of your CertKeeper-managed Let's Encrypt certificates. The cert files are copied to `data/tls/` and auto-refreshed on renewal. |

TLS changes are applied immediately via hot-reload (`setSecureContext()`). No server restart is required.
