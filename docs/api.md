# API Reference

All API routes are prefixed with `/api`. Responses are JSON unless otherwise noted.

**Authentication types:**
- **Session** — Cookie-based session auth (admin UI). Requires prior login via `/api/auth/login`.
- **mTLS** — Mutual TLS agent certificate. The agent presents a cert signed by CertKeeper's internal CA.
- **Token** — One-time enrollment token in `Authorization: Bearer cke_<token>` header.
- **None** — No authentication required.

---

## Authentication

### POST /api/auth/login

Log in with username and password. Creates a session cookie.

**Auth:** None

**Request:**
```json
{
  "username": "admin",
  "password": "mypassword"
}
```

**Response (200):**
```json
{
  "ok": true,
  "user": { "username": "admin" }
}
```

**Errors:** `400` missing fields, `401` invalid credentials

---

### POST /api/auth/logout

Destroy the current session.

**Auth:** None (destroys session if present)

**Response (200):**
```json
{ "ok": true }
```

---

### GET /api/auth/me

Get the current user, or check if initial setup is needed.

**Auth:** None

**Response (200)** — authenticated:
```json
{
  "user": { "id": 1, "username": "admin" }
}
```

**Response (401)** — not authenticated, setup needed:
```json
{
  "user": null,
  "needsSetup": true,
  "emailFromEnv": false,
  "emailValue": ""
}
```

**Response (401)** — not authenticated, setup complete:
```json
{ "user": null }
```

---

### POST /api/auth/setup

First-run setup — create the admin account and set the registration email. Only works when no users exist in the database.

**Auth:** None

**Request:**
```json
{
  "username": "admin",
  "password": "mypassword",
  "email": "you@example.com"
}
```

- `email` is required unless `LETSENCRYPT_EMAIL` is set via environment variable.
- `username` must be ≥ 3 characters.
- `password` must be ≥ 8 characters.

**Response (200):**
```json
{
  "ok": true,
  "user": { "username": "admin" }
}
```

**Errors:** `400` setup already complete, validation errors

---

### POST /api/auth/password

Change the current user's password.

**Auth:** Session

**Request:**
```json
{
  "currentPassword": "oldpass",
  "newPassword": "newpass123"
}
```

**Response (200):**
```json
{ "ok": true }
```

**Errors:** `400` if credentials managed via env, `401` wrong current password

---

## Dashboard

### GET /api/dashboard

Dashboard summary statistics and recent audit log entries.

**Auth:** Session

**Response (200):**
```json
{
  "total": 5,
  "active": 3,
  "expiring": 1,
  "errors": 0,
  "staging": false,
  "email": "you@example.com",
  "hasCloudflareToken": true,
  "cloudflareSource": "database",
  "recentAudit": [
    {
      "id": 42,
      "action": "cert_request",
      "details": "{\"id\":5,\"domains\":[\"example.com\"]}",
      "created_at": "2026-02-15 10:30:00"
    }
  ]
}
```

- `expiring` counts active certs expiring within 30 days.
- `recentAudit` returns the 20 most recent audit log entries.

---

## Certificates

### GET /api/certs

List all tracked certificates.

**Auth:** Session

**Response (200):**
```json
[
  {
    "id": 1,
    "domains": ["example.com", "www.example.com"],
    "status": "active",
    "certbot_name": "example.com",
    "issued_at": "2026-02-14 00:00:00",
    "expires_at": "2026-05-15 00:00:00",
    "last_renewed_at": null,
    "auto_renew": 1,
    "staging": 0,
    "error_message": null,
    "created_at": "2026-02-14 00:00:00",
    "updated_at": "2026-02-14 00:00:00"
  }
]
```

---

### GET /api/certs/:id

Get a single certificate's details.

**Auth:** Session

**Response (200):** Same shape as individual items in the list response.

**Errors:** `404` not found

---

### POST /api/certs

Request a new certificate. This is **asynchronous** — certbot runs in the background.

**Auth:** Session

**Request:**
```json
{
  "domains": ["example.com", "*.example.com"]
}
```

- `domains` — array of domain names. Supports wildcards (e.g. `*.example.com`).
- `overrideRevoked` — (optional, boolean) if `true`, replaces an existing revoked certificate for the same domains.

**Response (202):** The certificate object with `status: "issuing"`. Poll `GET /api/certs/:id` until the status changes to `active` or `error`.

**Errors:**
- `400` — invalid domains, or Cloudflare API token not configured
- `409` — certificate already exists for these domains (includes `id` and `status` of existing). If a revoked cert exists and `overrideRevoked` is not set, returns `{ revoked: true, revokedId }`.

---

### POST /api/certs/:id/renew

Force-renew a certificate. Asynchronous — returns immediately.

**Auth:** Session

**Response (202):** The certificate object with `status: "renewing"`.

**Errors:** `400` no certbot name, `404` not found, `409` already processing

---

### PATCH /api/certs/:id

Update certificate settings.

**Auth:** Session

**Request:**
```json
{
  "auto_renew": false
}
```

**Response (200):** The updated certificate object.

---

### DELETE /api/certs/:id

Delete a certificate. Behavior depends on the `action` query parameter:

| Query | Behavior |
|-------|----------|
| `?action=revoke` | Revoke via certbot, keep row in DB as `revoked` |
| `?action=remove` | Delete from DB + remove cert files from disk, no certbot revoke |
| *(no action)* | Revoke via certbot, then delete from DB |

**Auth:** Session

**Response (200):**
```json
{ "ok": true }
```

**Errors:** `409` if the certificate is currently used for server TLS (switch TLS to a different certificate first)

---

### POST /api/certs/sync

Manually sync the database with certificates on disk (certbot's live directory).

**Auth:** Session

**Response (200):** Full certificate list after sync.

---

## Settings

### GET /api/settings

Retrieve current settings, system status, and config source information.

**Auth:** Session

**Response (200):**
```json
{
  "server": {
    "nodeVersion": "v24.0.0",
    "platform": "linux",
    "arch": "x64",
    "uptime": 3600,
    "port": 3000
  },
  "cloudflare": {
    "hasToken": true,
    "source": "database",
    "maskedToken": "abc1••••••••xyz9"
  },
  "credentials": {
    "source": "database"
  },
  "email": {
    "value": "you@example.com",
    "source": "database"
  },
  "tls": {
    "source": "self-signed",
    "serviceDomain": null,
    "serviceCertId": null
  },
  "agents": {
    "count": 0
  },
  "schedule": { ... },
  "staging": false,
  "certs": {
    "total": 5,
    "active": 3
  }
}
```

---

### PUT /api/settings/email

Update the Let's Encrypt registration email.

**Auth:** Session

**Request:**
```json
{ "email": "you@example.com" }
```

**Response (200):**
```json
{
  "ok": true,
  "email": { "value": "you@example.com", "source": "database" }
}
```

**Errors:** `400` if email managed via env, invalid email format, or empty

---

### PUT /api/settings/cloudflare

Save or clear the Cloudflare API token. The token is validated against the Cloudflare API before saving.

**Auth:** Session

**Request:**
```json
{ "apiToken": "your-cloudflare-api-token" }
```

Send an empty string to clear the token.

**Response (200):**
```json
{
  "ok": true,
  "cloudflare": {
    "hasToken": true,
    "source": "database",
    "maskedToken": "your••••••••oken"
  }
}
```

**Errors:** `400` if managed via env, invalid token (validated with CF API)

---

### PUT /api/settings/tls

Configure the server's TLS certificate.

**Auth:** Session

Three modes of operation:

**Upload custom PEM:**
```json
{
  "certPem": "-----BEGIN CERTIFICATE-----\n...",
  "keyPem": "-----BEGIN PRIVATE KEY-----\n..."
}
```

**Use a managed (Let's Encrypt) cert:**
```json
{
  "managedDomain": "example.com"
}
```

**Revert to self-signed:**
```json
{
  "action": "reset"
}
```

**Response (200):**
```json
{
  "ok": true,
  "tls": { "source": "custom" },
  "restart": true
}
```

> `restart: true` indicates the server needs a restart for new TLS certs to take effect.

**Errors:** `409` when reverting to self-signed (`action: "reset"`) while agents exist. Agents cannot verify the server's identity with a self-signed certificate.

---

### GET /api/settings/tls/managed

List active certificates available for use as the server's TLS cert.

**Auth:** Session

**Response (200):**
```json
[
  { "id": 1, "domains": ["example.com", "www.example.com"] }
]
```

---

### GET /api/settings/schedule

Get the current auto-renewal schedule.

**Auth:** Session

**Response (200):**
```json
{
  "source": "database",
  "day1": { "day": 1, "dayName": "Monday", "hour": 3, "minute": 42, "cron": "42 3 * * 1" },
  "day2": { "day": 4, "dayName": "Thursday", "hour": 2, "minute": 17, "cron": "17 2 * * 4" }
}
```

---

### PUT /api/settings/schedule

Update the auto-renewal schedule. Requires two different days.

**Auth:** Session

**Request:**
```json
{
  "day1": 1, "hour1": 3, "min1": 42,
  "day2": 4, "hour2": 2, "min2": 17
}
```

- Days: 0–6 (Sunday–Saturday)
- Hours: 0–23
- Minutes: 0–59
- `day1` and `day2` must be different

**Response (200):**
```json
{
  "ok": true,
  "schedule": { ... }
}
```

---

### GET /api/settings/agents

Get agent monitoring settings.

**Auth:** Session

**Response (200):**
```json
{
  "heartbeat_interval": 180,
  "offline_threshold": 3,
  "config_version": 1
}
```

- `heartbeat_interval` — seconds between expected heartbeats
- `offline_threshold` — number of missed heartbeats before flagging offline
- `config_version` — current global config version

---

### PUT /api/settings/agents

Update agent monitoring settings. Increments the global config version so agents pick up changes on their next heartbeat.

**Auth:** Session

**Request:**
```json
{
  "heartbeat_interval_minutes": 3,
  "offline_threshold": 3
}
```

Both must be integers ≥ 1. The interval is stored in seconds internally (`minutes × 60`).

**Response (200):**
```json
{
  "ok": true,
  "heartbeat_interval": 180,
  "offline_threshold": 3,
  "config_version": 2
}
```

---

## Notifications

Notification configs are stored per-channel. Each channel has an `enabled` flag, connection details, and an `events` array controlling which events trigger notifications.

**Certificate events:** `issued`, `renewed`, `expiry_warning`, `error`, `revoked`
**Agent events:** `agent_offline`, `agent_online`

### GET /api/notifications

Retrieve all notification channel configurations. Secrets are masked.

**Auth:** Session

**Response (200):**
```json
{
  "email": {
    "enabled": false,
    "to": "",
    "events": ["issued", "renewed", "expiry_warning", "error"]
  },
  "webhook": {
    "enabled": false,
    "url": "",
    "hasSecret": false,
    "events": ["issued", "renewed", "expiry_warning", "error"]
  },
  "pushover": {
    "enabled": false,
    "userKey": "",
    "hasToken": false,
    "events": ["issued", "renewed", "expiry_warning", "error"]
  },
  "gotify": {
    "enabled": false,
    "url": "",
    "hasToken": false,
    "priority": 5,
    "events": ["issued", "renewed", "expiry_warning", "error"]
  },
  "slack": {
    "enabled": false,
    "webhookUrl": "",
    "channel": "",
    "events": ["issued", "renewed", "expiry_warning", "error"]
  },
  "discord": {
    "enabled": false,
    "webhookUrl": "",
    "events": ["issued", "renewed", "expiry_warning", "error"]
  },
  "telegram": {
    "enabled": false,
    "chatId": "",
    "hasBotToken": false,
    "events": ["issued", "renewed", "expiry_warning", "error"]
  }
}
```

---

### PUT /api/notifications/:channel

Save a notification channel configuration. Supported channels: `email`, `webhook`, `pushover`, `gotify`, `slack`, `discord`, `telegram`.

**Auth:** Session

Each channel has different required fields. Secrets (tokens, keys) can be omitted on update to preserve the existing value.

**Email:**
```json
{
  "enabled": true,
  "to": "you@example.com",
  "events": ["issued", "renewed", "expiry_warning", "error"]
}
```

**Webhook:**
```json
{
  "enabled": true,
  "url": "https://hooks.example.com/certkeeper",
  "secret": "optional-hmac-secret",
  "events": ["issued", "renewed", "error"]
}
```

**Pushover:**
```json
{
  "enabled": true,
  "userKey": "your-user-key",
  "appToken": "your-app-token",
  "events": ["error", "expiry_warning"]
}
```

**Gotify:**
```json
{
  "enabled": true,
  "url": "https://gotify.example.com",
  "appToken": "your-app-token",
  "priority": 5,
  "events": ["issued", "renewed", "error"]
}
```

**Slack:**
```json
{
  "enabled": true,
  "webhookUrl": "https://hooks.slack.com/services/...",
  "channel": "#certs",
  "events": ["issued", "renewed", "error"]
}
```

**Discord:**
```json
{
  "enabled": true,
  "webhookUrl": "https://discord.com/api/webhooks/...",
  "events": ["issued", "renewed", "error"]
}
```

**Telegram:**
```json
{
  "enabled": true,
  "botToken": "123456:ABC-DEF...",
  "chatId": "-100123456789",
  "events": ["issued", "renewed", "error"]
}
```

**Response (200):** `{ ok: true, <channel>: { ... } }` with the saved config (secrets masked).

---

### POST /api/notifications/:channel/test

Send a test notification. Currently a stub — returns success but does not actually send.

**Auth:** Session

**Response (200):**
```json
{
  "ok": true,
  "message": "Test email notification queued (not yet implemented)"
}
```

---

## Agents (Admin)

Admin CRUD for agents and their deployments. All routes require session auth.

### GET /api/agents

List all agents with their deployments.

**Auth:** Session

**Response (200):**
```json
[
  {
    "id": 1,
    "name": "docker-host-01",
    "enabled": true,
    "enrolled": true,
    "cert_fingerprint_short": "a1b2c3d4e5f67890",
    "cert_expires_at": "2026-04-02 14:30:00",
    "cert_serial": 1,
    "has_enrollment_token": false,
    "enrollment_expires_at": null,
    "enrollment_token_expired": false,
    "status": "online",
    "next_contact_at": "2026-02-15 10:33:00",
    "config_version": 2,
    "config_current": true,
    "pending_actions": [],
    "last_contact_at": "2026-02-15 10:30:00",
    "last_contact_ip": "192.168.1.50",
    "created_at": "2026-02-14 00:00:00",
    "updated_at": "2026-02-15 10:30:00",
    "deployments": [
      {
        "id": 1,
        "name": "nginx-proxy",
        "enabled": true,
        "certificate_id": 5,
        "domains": ["example.com", "www.example.com"],
        "cert_status": "active",
        "expires_at": "2026-05-15 00:00:00",
        "last_deployed_at": "2026-02-14 12:00:00",
        "last_deployed_hash": "a1b2c3d4e5f67890",
        "created_at": "2026-02-14 00:00:00",
        "updated_at": "2026-02-14 12:00:00"
      }
    ]
  }
]
```

Key fields:
- `enrolled` — `true` if the agent has completed mTLS enrollment
- `config_current` — `true` if the agent has acknowledged the latest global config version
- `status` — `"online"`, `"offline"`, or `null` (unknown/not yet enrolled)

---

### GET /api/agents/:id

Get a single agent with deployments.

**Auth:** Session

**Response:** Same shape as individual items in the list response.

---

### POST /api/agents

Create a new agent. Generates a one-time enrollment token.

**Auth:** Session

**Request:**
```json
{ "name": "docker-host-01" }
```

**Response (201):**
```json
{
  "agent": { ... },
  "enrollmentToken": "cke_a1b2c3d4...",
  "enrollmentExpiresAt": "2026-02-15 11:30:00"
}
```

> The `enrollmentToken` is shown **once** and cannot be retrieved again. The token expires in 1 hour.

**Errors:** `400` if the server is using a self-signed TLS certificate. Agents cannot verify the server's identity during enrollment — switch to a managed or custom certificate first.

---

### PATCH /api/agents/:id

Update agent name or enabled state.

**Auth:** Session

**Request:**
```json
{
  "name": "new-name",
  "enabled": false
}
```

**Response (200):** Updated agent object.

---

### DELETE /api/agents/:id

Delete an agent and all its deployments.

**Auth:** Session

**Response (200):**
```json
{ "ok": true }
```

---

### POST /api/agents/:id/regenerate-token

Reset enrollment — clears the existing agent certificate and generates a new enrollment token. Used for re-enrollment after cert expiry or compromise.

**Auth:** Session

**Response (200):**
```json
{
  "enrollmentToken": "cke_f6e5d4c3...",
  "enrollmentExpiresAt": "2026-02-15 11:30:00"
}
```

---

### POST /api/agents/:id/actions

Queue a server-to-agent action. The action is delivered in the agent's next heartbeat response, then cleared.

**Auth:** Session

**Request:**
```json
{ "action": "renew_agent_cert" }
```

Valid actions: `renew_agent_cert`, `update_agent`

**Response (200):**
```json
{
  "ok": true,
  "pending_actions": ["renew_agent_cert"]
}
```

Duplicate actions are not added.

---

### GET /api/agents/ca-cert

Download the internal CA certificate (PEM format). Used for agent trust configuration.

**Auth:** Session

**Response (200):** PEM file (`application/x-pem-file` content type)

---

### GET /api/agents/:id/deployments

List deployments for a specific agent.

**Auth:** Session

**Response (200):** Array of deployment objects.

---

### POST /api/agents/:id/deployments

Create a deployment — ties an agent to a certificate.

**Auth:** Session

**Request:**
```json
{
  "name": "nginx-proxy",
  "certificateId": 5
}
```

**Response (201):** The created deployment object.

**Errors:** `400` if `certificateId` references the certificate currently used for server TLS. Deploying it would allow agents to impersonate the server.

---

### PATCH /api/agents/:agentId/deployments/:depId

Update a deployment (name, certificate, or enabled state).

**Auth:** Session

**Request:**
```json
{
  "name": "new-name",
  "certificateId": 3,
  "enabled": false
}
```

**Response (200):** Updated deployment object.

**Errors:** `400` if `certificateId` references the certificate currently used for server TLS.

---

### DELETE /api/agents/:agentId/deployments/:depId

Delete a deployment.

**Auth:** Session

**Response (200):**
```json
{ "ok": true }
```

---

## Agent API (mTLS)

Agent-facing endpoints. All except `/enroll` and `/time` require mTLS agent certificate authentication.

See the [Agent Developer Guide](../copilot-instructions-for-agent.md) for detailed usage, lifecycle, and implementation guidance.

### POST /api/agent/enroll

Exchange an enrollment token + CSR for a signed agent certificate.

**Auth:** Token (Bearer)

See [Agent Developer Guide — Enrollment](../copilot-instructions-for-agent.md#post-apiagent enroll).

---

### POST /api/agent/renew-cert

Renew the agent's mTLS agent certificate.

**Auth:** mTLS

See [Agent Developer Guide — Cert Renewal](../copilot-instructions-for-agent.md#post-apiagentrenew-cert).

---

### POST /api/agent/heartbeat

Agent keepalive with config versioning and action delivery.

**Auth:** mTLS

See [Agent Developer Guide — Heartbeat](../copilot-instructions-for-agent.md#post-apiagentheartbeat).

---

### GET /api/agent/deployments

List this agent's deployments with certificate metadata and content hashes.

**Auth:** mTLS

See [Agent Developer Guide — Deployments](../copilot-instructions-for-agent.md#get-apiagentdeployments).

---

### GET /api/agent/deployments/:id/bundle

Download certificate + key PEM files for a deployment.

**Auth:** mTLS

See [Agent Developer Guide — Bundle Download](../copilot-instructions-for-agent.md#get-apiagentdeploymentsidbundle).

---

### GET /api/agent/time

Server clock for time-skew detection.

**Auth:** None

**Response (200):**
```json
{
  "server_time": "2026-02-15T10:30:00.000Z"
}
```
