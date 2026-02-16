# CertKeeper Agent — Copilot Instructions

## Overview

The CertKeeper Agent is a lightweight daemon that runs on remote servers and pulls SSL/TLS certificates from a CertKeeper server. It authenticates using **mTLS (mutual TLS)** — the agent holds a client certificate signed by CertKeeper's internal CA. This provides strong cryptographic identity without shared secrets, and certificates auto-renew with zero manual intervention after initial setup.

## Architecture

```
┌─────────────────────┐          mTLS           ┌──────────────────────┐
│   CertKeeper Agent  │ ◄────────────────────► │   CertKeeper Server  │
│   (remote host)     │   client cert + HTTPS   │   (central)          │
│                     │                          │                      │
│  - Polls for certs  │                          │  - Signs CSRs        │
│  - Deploys to disk  │                          │  - Manages CA        │
│  - Auto-renews cert │                          │  - Tracks agents     │
└─────────────────────┘                          └──────────────────────┘
```

## Authentication: mTLS

CertKeeper uses mutual TLS for agent authentication. The server runs its own internal Certificate Authority (CA). Each agent gets a unique client certificate signed by this CA.

**Key properties:**
- Agent private keys are generated locally — they never leave the agent machine
- Client certs are valid for **90 days** and auto-renew
- The server validates the client cert fingerprint against its database
- If an agent is deleted or disabled in CertKeeper, its cert is immediately rejected

## Registration / Enrollment Flow

### Step 1: Admin creates an agent in CertKeeper UI

The admin creates a new agent with auth mode "mTLS". CertKeeper generates a **one-time enrollment token** (prefix `cke_`, valid for 1 hour).

### Step 2: Agent installation & enrollment

When the agent starts for the first time, the user provides:
- The CertKeeper server URL (e.g. `https://certkeeper.example.com:3000`)
- The enrollment token (e.g. `cke_a1b2c3d4...`)

The agent then:

1. **Generates a 2048-bit RSA key pair** locally
2. **Creates a PKCS#10 CSR** (Certificate Signing Request) using the key pair
3. **Sends the CSR** to the enrollment endpoint, authenticated with the enrollment token
4. **Receives back** the signed client certificate + CA certificate
5. **Saves** the client cert, private key, and CA cert to its config directory
6. **Makes a test heartbeat** request using the new client cert (mTLS) to confirm setup
7. The server **burns the enrollment token** after successful enrollment

### Step 3: Ongoing operation

The agent uses its client certificate for all subsequent API calls. No tokens, no passwords.

## API Endpoints

**Base URL:** `https://<certkeeper-host>:<port>/api/agent`

All endpoints except `/enroll` require mTLS authentication (client certificate).

### POST /api/agent/enroll

Exchange an enrollment token + CSR for a signed client certificate.

**Auth:** Bearer token (enrollment token)
```
Authorization: Bearer cke_<enrollment_token>
```

**Request body:**
```json
{
  "csr": "-----BEGIN CERTIFICATE REQUEST-----\n...\n-----END CERTIFICATE REQUEST-----\n"
}
```

**Response (200):**
```json
{
  "certificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
  "ca_certificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
  "fingerprint": "a1b2c3d4e5f6...",
  "expires_at": "2026-05-16 14:30:00",
  "cert_lifetime_days": 90,
  "agent": {
    "id": 1,
    "name": "docker-host-01"
  }
}
```

**Error responses:**
- `400` — Missing/invalid CSR
- `401` — Invalid/expired enrollment token
- `409` — Agent already enrolled (must reset enrollment from admin UI)

**After receiving the response, the agent should:**
1. Save `certificate` to `client.crt`
2. Save `ca_certificate` to `ca.crt`
3. The private key was already generated locally — save it to `client.key`
4. Use these three files for all subsequent mTLS connections

### POST /api/agent/renew-cert

Renew the agent's client certificate before it expires. The agent generates a new key pair, creates a CSR, and sends it authenticated with the current (still valid) client certificate.

**Auth:** mTLS (current client certificate)

**Request body:**
```json
{
  "csr": "-----BEGIN CERTIFICATE REQUEST-----\n...\n-----END CERTIFICATE REQUEST-----\n"
}
```

**Response (200):**
```json
{
  "certificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
  "ca_certificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
  "fingerprint": "f6e5d4c3b2a1...",
  "expires_at": "2026-08-14 14:30:00",
  "cert_lifetime_days": 90
}
```

**The agent should renew when:**
- The current cert has less than 30 days remaining (check `cert_expires_at` from heartbeat)
- Recommended: check daily, renew when < 30 days left

**Renewal process:**
1. Generate a **new** RSA key pair
2. Create a CSR with the new key
3. Call `/api/agent/renew-cert` using the **current** client cert for mTLS auth
4. On success, atomically swap the old cert + key files with the new ones
5. The old cert becomes invalid on the server immediately (fingerprint is updated)

### POST /api/agent/heartbeat

Health check / keepalive. The agent **must** call this at the interval specified in the response (default: every 3 minutes). The server uses heartbeats to track agent liveness — missed heartbeats trigger offline alerts.

**Auth:** mTLS

**Request body:**
```json
{
  "config_version": 1
}
```

Send the `config_version` value from the previous heartbeat response. This tells the server that the agent has acknowledged and applied that config version. On first heartbeat (or if unknown), send `0`.

**Response (200):**
```json
{
  "ok": true,
  "agent": {
    "id": 1,
    "name": "docker-host-01"
  },
  "deployments": 3,
  "server_time": "2026-02-15T10:30:00.000Z",
  "cert_expires_at": "2026-05-16 14:30:00",
  "heartbeat_interval": 180,
  "config_version": 1,
  "actions": []
}
```

**Key fields:**
- `heartbeat_interval` — seconds until the next heartbeat is expected. The agent should use this to set its polling timer. If this value changes between heartbeats, the agent should adjust immediately and send an acknowledgment heartbeat right away.
- `config_version` — latest global config version. Compare with the version you last sent. If different, apply the new config (adjust heartbeat timer, etc.) and immediately send another heartbeat with the new version to acknowledge.
- `actions` — array of server-initiated commands. Process each action and act accordingly:
  - `"renew_agent_cert"` — the admin has requested the agent renew its authentication certificate. Generate a new key pair + CSR and call `POST /api/agent/renew-cert`.
  - `"update_agent"` — reserved for future self-update functionality.
- `cert_expires_at` — use this to decide when to trigger automatic cert renewal (e.g. when < 30 days remain).

Use `cert_expires_at` to decide when to trigger cert renewal.

### GET /api/agent/deployments

List all deployments assigned to this agent. Each deployment represents a certificate that should be deployed to this host.

**Auth:** mTLS

**Response (200):**
```json
[
  {
    "id": 1,
    "name": "nginx-proxy",
    "enabled": true,
    "certificate_id": 5,
    "domains": ["example.com", "www.example.com"],
    "cert_status": "active",
    "certbot_name": "example.com",
    "expires_at": "2026-05-15 00:00:00",
    "issued_at": "2026-02-14 00:00:00",
    "last_renewed_at": null,
    "staging": false,
    "content_hash": "a1b2c3d4e5f67890",
    "last_deployed_at": "2026-02-14 12:00:00",
    "last_deployed_hash": "a1b2c3d4e5f67890"
  }
]
```

**Polling strategy:**
1. Call this endpoint periodically (e.g. every 5 minutes)
2. For each enabled deployment, compare `content_hash` with `last_deployed_hash`
3. If they differ (or `last_deployed_hash` is null), the cert has been renewed — download the new bundle

### GET /api/agent/deployments/:id/bundle

Download the certificate + key PEM files for a specific deployment.

**Auth:** mTLS

**Response (200):**
```json
{
  "deployment_id": 1,
  "deployment_name": "nginx-proxy",
  "certificate_id": 5,
  "domains": ["example.com", "www.example.com"],
  "expires_at": "2026-05-15 00:00:00",
  "issued_at": "2026-02-14 00:00:00",
  "content_hash": "a1b2c3d4e5f67890",
  "fullchain": "-----BEGIN CERTIFICATE-----\n...",
  "cert": "-----BEGIN CERTIFICATE-----\n...",
  "key": "-----BEGIN PRIVATE KEY-----\n..."
}
```

- `fullchain` — Full certificate chain (leaf + intermediates), used by most web servers
- `cert` — Leaf certificate only
- `key` — Private key

**After downloading, the server updates `last_deployed_at` and `last_deployed_hash` for this deployment.**

## mTLS Connection Details

When making HTTPS requests to CertKeeper, the agent must configure its HTTP client with:

1. **Client certificate:** The signed cert received from enrollment (or renewal)
2. **Client private key:** The locally generated private key
3. **CA certificate:** The CertKeeper CA cert (received during enrollment) — used to verify the server if self-signed

Example with Node.js:
```javascript
const https = require('https');
const fs = require('fs');

const options = {
  hostname: 'certkeeper.example.com',
  port: 3000,
  path: '/api/agent/heartbeat',
  method: 'POST',
  cert: fs.readFileSync('client.crt'),
  key: fs.readFileSync('client.key'),
  ca: fs.readFileSync('ca.crt'),   // Trust CertKeeper's CA
  headers: { 'Content-Type': 'application/json' },
};

const req = https.request(options, (res) => { /* ... */ });
req.write('{}');
req.end();
```

Example with curl:
```bash
curl --cert client.crt --key client.key --cacert ca.crt \
  -X POST https://certkeeper.example.com:3000/api/agent/heartbeat
```

## Agent Lifecycle Summary

```
INSTALL & ENROLL (one-time):
  1. User provides: CertKeeper URL + enrollment token
  2. Agent generates RSA key pair locally
  3. Agent creates CSR → POST /api/agent/enroll (Bearer cke_<token>)
  4. Receives signed client cert + CA cert
  5. Saves cert files, confirms with heartbeat
  6. ✅ Ready — token is burned, mTLS is the only auth method

HEARTBEAT LOOP (ongoing, every heartbeat_interval seconds):
  1. POST /api/agent/heartbeat — send { config_version: N }
  2. Receive: heartbeat_interval, config_version, actions, cert_expires_at
  3. If config_version changed → apply new config, immediately re-heartbeat with ack
  4. If actions contains "renew_agent_cert" → trigger cert renewal flow
  5. Sleep for heartbeat_interval seconds, then repeat

POLL & DEPLOY (ongoing, every heartbeat cycle or on separate timer):
  1. GET /api/agent/deployments — list assigned certificates
  2. For each deployment where content_hash ≠ last_deployed_hash:
     a. GET /api/agent/deployments/:id/bundle — download cert+key
     b. Write files to configured deployment path
     c. Optionally: reload nginx/apache/etc.

CERT RENEWAL (automated, when < 30 days remain OR "renew_agent_cert" action):
  1. Generate new RSA key pair
  2. Create CSR with new key
  3. POST /api/agent/renew-cert (authenticated by current mTLS cert)
  4. Receive new signed cert
  5. Atomically swap cert + key files
  6. Next request uses new cert automatically

RE-ENROLLMENT (admin-initiated, if cert is compromised or lost):
  1. Admin clicks "Re-enroll" in CertKeeper UI
  2. New enrollment token is generated, old cert fingerprint is cleared
  3. Agent must re-enroll using the new token (same flow as initial enrollment)
```

## Error Handling

| HTTP Status | Meaning | Agent Action |
|-------------|---------|--------------|
| 200 | Success | Process response normally |
| 400 | Bad request | Log error, don't retry (fix the request) |
| 401 | Auth failed | Cert may be revoked/expired — log and alert admin |
| 403 | Agent disabled | Stop polling, log warning, alert admin |
| 404 | Not found | Deployment may have been removed — update local state |
| 409 | Already enrolled | Agent already has a cert — normal during re-run |
| 500 | Server error | Retry with exponential backoff |

## Configuration (suggested)

The agent should support these configuration options:

| Option | Default | Description |
|--------|---------|-------------|
| `server_url` | — | CertKeeper server URL (required) |
| `config_dir` | `/etc/certkeeper-agent` | Where to store certs and config |
| `heartbeat_interval` | `180` (3 min) | Initial seconds between heartbeats — **overridden by the server** on each heartbeat response. The agent should always use the server-provided value. |
| `config_version` | `0` | Last acknowledged config version — persisted locally and sent in heartbeat requests |
| `renewal_threshold_days` | `30` | Renew client cert when fewer days remain |
| `deploy_dir` | `/etc/ssl/certkeeper` | Base dir for deployed certificate files |

## File Layout (suggested)

```
/etc/certkeeper-agent/
├── config.yml          # Agent configuration
├── client.crt          # Client certificate (from enrollment/renewal)
├── client.key          # Client private key (generated locally, never sent)
├── ca.crt              # CertKeeper CA cert (for server verification)
└── deployments/        # Deployed certificates
    ├── nginx-proxy/
    │   ├── fullchain.pem
    │   ├── cert.pem
    │   └── privkey.pem
    └── mail-server/
        ├── fullchain.pem
        ├── cert.pem
        └── privkey.pem
```
