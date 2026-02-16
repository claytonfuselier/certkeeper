# CertKeeper Agent — Developer Guide

## Overview

The CertKeeper Agent is a lightweight daemon that runs on remote servers and pulls SSL/TLS certificates from a CertKeeper server. It authenticates using **mTLS (mutual TLS)** — the agent holds an agent certificate signed by CertKeeper's internal CA. This provides strong cryptographic identity without shared secrets, and certificates auto-renew with zero manual intervention after initial setup.

This document contains everything needed to build a compatible agent implementation.

## Architecture

```
┌─────────────────────┐          mTLS           ┌──────────────────────┐
│   CertKeeper Agent  │ ◄──────────────────────► │   CertKeeper Server  │
│   (remote host)     │   agent cert + HTTPS    │   (central)          │
│                     │                           │                      │
│  - Heartbeats       │                           │  - Signs CSRs        │
│  - Pulls certs      │                           │  - Manages CA        │
│  - Deploys to disk  │                           │  - Tracks agents     │
│  - Auto-renews cert │                           │  - Sends commands    │
└─────────────────────┘                           └──────────────────────┘
```

## Authentication: mTLS

CertKeeper uses mutual TLS for agent authentication. The server runs its own internal Certificate Authority (CA). Each agent gets a unique agent certificate signed by this CA.

**Key properties:**
- Agent private keys are generated locally — they never leave the agent machine
- Agent certs are valid for **45 days** and auto-renew
- The server validates the agent cert's SHA-256 fingerprint against its database
- If an agent is deleted or disabled in CertKeeper, its cert is immediately rejected
- During cert renewal, both old and new certs are accepted until the old one naturally expires

## Registration / Enrollment Flow

### Step 1: Admin creates an agent in CertKeeper UI

The admin creates a new agent. CertKeeper generates a **one-time enrollment token** (prefix `cke_`, 64 hex characters, valid for 1 hour).

### Step 2: Agent enrollment

When the agent starts for the first time, the user provides:
- The CertKeeper server URL (e.g. `https://certkeeper.example.com:3000`)
- The enrollment token (e.g. `cke_a1b2c3d4...`)

The agent then:

1. **Generates a 2048-bit RSA key pair** locally
2. **Creates a PKCS#10 CSR** (Certificate Signing Request) using the key pair
3. **Sends the CSR** to the enrollment endpoint with the token as a Bearer header
4. **Receives back** the signed agent certificate + CA certificate
5. **Saves** the agent cert, private key, and CA cert to its config directory
6. **Sends an initial heartbeat** using the new agent cert (mTLS) to confirm setup
7. The server **burns the enrollment token** — it can never be reused

### Step 3: Ongoing operation

The agent uses its agent certificate for all subsequent API calls. No tokens, no passwords.

---

## API Reference

**Base URL:** `https://<certkeeper-host>:<port>/api/agent`

All endpoints except `/enroll` and `/time` require mTLS authentication (agent certificate).

---

### POST /api/agent/enroll

Exchange an enrollment token + CSR for a signed agent certificate.

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
  "expires_at": "2026-04-02 14:30:00",
  "cert_lifetime_days": 45,
  "agent": {
    "id": 1,
    "name": "docker-host-01"
  }
}
```

**Error responses:**
| Status | Meaning |
|--------|---------|
| `400` | Missing or invalid CSR |
| `401` | Invalid or expired enrollment token |
| `409` | Fingerprint collision — retry with a new key pair (`retry: true` in body) |

**After receiving the response:**
1. Save `certificate` to `client.crt`
2. Save `ca_certificate` to `ca.crt`
3. The private key was already generated locally — save it to `client.key`
4. Use these three files for all subsequent mTLS connections

---

### POST /api/agent/renew-cert

Renew the agent's agent certificate before it expires. The agent generates a new key pair, creates a CSR, and sends it authenticated with the current (still valid) agent certificate.

**Auth:** mTLS (current agent certificate)

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
  "expires_at": "2026-05-17 14:30:00",
  "cert_lifetime_days": 45
}
```

**Error responses:**
| Status | Meaning |
|--------|---------|
| `400` | Missing or invalid CSR, or renewal failed |
| `401` | Current cert is invalid or expired |
| `409` | Fingerprint collision — retry with a new key pair (`retry: true` in body) |

**Renewal process:**
1. Generate a **new** RSA key pair
2. Create a CSR with the new key
3. Call `/api/agent/renew-cert` using the **current** agent cert for mTLS auth
4. On success, atomically swap the old cert + key files with the new ones
5. The server preserves the old fingerprint during a grace period — both certs work until the old one expires

**When to renew:**
- When the current cert has **less than 15 days remaining** (check `cert_expires_at` from heartbeat)
- When the server sends a `renew_agent_cert` action (see Actions below)
- Recommended: check on every heartbeat cycle, comparing `cert_expires_at` against the current server time

**Handling 409 (fingerprint collision):**
If the response includes `"retry": true`, generate a completely new key pair and CSR and try again. This is astronomically unlikely but the server enforces fingerprint uniqueness.

---

### POST /api/agent/heartbeat

Health check / keepalive. The agent **must** call this at the interval specified in the response. The server uses heartbeats to track agent liveness — missed heartbeats trigger offline alerts.

**Auth:** mTLS

**Request body:**
```json
{
  "config_version": 1
}
```

Send the `config_version` value from the **previous** heartbeat response. This tells the server that the agent has acknowledged and applied that config version. On first heartbeat (or if unknown), send `0`.

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
  "cert_expires_at": "2026-04-02 14:30:00",
  "heartbeat_interval": 180,
  "config_version": 2,
  "actions": []
}
```

**Response fields:**

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Always `true` on success |
| `agent.id` | number | Agent's server-side ID |
| `agent.name` | string | Agent's display name |
| `deployments` | number | Total number of deployments assigned to this agent |
| `server_time` | string | Server's current time (ISO 8601) — use for time-skew detection |
| `cert_expires_at` | string | When the agent's mTLS agent cert expires (`YYYY-MM-DD HH:MM:SS` UTC) |
| `heartbeat_interval` | number | Seconds until the next heartbeat is expected. The agent **must** use this value as its heartbeat timer. |
| `config_version` | number | Latest global config version. Compare with the version you last sent. |
| `actions` | array | Server-initiated commands to execute (see Actions section below) |

**Heartbeat interval handling:**
- The agent should **always** use the server-provided `heartbeat_interval` value, not a local default.
- If `heartbeat_interval` changes between heartbeats, update the timer immediately.
- After applying a config change (detected via `config_version`), send an acknowledgment heartbeat right away — don't wait for the next scheduled one.

**Config version flow:**
1. Receive heartbeat response with `config_version: N`
2. Compare with the version you last acknowledged
3. If different: apply new config (update heartbeat timer to new `heartbeat_interval`), then immediately send another heartbeat with `config_version: N` in the request body
4. If same: normal operation, send `config_version: N` in the next scheduled heartbeat

---

### Actions

The `actions` array in the heartbeat response contains server-initiated commands. Actions are queued by administrators and delivered **exactly once** — the server clears them after including them in a heartbeat response.

| Action | Description | Agent Behavior |
|--------|-------------|----------------|
| `renew_agent_cert` | Admin requested the agent renew its mTLS certificate | Generate a new key pair + CSR, call `POST /api/agent/renew-cert`, swap cert files on success. Do this immediately, regardless of the current cert's remaining lifetime. |
| `update_agent` | Reserved for future self-update functionality | Log the action. No implementation required yet — this is a stub for a future feature where the server can instruct agents to pull and apply a new version of themselves. |

**Processing actions:**
- Process all actions in the array before sleeping for the next heartbeat
- Actions should be processed in order
- If `renew_agent_cert` fails (e.g. network error), the agent should retry on the next heartbeat cycle — the action has already been cleared server-side, so it won't be re-delivered
- Unknown actions should be logged and ignored (forward compatibility)

---

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

**Key fields:**

| Field | Description |
|-------|-------------|
| `id` | Deployment ID — used to download the bundle |
| `name` | Human-readable name (e.g. "nginx-proxy", "mail-server") |
| `enabled` | Whether this deployment is active — skip disabled deployments |
| `domains` | Array of domain names covered by this certificate |
| `cert_status` | Certificate status — only `active` certs can be downloaded |
| `staging` | Whether this is a Let's Encrypt staging (test) certificate |
| `content_hash` | SHA-256 hash of `fullchain.pem`, truncated to 16 hex chars. Compare with `last_deployed_hash` to detect renewals. `null` if cert is not active. |
| `last_deployed_at` | When this agent last downloaded this deployment's bundle |
| `last_deployed_hash` | The `content_hash` at the time of last download |

**Polling strategy:**
1. Call this endpoint on each heartbeat cycle (or on a separate timer if preferred)
2. For each **enabled** deployment where `cert_status === "active"`:
   - Compare `content_hash` with `last_deployed_hash`
   - If they differ (or `last_deployed_hash` is null), the cert has been renewed — download the bundle
3. Skip deployments where `enabled === false` or `cert_status !== "active"`

---

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

| Field | Description |
|-------|-------------|
| `fullchain` | Full certificate chain (leaf + intermediates) — used by most web servers |
| `cert` | Leaf certificate only — some configurations need this separately |
| `key` | Private key |
| `content_hash` | Hash of the fullchain — store this locally for comparison |

**Error responses:**
| Status | Meaning |
|--------|---------|
| `400` | Certificate not yet issued or not in `active` status |
| `404` | Deployment not found or doesn't belong to this agent |

**Side effect:** The server updates `last_deployed_at` and `last_deployed_hash` for this deployment when the bundle is downloaded. This is reflected in subsequent `GET /deployments` responses.

---

### GET /api/agent/time

Server clock endpoint for time-skew detection. **No authentication required.**

**Response (200):**
```json
{
  "server_time": "2026-02-15T10:30:00.000Z"
}
```

The agent should call this during startup (before enrollment or first heartbeat) to detect clock skew. If the agent's local time differs significantly from the server, TLS certificate validation and expiry calculations may fail.

**Recommended behavior:**
- Call on startup, compare with local time
- Log a warning if skew exceeds 30 seconds
- Use server time for cert expiry comparisons (the heartbeat also includes `server_time`)

---

## mTLS Connection Details

When making HTTPS requests to CertKeeper, the agent must configure its HTTP client with:

1. **Agent certificate:** The signed cert received from enrollment (or renewal)
2. **Client private key:** The locally generated private key
3. **CA certificate:** The CertKeeper CA cert (received during enrollment) — used to verify the server if it uses a self-signed TLS certificate

**Example with Node.js:**
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
  ca: fs.readFileSync('ca.crt'),
  headers: { 'Content-Type': 'application/json' },
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    const data = JSON.parse(body);
    console.log('Heartbeat OK, next in', data.heartbeat_interval, 'seconds');
  });
});
req.write(JSON.stringify({ config_version: 0 }));
req.end();
```

**Example with curl:**
```bash
curl --cert client.crt --key client.key --cacert ca.crt \
  -X POST -H 'Content-Type: application/json' \
  -d '{"config_version": 0}' \
  https://certkeeper.example.com:3000/api/agent/heartbeat
```

**Example with Python (requests):**
```python
import requests

resp = requests.post(
    'https://certkeeper.example.com:3000/api/agent/heartbeat',
    cert=('client.crt', 'client.key'),
    verify='ca.crt',
    json={'config_version': 0}
)
print(resp.json())
```

---

## Agent Lifecycle

```
INSTALL & ENROLL (one-time):
  1. User provides: CertKeeper URL + enrollment token
  2. Check server time (GET /api/agent/time) — warn if clock skew detected
  3. Generate RSA 2048 key pair locally
  4. Create PKCS#10 CSR
  5. POST /api/agent/enroll (Authorization: Bearer cke_<token>)
  6. Receive signed agent cert + CA cert → save to config dir
  7. Send initial heartbeat to confirm setup
  8. ✅ Ready — token is burned, mTLS is the only auth going forward

HEARTBEAT LOOP (ongoing, every heartbeat_interval seconds):
  1. POST /api/agent/heartbeat — send { config_version: <last_acked_version> }
  2. Receive: heartbeat_interval, config_version, actions, cert_expires_at
  3. Process actions:
     - "renew_agent_cert" → immediately trigger cert renewal flow
     - "update_agent" → log (stub, no action required yet)
     - unknown actions → log and skip
  4. If config_version changed:
     a. Apply new config (update heartbeat timer to new interval)
     b. Immediately send another heartbeat with new config_version to acknowledge
  5. Check cert_expires_at — if < 15 days remain, trigger cert renewal
  6. Sleep for heartbeat_interval seconds, then repeat from step 1

POLL & DEPLOY (on each heartbeat cycle or separate timer):
  1. GET /api/agent/deployments — list assigned certificates
  2. For each enabled deployment where content_hash ≠ last_deployed_hash:
     a. GET /api/agent/deployments/:id/bundle — download cert+key
     b. Write files to configured deployment path (atomic write recommended)
     c. Run post-deploy hooks (e.g. reload nginx, restart service)
  3. Skip disabled deployments and non-active certificates

CERT RENEWAL (when < 15 days remain on agent cert OR "renew_agent_cert" action):
  1. Generate new RSA 2048 key pair
  2. Create CSR with new key
  3. POST /api/agent/renew-cert (authenticated by current mTLS cert)
  4. On success: atomically swap cert + key files
  5. On 409 with retry:true: generate new key pair and retry
  6. Next request automatically uses the new cert

RE-ENROLLMENT (admin-initiated, when cert is expired or compromised):
  1. Admin clicks "Re-enroll" in CertKeeper UI → gets new enrollment token
  2. Old cert fingerprint is cleared server-side
  3. Agent must re-enroll using the new token (same flow as initial enrollment)
  4. All deployments are preserved — only the auth cert changes
```

---

## Error Handling

| HTTP Status | Meaning | Agent Action |
|-------------|---------|--------------|
| `200` | Success | Process response normally |
| `400` | Bad request (invalid CSR, cert not active) | Log error, fix the request — don't retry blindly |
| `401` | Authentication failed | Agent cert may be revoked, expired, or agent disabled. Log error, alert the operator. Stop heartbeats if persistent. |
| `403` | Agent disabled | The agent has been disabled server-side. Stop polling, log warning, alert the operator. |
| `404` | Not found | Deployment may have been removed. Update local state, remove local cert files if appropriate. |
| `409` | Conflict | During enrollment: agent already has a cert. During cert renewal: fingerprint collision — retry with new key pair if `retry: true`. |
| `500` | Server error | Retry with exponential backoff (e.g. 5s, 10s, 20s, 40s, max 5 min) |

**General retry strategy:**
- Network errors and 5xx: exponential backoff, cap at 5 minutes
- 4xx errors: do not retry (except 409 with `retry: true`)
- If the agent receives persistent 401s, it should enter a "waiting for re-enrollment" state and stop making API calls until the operator intervenes

---

## Configuration

The agent should support these configuration options:

| Option | Default | Description |
|--------|---------|-------------|
| `server_url` | *(required)* | CertKeeper server URL (e.g. `https://certkeeper.example.com:3000`) |
| `config_dir` | `/etc/certkeeper-agent` | Directory for agent config, certs, and keys |
| `heartbeat_interval` | `180` | **Initial** seconds between heartbeats. This is always overridden by the server's `heartbeat_interval` response. Only used before the first successful heartbeat. |
| `config_version` | `0` | Last acknowledged config version. Persisted locally, sent in heartbeat requests. |
| `renewal_threshold_days` | `15` | Renew agent cert when fewer than this many days remain |
| `deploy_dir` | `/etc/ssl/certkeeper` | Base directory for deployed certificate files |

**Important:** `heartbeat_interval` is server-authoritative. The agent should always use the value from the latest heartbeat response. The local default is only for the initial startup before the first heartbeat succeeds.

---

## File Layout

```
/etc/certkeeper-agent/
├── config.yml              # Agent configuration (server_url, deploy_dir, etc.)
├── state.json              # Runtime state (config_version, last heartbeat, etc.)
├── client.crt              # Agent certificate (from enrollment/renewal)
├── client.key              # Client private key (generated locally, NEVER transmitted)
├── ca.crt                  # CertKeeper CA cert (for server TLS verification)
└── deployments/            # Deployed certificates (one subdirectory per deployment)
    ├── nginx-proxy/
    │   ├── fullchain.pem   # Full chain (leaf + intermediates)
    │   ├── cert.pem        # Leaf certificate only
    │   └── privkey.pem     # Private key
    └── mail-server/
        ├── fullchain.pem
        ├── cert.pem
        └── privkey.pem
```

**File permissions:**
- `client.key` and all `privkey.pem` files: `0600` (owner read/write only)
- `client.crt`, `ca.crt`, `fullchain.pem`, `cert.pem`: `0644` (world readable)
- `config.yml`: `0600` (may contain the server URL which is mildly sensitive)

---

## Deployment Hooks

After writing certificate files to disk, the agent should support configurable post-deploy hooks to reload services that depend on those certificates. This is critical — most servers don't pick up new cert files without being told.

**Suggested configuration per deployment:**

```yaml
deployments:
  nginx-proxy:
    post_deploy: "systemctl reload nginx"
  mail-server:
    post_deploy: "systemctl restart postfix"
  haproxy-lb:
    post_deploy: "/usr/local/bin/haproxy-reload.sh"
```

**Hook execution guidelines:**
- Run hooks only when certificate files have actually changed
- Run as the agent's user (should have appropriate sudo/permissions)
- Log hook stdout/stderr for troubleshooting
- A failed hook should not prevent deploying other certificates
- Consider a timeout for hooks (e.g. 30 seconds)

---

## Security Considerations

- **Private keys never leave the agent.** Both the agent's mTLS key and all deployed certificate keys stay on the local filesystem. The agent generates its own key pairs locally.
- **Atomic file writes.** Write cert files to a temp file in the same directory, then `rename()` to the final path. This prevents services from reading partial files.
- **File permissions.** Private keys should be `0600`. The agent process should run as a dedicated user (not root if possible), with sudo access only for reloading services.
- **Enrollment token handling.** The enrollment token should be provided interactively or via a secure channel — not stored in config files after use. The token is burned server-side after enrollment and cannot be reused.
- **CA certificate pinning.** After enrollment, the agent has the CA cert and should use it exclusively for server verification (`ca.crt` in the TLS trust chain). This protects against MITM attacks even if the server uses a self-signed TLS certificate.
- **Clock synchronization.** The agent should verify that its system clock is reasonably in sync with the server (via `GET /api/agent/time`). Clock skew can cause TLS handshake failures and incorrect expiry calculations.
