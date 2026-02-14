# registry.imajin.ai

**The phone book for the sovereign network.**

## What It Does

Registry is the discovery layer for the Imajin federated network. Anyone running a signed Imajin build can register for a `{hostname}.imajin.ai` subdomain.

```
┌─────────────────────────────────────────────────────────────┐
│                    REGISTRY SERVICE                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Node Registration                                          │
│  └─ Verify build attestation                                │
│  └─ Check hostname availability                             │
│  └─ Provision subdomain via Cloudflare                      │
│  └─ Store in database                                       │
│                                                             │
│  Heartbeat Tracking                                         │
│  └─ Daily liveness pings                                    │
│  └─ Health status monitoring                                │
│  └─ Stale/unreachable detection                             │
│                                                             │
│  Network Directory                                          │
│  └─ Public node listing                                     │
│  └─ Lookup by DID or hostname                               │
│  └─ Service discovery                                       │
│                                                             │
│  Build Verification                                         │
│  └─ Known release hashes                                    │
│  └─ Approved fork registry                                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Status

- **Phase**: Scaffold
- **Deployed**: Not yet
- **URL**: registry.imajin.ai (planned)

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/node/register` | Register a new node |
| `POST` | `/api/node/heartbeat` | Send liveness ping |
| `GET` | `/api/node/list` | List all active nodes |
| `GET` | `/api/node/lookup/:id` | Find node by DID or hostname |
| `POST` | `/api/builds/verify` | Check if build hash is approved |

## Data Model

### Nodes Table

```typescript
{
  id: string;              // did:imajin:xxx (primary key)
  publicKey: string;       // Ed25519 hex
  hostname: string;        // "jin" (unique)
  subdomain: string;       // "jin.imajin.ai"
  services: string[];      // ["auth", "pay", "profile"]
  capabilities: string[];  // What this node offers
  status: NodeStatus;      // active | stale | unreachable | expired
  buildHash: string;       // SHA256 of running build
  version: string;         // Semantic version
  lastHeartbeat: Date;     // Most recent ping
  registeredAt: Date;      // First registration
  expiresAt: Date;         // When registration expires
  attestation: JSON;       // Full attestation record
}
```

### Approved Builds Table

```typescript
{
  version: string;         // "0.1.0"
  buildHashes: string[];   // Valid hashes for this version (multi-arch)
  releaseDate: Date;       // When released
  minVersion: string;      // Minimum supported (for deprecation)
  notes: string;           // Release notes
}
```

## TTLs (from @imajin/auth)

| Purpose | Duration |
|---------|----------|
| Registration | 30 days |
| Heartbeat interval | 24 hours |
| Stale threshold | 3 missed heartbeats |
| Unreachable threshold | 7 missed heartbeats |
| Grace period | 7 days after expiry |

## Decentralization Path

This registry is **federated, not decentralized**. It's a bootstrapping convenience.

**Current (Federated):**
- Central registry for discovery
- We provision DNS/SSL
- Open source, forkable

**Future (Decentralized):**
- On-chain node registry (Solana)
- ENS-style naming
- Mesh trust discovery (optical verification)

The exit door is always open.

## Environment Variables

```bash
# Database
DATABASE_URL=postgres://...

# Cloudflare (subdomain provisioning)
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ZONE_ID=...

# Signing (registry's own identity)
REGISTRY_PRIVATE_KEY=...
```

## Related

- `packages/auth` - TTL constants, node types
- `apps/auth` - Identity service (nodes register here first)
- `imajin-token/LIGHT_AUTH_SPEC.md` - Mesh trust protocol
- `imajin-token/ARCHITECTURE.md` - Network topology
