# 🔒 CertKeeper

[![Version](https://img.shields.io/github/package-json/v/claytonfuselier/certkeeper)](#)
[![License](https://img.shields.io/github/license/claytonfuselier/certkeeper)](#)
[![Last Commit](https://img.shields.io/github/last-commit/claytonfuselier/certkeeper)](#)

CertKeeper is a lightweight, self-hosted certificate manager for Let’s Encrypt with a simple web UI.

Internal services, IoT devices, and private infrastructure all need valid TLS certificates, but HTTP-01 challenges aren’t always practical. Not every service can sit behind a reverse proxy, and many applications that support ACME with DNS-01 require access to API keys. Managing multiple API keys across services increases complexity and risk.

CertKeeper solves this by centralizing certificate management using DNS-01 challenges (via Cloudflare) and securely distributing certificates to your systems through an agent model.

<br>

## Features

- **Managed Certs** — Automatic renewal schedule, plus manual renew/revoke/reissue
- **DNS-01 challenges** — Eliminates the need for exposed web servers and adds support for wildcard certificates
- **Agent system** — Distributes certs to remote hosts automatically
- **mTLS Authentication** — Internal Certificate Authority allows agents to communicate via Mutual TLS (mTLS); no shared or stale secrets to manage.
- **Notifications** — Supported via Email, Webhook, Pushover, and more
- **HTTPS by default** — Web UI uses self-signed cert at setup, but can be easily upgraded to one of the managed Let's Encrypt certs or a custom PEM
- **Run natively** — install via one-line script, `.deb`/`.rpm` package, or manual setup
- **Docker support** — pre-built image on GHCR, or build from source with multi-stage Dockerfile

<br>

## Agent System

CertKeeper includes a built-in [agent system](https://github.com/claytonfuselier/certkeeper-agent) for distributing certificates to remote servers:

1. Create an agent in the web UI to get an enrollment token
2. Install the agent on the remote host and provide the token
3. The agent will exchange the token for an mTLS agent certificate (private key never leaves the agent)
4. Assign certificate deployments to the agent in the web UI
5. The agent automatically pulls updated bundles whenever a certificate is renewed

The server monitors agent health via heartbeats and can push commands (like "renew your agent cert") through the heartbeat.

<br>

## Quick Start

### Docker (recommended)

Pull the pre-built image:

```bash
mkdir certkeeper && cd certkeeper
curl -fsSL https://raw.githubusercontent.com/claytonfuselier/certkeeper/main/docker-compose.yml -o docker-compose.yml
docker compose up -d
```

Or clone the repo and build from source:

```bash
git clone https://github.com/claytonfuselier/certkeeper.git
cd certkeeper
docker compose up -d --build
```

Open `https://localhost:3000` and follow the setup wizard.

Data is persisted via bind mounts:

| Host Path | Container Path | Purpose |
|-----------|----------------|---------|
| `./letsencrypt/` | `/etc/letsencrypt` | Certificate files |
| `./data/` | `/app/data` | Database, CA, TLS, session secret |
| `./logs/` | `/app/logs` | Application and certbot logs |

### Install Script (Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/claytonfuselier/certkeeper/main/install.sh | sudo bash
```

Installs CertKeeper as a systemd service. The script handles dependencies (Node.js, certbot), downloads the latest `.deb`/`.rpm` package, and starts the service. See [Installation Guide](docs/installation.md) for details.

### Manual Setup

```bash
git clone https://github.com/claytonfuselier/certkeeper.git
cd certkeeper
npm install
sudo npm start
```

> **Root is required** — certbot needs access to `/etc/letsencrypt`.

<br>

## Documentation

| Document | Description |
|----------|-------------|
| [Installation Guide](docs/installation.md) | Install script, packages, manual setup, updating, uninstalling |
| [API Reference](docs/api.md) | Complete REST API documentation |
| [Configuration](docs/configuration.md) | Environment variables, Docker setup, notification channels |
| [Architecture](docs/architecture.md) | Code structure, database schema, design patterns |

<br>

## License

This project is open source and available under the [MIT License](LICENSE).


