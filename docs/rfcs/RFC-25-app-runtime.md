# RFC-25: App Runtime — Sandboxed Execution for Third-Party Applications

**Status:** Draft  
**Author:** Ryan Veteze, Jin  
**Created:** 2026-04-12  
**Related:** RFC-19 (Kernel/Userspace), #465 (Agent Sandbox), #685 (Market .fair)

---

## Abstract

Imajin nodes currently run a fixed set of first-party applications (events, market, coffee, learn, etc.) as trusted userspace processes with direct database access. This RFC proposes an **app runtime** that allows third-party developers to deploy applications onto Imajin nodes in sandboxed containers, with kernel APIs exposed through a metered gateway.

The kernel becomes an operating system. Applications become processes. The `.fair` chain ensures every participant — protocol, node operator, app developer, and seller — earns from the value they create.

---

## Motivation

### The Opportunity

Imajin's kernel provides identity, payments, attribution, storage, connections, and messaging as composable services. Any application that needs "users who can pay each other and prove things about each other" can be built on top of these primitives.

Today, only Imajin Inc. ships applications. Opening the runtime to third-party developers creates:

1. **A marketplace of capabilities** — booking, invoicing, inventory, CRM, ticketing, education — built by specialists, running on sovereign infrastructure.
2. **Revenue for everyone** — developers earn per-transaction fees. Node operators earn hosting fees. The protocol earns its 1%.
3. **Network effects** — each new app makes every node more valuable. Each new node makes every app more reachable.

### The Problem with Platforms

Traditional app stores extract 30%, dictate terms, and own the relationship. Imajin's model is different:

- **The node operator is the host**, not a platform. They choose which apps to run.
- **The developer sets their own fee**, encoded in the `.fair` manifest.
- **The user's identity is their own** — portable across nodes, apps, and contexts.
- **The app's code is verifiable** — published to a registry, hash-checked on deployment.

### Prior Art

| System | Model | Limitation |
|--------|-------|------------|
| iOS/Android | Centralized app store, 30% cut | Platform owns distribution + identity |
| Cloudflare Workers | V8 isolates, pay-per-request | No identity layer, no settlement |
| Heroku | Container hosting | No multi-tenant identity, no attribution |
| Shopify Apps | OAuth + REST APIs | Tied to Shopify's commerce model |
| DFOS | Federated data, any device is a node | No application execution layer |

Imajin's app runtime combines federated identity (DFOS), cryptographic attribution (.fair), and sovereign hosting (your hardware, your rules) into an execution environment that doesn't exist elsewhere.

---

## Architecture

### System Model

```
┌─────────────────────────────────────────────────────┐
│                   SHELL (Browser)                    │
│                                                      │
│   Launcher → discovers apps from registry            │
│   Toolbar  → identity switcher, notifications        │
│   Iframe   → each app renders in sandboxed frame     │
│   postMessage → shell ↔ app communication            │
└────────────────────────┬────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────┐
│                      CADDY                           │
│                                                      │
│   /auth, /pay, /media, ...  → Kernel (port 7000)   │
│   /events, /market, ...     → Trusted userspace     │
│   /app/<id>/*               → Sandbox Gateway       │
└────────────────────────┬────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────┐
│                      NODE                            │
│                                                      │
│   KERNEL ─────────── system services                 │
│     auth, pay, profile, connections, chat,           │
│     media, registry, notify                          │
│                                                      │
│   USERSPACE (trusted) ── first-party apps            │
│     events, market, coffee, learn, dykil, links      │
│     Direct DB access, full kernel imports             │
│                                                      │
│   SANDBOX GATEWAY ──── third-party app runtime       │
│     Container management                             │
│     Auth forwarding                                  │
│     Gas metering                                     │
│     Scope enforcement                                │
│     API proxying                                     │
│     Audit logging                                    │
│                                                      │
│   POSTGRES ─────────── isolated schemas              │
│     kernel schemas (auth, pay, etc.)                 │
│     userspace schemas (events, market, etc.)         │
│     app schemas (app_<id>) — one per sandboxed app   │
│                                                      │
│   DFOS RELAY ────────── federation                   │
│     Identity chains, app registration chains,        │
│     attestation chains, peer mesh                    │
└──────────────────────────────────────────────────────┘
```

### Trust Tiers

| Tier | Access | Examples |
|------|--------|----------|
| **Kernel** | Full DB, all schemas, all APIs, host filesystem | auth, pay, media |
| **Trusted Userspace** | Direct DB (own schema), kernel imports, no sandbox | events, market, coffee |
| **Sandboxed App** | Own schema only, kernel APIs through gateway, gas-metered | Third-party apps |
| **Static Content** | No server execution, CDN-served | Landing pages, docs |

Trusted userspace is the current model for Imajin's own apps. The sandbox tier is new — it provides the same kernel capabilities with isolation guarantees.

---

## Sandbox Gateway

The gateway is the enforcement layer between sandboxed apps and the kernel.

### Responsibilities

1. **Auth forwarding** — reads the session cookie, validates with kernel, passes identity to the app as headers (`X-Session-DID`, `X-Acting-As`, `X-Session-Tier`).

2. **API proxying** — app calls `/_kernel/auth/api/session` → gateway rewrites to `http://localhost:7000/auth/api/session`, forwards auth headers, returns response.

3. **Gas metering** — every proxied API call decrements the app's gas budget. When gas runs out, requests are rejected until the next period. Gas is denominated in MJN.

4. **Scope enforcement** — app declares which scopes it operates in. Gateway rejects requests that access data outside those scopes.

5. **Rate limiting** — per-app, per-endpoint. Prevents abuse independent of gas.

6. **Audit logging** — every proxied request logged with app DID, target endpoint, gas cost, response status.

### Allowed Kernel APIs

Apps declare required permissions in their manifest. The gateway enforces:

| Permission | Endpoint | Description |
|------------|----------|-------------|
| `auth:session:read` | `GET /auth/api/session` | Read current user identity |
| `auth:attestations:emit` | `POST /auth/api/attestations` | Emit attestations |
| `auth:attestations:read` | `GET /auth/api/attestations/*` | Query attestations |
| `pay:settle` | `POST /pay/api/settle` | Execute .fair settlement |
| `pay:balance:read` | `GET /pay/api/balance/*` | Read balances |
| `profile:read` | `GET /profile/api/profile/*` | Read profiles |
| `connections:read` | `GET /connections/api/*` | Query connections |
| `media:upload` | `POST /media/api/assets` | Upload files |
| `media:read` | `GET /media/api/assets/*` | Read files |
| `notify:send` | `POST /notify/api/send` | Send notifications |

APIs not in the allowlist are unreachable. Admin endpoints, migration endpoints, and internal service-to-service routes are never exposed.

### App ↔ Gateway Protocol

From the app's perspective, kernel APIs are available at a predictable base URL:

```
# App's environment
KERNEL_GATEWAY_URL=http://gateway:9000/_kernel

# App makes a request
fetch(`${KERNEL_GATEWAY_URL}/auth/api/session`, {
  headers: { 'X-App-Token': process.env.APP_TOKEN }
})
```

The gateway:
1. Validates `X-App-Token` (issued at registration)
2. Checks permission for `/auth/api/session` → `auth:session:read` ✓
3. Decrements gas: 1 unit
4. Forwards to `http://localhost:7000/auth/api/session` with session cookie
5. Returns response to app

---

## App Manifest

Published to the registry (and optionally to DFOS chain) when a developer registers their app.

```json
{
  "did": "did:imajin:app:booking-calendar",
  "name": "Booking Calendar",
  "description": "Appointment scheduling with .fair settlement",
  "version": "1.2.0",
  "developer": {
    "did": "did:imajin:abc...",
    "name": "Calendar Co.",
    "contact": "dev@calendarco.example"
  },
  "bundle": {
    "hash": "sha256:a1b2c3...",
    "url": "https://registry.imajin.ai/apps/booking-calendar/1.2.0.tar.gz",
    "entry": "server.js",
    "runtime": "node22"
  },
  "permissions": [
    "auth:session:read",
    "auth:attestations:emit",
    "pay:settle",
    "profile:read",
    "connections:read",
    "media:upload",
    "media:read"
  ],
  "scopes": ["community", "org", "family"],
  "resources": {
    "db_schema": true,
    "max_storage_mb": 100,
    "max_memory_mb": 512,
    "max_cpu": 0.5
  },
  "economics": {
    "developer_fee_bps": 50,
    "fair_chain_position": "after_node",
    "gas_model": "per_request"
  },
  "ui": {
    "launcher_icon": "📅",
    "launcher_label": "Booking",
    "shell_integration": true
  }
}
```

### Manifest Verification

1. Developer signs manifest with their DID keypair
2. Bundle hash is verified on pull
3. Node operator reviews permissions before approval
4. Registry stores manifest + signature on DFOS chain
5. Other nodes can verify app authenticity before installing

---

## Economics

### The .fair Chain with Developer Fee

When a sandboxed app facilitates a transaction, the `.fair` chain includes a developer fee:

```
Protocol    1.00%     → did:imajin:platform
Node        0.50%     → node DID
Developer   0.50%     → app developer DID (from manifest)
Buyer       0.25%     → buyer DID (MJN credit)
Seller     97.75%     → seller DID (Stripe Connect)
```

The developer fee is declared in the manifest (`developer_fee_bps`) and injected into every `.fair` chain the app creates. The node operator can cap it.

### Gas Economy

Apps consume gas for every kernel API call. Gas is denominated in MJN.

| Operation | Gas Cost |
|-----------|----------|
| Read session | 1 |
| Read profile | 1 |
| Query connections | 2 |
| Query attestations | 2 |
| Emit attestation | 5 |
| Upload media | 10 |
| Settle payment | 10 |
| Send notification | 3 |

Gas budgets are set per-app by the node operator. Apps can purchase additional gas with MJN. This prevents abuse while creating a real cost for kernel resource consumption.

### Who Pays for Gas?

Three models (node operator chooses per app):

1. **Developer-funded** — developer pre-purchases gas. Good for free apps.
2. **Scope-funded** — the community/org running the app pays from scope fees.
3. **User-funded** — gas cost embedded in transaction fees. Good for commerce apps.

---

## Container Runtime

### Phase 1: Docker (Immediate)

```bash
# Node operator approves app, system runs:
docker create \
  --name imajin-app-xyz \
  --network imajin-sandbox \
  --memory 512m \
  --cpus 0.5 \
  --env KERNEL_GATEWAY_URL=http://gateway:9000/_kernel \
  --env APP_TOKEN=<issued_token> \
  --env DATABASE_URL=postgresql://app_xyz:...@db:5432/imajin_prod \
  --env PORT=9001 \
  registry.imajin.ai/apps/xyz:1.2.0

# Caddy config added:
# /app/xyz/* → localhost:9001
```

Docker networking isolates the container. It can reach the gateway but not kernel ports directly. The `DATABASE_URL` connects to an isolated schema — Postgres roles enforce row-level access.

### Phase 2: V8 Isolates (Medium-term)

For apps that don't need a full Node.js runtime — lightweight request handlers:

```javascript
// App code — runs in an isolate per request
export default {
  async fetch(request, env) {
    const session = await env.kernel.auth.getSession();
    const slots = await env.db.query('SELECT * FROM slots WHERE date = $1', [date]);
    return new Response(JSON.stringify(slots));
  }
}
```

Sub-millisecond cold start. Thousands of apps per node. Kernel APIs injected as `env.kernel`. Database access through a scoped client.

### Phase 3: WASM (Long-term)

App bytecode stored on DFOS chain. Any node can pull and run verified WASM modules. Language-agnostic — Rust, Go, C, AssemblyScript. Strongest isolation guarantees (linear memory, no host access except explicit imports).

---

## App Lifecycle

### Registration

```
Developer                    Registry                    Node Operator
    │                            │                            │
    │  1. Build + bundle         │                            │
    │  2. Sign manifest          │                            │
    │  3. Publish ──────────────>│                            │
    │                            │  4. Store on DFOS chain    │
    │                            │                            │
    │                            │  5. App discoverable ─────>│
    │                            │                            │
    │                            │          6. Review manifest │
    │                            │          7. Approve         │
    │                            │          8. Pull bundle     │
    │                            │          9. Create schema   │
    │                            │         10. Start container │
    │                            │         11. Add Caddy route │
    │                            │                            │
    │  <──── app live on node ───┤────────────────────────────│
```

### Updates

Developer publishes new version → node operator reviews diff → approves → container replaced with zero-downtime swap. Old version kept for rollback.

### Removal

Node operator removes app → container stopped → Caddy route removed → schema preserved (data export period) → schema dropped after retention window.

---

## Security Model

### Isolation Guarantees

1. **Network isolation** — containers on a Docker bridge network. Can reach gateway only. Cannot reach kernel ports, other app containers, or host network.
2. **Database isolation** — each app gets a Postgres role scoped to `app_<id>` schema. Row-level security where needed.
3. **Identity isolation** — apps see the user's DID and session but cannot impersonate users or forge attestations (kernel validates signatures).
4. **Resource isolation** — memory limits, CPU limits, storage quotas, gas budgets. All enforced at container and gateway level.

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Malicious app steals user data | App only sees data for its own scope. No cross-schema access. |
| App impersonates another app | App token is unique, tied to app DID. Gateway validates. |
| App drains node resources | Gas metering + container resource limits. |
| App sends spam notifications | Gas cost per notification. Node operator can revoke. |
| Developer pushes malicious update | Node operator reviews before deployment. Bundle hash verified. |
| App creates fake attestations | Kernel validates issuer signature. App DID is the issuer — attestations are traceable. |

### Audit Trail

Every gateway-proxied request is logged:
- App DID, endpoint, method, gas cost, response status, timestamp
- Stored in `registry.app_audit_log`
- Queryable from admin console
- Attestation-backed for disputed transactions

---

## Migration Path

### Step 1: Gateway MVP
Build the sandbox gateway as a standalone Node.js service. Docker containers for apps. Manual registration via CLI.

### Step 2: Admin Console Integration
Node operators manage apps from `/admin` — approve, configure gas, monitor usage, remove.

### Step 3: Developer Portal
Public registry where developers publish apps. Discovery in the launcher. One-click install for node operators.

### Step 4: Federated App Discovery
Apps published to DFOS chain. Nodes discover apps from peers. Install from any node in the mesh.

---

## Relationship to Existing Work

- **RFC-19 (Kernel/Userspace):** This RFC extends the userspace model with a sandboxed tier. Trusted userspace remains for first-party apps.
- **#465 (Agent Sandbox):** Agents are a special case of sandboxed apps — same gateway, same gas metering, same scope isolation. The agent sandbox becomes a flavor of the app runtime.
- **#685 (Market .fair):** Market listings need `.fair` manifests. Third-party commerce apps follow the same pattern.
- **DFOS:** App manifests and registration chains are DFOS data. Federation means apps are discoverable across the network.

---

## Open Questions

1. **Should trusted userspace apps migrate to the sandbox model?** Events, market, etc. could run as sandboxed apps with elevated permissions. Simplifies the architecture but adds overhead.

2. **How do apps handle real-time features?** WebSocket connections through the gateway? Direct WS from shell to app? Kernel WS relay?

3. **What's the minimum gas budget for a useful app?** Need benchmarks on real API call patterns.

4. **Should the developer fee be negotiable per-node?** Manifest sets a default, node operator can negotiate? Or is the manifest fee final?

5. **How do apps handle migrations?** Schema changes on update — who runs them? App includes migration files, gateway runs them in a transaction?
