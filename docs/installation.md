# Installation

CertKeeper can be installed three ways: **Docker** (recommended), **install script**, or **manual setup**. All methods result in the same running application.

---

## Quick Start

### Docker (recommended)

Pull the pre-built image and run with Docker Compose:

```bash
mkdir certkeeper && cd certkeeper

curl -fsSL https://raw.githubusercontent.com/claytonfuselier/certkeeper/main/docker-compose.yml -o docker-compose.yml

docker compose up -d
```

Or build from source:

```bash
git clone https://github.com/claytonfuselier/certkeeper.git
cd certkeeper
docker compose up -d
```

Open `https://localhost:3000` and follow the setup wizard.

See [Configuration — Docker](configuration.md#docker) for volume mounts, port mapping, and environment variables.

### Install Script (Debian/Ubuntu, RHEL/Fedora)

```bash
curl -fsSL https://raw.githubusercontent.com/claytonfuselier/certkeeper/main/install.sh | sudo bash
```

Or to install a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/claytonfuselier/certkeeper/main/install.sh \
  | sudo bash -s -- --version 1.2.0
```

The script will:
1. Check for root privileges (required)
2. Detect your distro and architecture
3. Install Node.js 24+ via NodeSource (if missing)
4. Install certbot and certbot-dns-cloudflare via pip (if missing)
5. Check for conflicting certbot timers/cron jobs and offer to disable them
6. Download and install the `.deb` or `.rpm` package from GitHub Releases
7. Create the `certkeeper` system user and required directories
8. Install and enable the systemd service
9. Start CertKeeper

### Manual Native Install

If you prefer to set things up yourself:

```bash
# Prerequisites
# - Node.js 24+
# - certbot with certbot-dns-cloudflare plugin
# - Root access

git clone https://github.com/claytonfuselier/certkeeper.git
cd certkeeper
npm install --omit=dev
sudo node src/index.js
```

For a proper service setup, see [Manual Service Setup](#manual-service-setup) below.

---

## System Requirements

| Requirement | Minimum |
|-------------|---------|
| **OS** | Linux (Debian/Ubuntu, RHEL/Fedora, or compatible) |
| **Node.js** | 24 or later |
| **certbot** | Any recent version with the `certbot-dns-cloudflare` plugin |
| **Root access** | Required — certbot needs write access to `/etc/letsencrypt` |
| **RAM** | ~64 MB |
| **Disk** | ~100 MB (app + dependencies) |
| **Network** | Outbound HTTPS to Let's Encrypt and Cloudflare APIs |

---

## File Layout (System Install)

When installed via the install script or `.deb`/`.rpm` package:

```
/opt/certkeeper/                  Application code
├── src/                          Server source
├── public/                       Frontend assets
├── node_modules/                 Dependencies (bundled)
└── package.json

/etc/certkeeper/
└── certkeeper.env                Environment overrides

/var/lib/certkeeper/              Persistent data (DATA_DIR)
├── certkeeper.db                 SQLite database
├── .encryption-key               AES-256-GCM key
├── .session-secret               Session secret
├── ca/                           Internal CA cert + key
└── tls/                          Server TLS certs

/var/log/certkeeper/              Log files (LOG_DIR)
└── app.log                       Auto-rotated: 5 MB × 5 files

/etc/letsencrypt/                 Certbot certificate store

/etc/systemd/system/
└── certkeeper.service            systemd unit
```

---

## Configuration

After installation, edit `/etc/certkeeper/certkeeper.env` to set any environment overrides, then restart:

```bash
sudo systemctl restart certkeeper
```

Most configuration can be done through the web UI at `https://localhost:3000`. See [Configuration](configuration.md) for all environment variables.

### Cloudflare API Token

CertKeeper uses DNS-01 challenges via Cloudflare. You need an API **token** (not the legacy global API key).

1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token**
3. Use the **Edit zone DNS** template, or create a custom token with:
   - **Permissions:** Zone → DNS → Edit
   - **Zone Resources:** Include → Specific zone (or All zones)
4. Copy the token and enter it in CertKeeper's Settings → Cloudflare API page

For detailed steps, see the [Cloudflare documentation on creating API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/).

---

## Managing the Service

```bash
# Start / stop / restart
sudo systemctl start certkeeper
sudo systemctl stop certkeeper
sudo systemctl restart certkeeper

# Check status
sudo systemctl status certkeeper

# View logs (journald)
sudo journalctl -u certkeeper -f

# View application logs
tail -f /var/log/certkeeper/app.log
```

---

## Updating

### Docker

```bash
docker compose pull
docker compose up -d
```

### Install Script

Re-run the install script — it downloads the latest release and upgrades in place:

```bash
curl -fsSL https://raw.githubusercontent.com/claytonfuselier/certkeeper/main/install.sh | sudo bash
```

Data, configuration, and certificates are preserved across upgrades.

### Manual

```bash
cd /path/to/certkeeper
git pull
npm install --omit=dev
sudo systemctl restart certkeeper
```

---

## Uninstalling

### Docker

```bash
docker compose down
# Optionally remove data:
# rm -rf data/ logs/ letsencrypt/
```

### Install Script

```bash
curl -fsSL https://raw.githubusercontent.com/claytonfuselier/certkeeper/main/install.sh \
  | sudo bash -s -- --uninstall
```

This removes the application and service but **preserves** all data directories:
- `/var/lib/certkeeper/` (database, CA, encryption key)
- `/etc/certkeeper/` (configuration)
- `/var/log/certkeeper/` (logs)
- `/etc/letsencrypt/` (certificates)

Delete these manually if no longer needed.

### Package Manager

```bash
# Debian/Ubuntu
sudo apt remove certkeeper

# RHEL/Fedora
sudo dnf remove certkeeper
```

Same data preservation applies — only the application and service are removed.

---

## Manual Service Setup

If you prefer not to use the install script, you can set up the systemd service manually:

```bash
# 1. Create system user
sudo groupadd --system certkeeper
sudo useradd --system --no-create-home --shell /usr/sbin/nologin --gid certkeeper certkeeper

# 2. Create directories
sudo mkdir -p /opt/certkeeper /var/lib/certkeeper /var/log/certkeeper /etc/certkeeper
sudo chown root:certkeeper /var/lib/certkeeper /var/log/certkeeper /etc/certkeeper
sudo chmod 750 /var/lib/certkeeper /var/log/certkeeper /etc/certkeeper

# 3. Copy application files
sudo cp -r src public node_modules package.json /opt/certkeeper/

# 4. Install env file
sudo cp install/certkeeper.env /etc/certkeeper/certkeeper.env
sudo chown root:certkeeper /etc/certkeeper/certkeeper.env
sudo chmod 640 /etc/certkeeper/certkeeper.env

# 5. Install systemd unit
sudo cp install/certkeeper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now certkeeper
```

---

## Troubleshooting

### Port already in use

Change the port in `/etc/certkeeper/certkeeper.env`:

```bash
PORT=3443
```

Then restart: `sudo systemctl restart certkeeper`

### certbot not found

CertKeeper checks for certbot at startup and warns if it's missing. Certificate operations will fail until certbot is installed:

```bash
pip3 install certbot certbot-dns-cloudflare
```

### Permission denied on /etc/letsencrypt

The service runs as root to allow certbot access. If you see permission errors, ensure the systemd unit has `User=root` and the `ReadWritePaths` directive includes `/etc/letsencrypt`.

### Browser shows certificate warning

This is expected when using the default self-signed certificate. After issuing a Let's Encrypt certificate, switch to it in Settings → TLS to eliminate the warning.

### Conflicting certbot renewals

If certbot was previously installed on the system, it may have its own renewal timer. Check for and disable conflicts:

```bash
# Check for systemd timer
sudo systemctl status certbot.timer

# Disable if active
sudo systemctl disable --now certbot.timer

# Check for cron job
ls -la /etc/cron.d/certbot
```
