# 🔒 CertKeeper

[![Version](https://img.shields.io/github/package-json/v/claytonfuselier/certkeeper)](#)
[![License](https://img.shields.io/github/license/claytonfuselier/certkeeper)](#)
[![Last Commit](https://img.shields.io/github/last-commit/claytonfuselier/certkeeper)](#)
[![Node](https://img.shields.io/badge/node-24%2B-green)](https://nodejs.org/)
[![Express](https://img.shields.io/github/package-json/dependency-version/claytonfuselier/certkeeper/express)](#)

A lightweight, self-hosted certificate manager for Let's Encrypt with a web UI.

Not every service sits behind a reverse proxy that handles TLS for you. Internal services, mail servers, database clusters, IoT devices — they all need valid certificates, but HTTP-01 challenges don't work when there's no public web server. For applications that support DNS-01, you'd have to manage multiple API keys or risk sharing them.

CertKeeper centralizes certificate management using DNS-01 challenges (via Cloudflare) and distributes certificates to where they're needed through its agent system. A single CertKeeper instance handles the Let's Encrypt workflow for all your services; lightweight agents on your hosts check in with CertKeeper, pull down the certs, and install them automatically.

<br>

## Features

- **Managed Certs** - Automatic renewal schedule, plus manual renew/revoke/reissue
- **DNS-01** challenge eliminates the need for exposed web servers supports wildcard certificates
- **Agent system** - distributes certs to remote hosts automatically with customizable install/update actions
- **mTLS Authentication** - Internal Certificate Authority allows agents to communicate via Mutual TLS (mTLS); no shared or stale secrets to manage.
- **Notifications** - Supported via Email, Webhook, Pushover, and more
- **Zero-config** startup with SQLite — no database server needed; everything is configurable via the web UI (optional overrides via `.env`)
- **HTTPS by default** - Web UI uses self-signed cert at setup, but can be easily upgraded to one of the managed Let's Encrypt certs or a custom PEM (see [TLS Modes](#tls-modes))
- **Run natively** with Node.js
- **Docker support** with multi-stage build (pre-built image coming soon)
- **Security** - CSRF protection, XSS-safe output encoding, parameterized SQL queries, and AES-256-GCM encryption at rest for stored secrets

<br>

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/claytonfuselier/certkeeper.git
cd certkeeper
docker compose up -d
```

Open `https://localhost:3000` and follow the setup wizard.

Data is persisted via bind mounts:

| Host Path | Container Path | Purpose |
|-----------|----------------|---------|
| `./letsencrypt/` | `/etc/letsencrypt` | Certificate files |
| `./data/` | `/app/data` | Database, CA, TLS, session secret |
| `./logs/` | `/app/logs` | Application and certbot logs |

### Native

```bash
git clone https://github.com/claytonfuselier/certkeeper.git
cd certkeeper
npm install
sudo npm start
```

> **Root is required** — certbot needs access to `/etc/letsencrypt`.

**That's it.** No `.env` file needed. On first visit you'll create an admin account and configure settings through the web UI.

> The server uses HTTPS with an auto-generated self-signed certificate. Your browser will show a security warning on first visit — you can upgrade to a trusted certificate in Settings → TLS.

<br>

## Agent System

CertKeeper includes a built-in agent system for distributing certificates to remote servers:

1. Create an agent in the web UI — you get a one-time enrollment token
2. Install the agent on the remote host and provide the token
3. The agent exchanges the token for an mTLS agent certificate (private key never leaves the agent)
4. Assign certificate deployments to the agent
5. The agent automatically pulls updated bundles whenever a certificate is renewed

The server monitors agent health via heartbeats and can push commands (like "renew your agent cert") through the heartbeat channel.

See the [Agent Developer Guide](copilot-instructions-for-agent.md) for building compatible agent implementations.

<br>

## TLS Modes

The server always runs over HTTPS. Three options for the server's own TLS certificate:

| Mode | Description |
|------|-------------|
| **Self-signed** (default) | Auto-generated on first start, auto-renewed. No setup required. |
| **Managed cert** | Select one of your issued Let's Encrypt certificates in Settings → TLS. Auto-refreshed on renewal. |
| **Custom PEM** | Upload your own `cert.pem` + `key.pem` files. |

<br>

## Documentation

| Document | Description |
|----------|-------------|
| [API Reference](docs/api.md) | Complete REST API documentation |
| [Configuration](docs/configuration.md) | Environment variables, Docker setup, notification channels |
| [Architecture](docs/architecture.md) | Code structure, database schema, design patterns |
| [Agent Developer Guide](copilot-instructions-for-agent.md) | Everything needed to build a CertKeeper agent |

<br>

## Development

```bash
npm install
npm run dev     # Auto-restart on file changes
```

Set `LETSENCRYPT_STAGING=true` in `.env` to use the Let's Encrypt staging server during development.

<br>

## License

This project is open source and available under the [MIT License](LICENSE).
