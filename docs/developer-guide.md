# MJN Developer Guide

**What you need to know to build on the Imajin network.**

This is the practical companion to the [MJN whitepaper](./mjn-whitepaper.md). The whitepaper explains *why*. This explains *how*.

---

## What MJN Actually Is

MJN is a set of HTTP services that add identity, attribution, and payments to your app. There's no special browser. No special protocol. No SDK required. It's JSON over HTTPS.

You interact with MJN the same way you interact with Stripe or Auth0 — by calling APIs.

**The reference implementation** is 15 services running at `*.imajin.ai`:

| Service | URL | What It Does |
|---------|-----|-------------|
| **auth** | auth.imajin.ai | Identity — DIDs, authentication, sessions, attestations, DFOS bridge |
| **profile** | profile.imajin.ai | Public profiles, handles, discovery |
| **connections** | connections.imajin.ai | Trust graph — pods, invites, groups, vouch attestations |
| **pay** | pay.imajin.ai | Payments — Stripe checkout, balances, settlement with .fair verification |
| **events** | events.imajin.ai | Events, tickets, check-in, registration surveys |
| **chat** | chat.imajin.ai | DID-based messaging — conversations, media, reactions, WebSocket |
| **media** | media.imajin.ai | Asset storage with .fair attribution, DID-pegged folders |
| **input** | input.imajin.ai | Voice transcription (Whisper), file upload relay |
| **learn** | learn.imajin.ai | Courses, modules, presentations, enrollment, progress |
| **market** | market.imajin.ai | Consent-based local commerce, listings, seller dashboards |
| **registry** | registry.imajin.ai | Node federation, service discovery |
| **www** | imajin.ai | Landing page, essays, bug reports, app launcher |
| **coffee** | coffee.imajin.ai | Tipping / support pages |
| **links** | links.imajin.ai | Link-in-bio pages |
| **dykil** | dykil.imajin.ai | Community spending surveys |

Every service exposes an OpenAPI spec at `/api/spec`.

---

## The 5-Minute Walkthrough

Here's a complete flow: create an identity, buy an event ticket, and see .fair attribution — using nothing but `curl`.

### Step 1: Get an Identity (Soft DID — Email)

The simplest path. No cryptography. Just an email address.

```bash
# Start onboarding — sends a verification email
curl -X POST https://auth.imajin.ai/api/onboard \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "name": "Your Name"}'

# Response: { "sent": true }
# Check your email, click the link. You now have a soft DID.
# Format: did:imajin:xxx (stable — same format as hard DIDs)
```

A soft DID lets you buy tickets, enroll in courses, and chat. No keypair needed. Your email is stored as a credential attached to the DID, not embedded in the DID itself.

### Step 2: Get an Identity (Hard DID — Keypair)

For full sovereignty. You generate the keys. Nobody can revoke your identity.

```bash
# Generate an Ed25519 keypair (Node.js example)
node -e "
  const ed = require('@noble/ed25519');
  const priv = ed.utils.randomPrivateKey();
  const pub = ed.getPublicKey(priv);
  console.log('Private:', Buffer.from(priv).toString('hex'));
  console.log('Public:', Buffer.from(pub).toString('hex'));
"
```

```bash
# Register with your public key (invite-only — you need an invite code)
curl -X POST https://auth.imajin.ai/api/register \
  -H "Content-Type: application/json" \
  -d '{
    "publicKey": "<your-public-key-hex>",
    "handle": "yourhandle",
    "name": "Your Name",
    "type": "human",
    "signature": "<sign-the-payload-with-your-private-key>",
    "inviteCode": "<invite-code>"
  }'

# Response: { "did": "did:imajin:5Qn8...", "handle": "yourhandle", "created": true }
# Your DID is derived from your public key. It's also a valid Solana wallet.
```

### Step 3: Log In (Challenge-Response)

```bash
# Request a challenge
curl -X POST https://auth.imajin.ai/api/login/challenge \
  -H "Content-Type: application/json" \
  -d '{"handle": "yourhandle"}'

# Response: { "challengeId": "chl_abc123", "challenge": "a1b2c3...", "expiresAt": "..." }

# Sign the challenge with your private key, then verify
curl -X POST https://auth.imajin.ai/api/login/verify \
  -H "Content-Type: application/json" \
  -d '{
    "challengeId": "chl_abc123",
    "signature": "<sign-the-challenge-hex-with-your-private-key>"
  }'

# Response: sets a session cookie. You're authenticated.
```

### Step 4: Buy a Ticket

```bash
# List events
curl https://events.imajin.ai/api/events

# Start checkout for a specific event tier
curl -X POST https://events.imajin.ai/api/checkout \
  -H "Content-Type: application/json" \
  -H "Cookie: imajin_session=<your-session-token>" \
  -d '{"eventId": "evt_abc123", "tierId": "tier_xyz"}'

# Response: { "checkoutUrl": "https://checkout.stripe.com/..." }
# Complete payment on Stripe. Webhook confirms → ticket created.
```

### Step 5: See .fair Attribution

Every event (and every media asset) has a .fair manifest:

```bash
curl https://events.imajin.ai/api/events/<event-id>/fair

# Response:
# {
#   "version": "0.3.0",
#   "type": "event",
#   "title": "Jin's Launch Party",
#   "contributors": [
#     { "id": "did:imajin:5Qn8...", "role": "curator", "weight": 0.7 },
#     { "id": "did:imajin:8Xk2...", "role": "artist", "weight": 0.3 }
#   ],
#   "transfer": { "allowed": false, "refundable": false }
# }
```

The .fair manifest is a JSON sidecar. It says who made it and how revenue splits. It travels with the content.

---

## Core Concepts

### Identity: Three Tiers

All DIDs use the same stable format: `did:imajin:xxx`. Identity is decoupled from authentication method.

| Tier | How You Get It | What You Can Do |
|------|---------------|----------------|
| **Soft** | Verify an email | Buy tickets, enroll in courses, chat |
| **Preliminary** | Generate an Ed25519 keypair + invite code | Create events, connect, full trust graph |
| **Established** | Earn through participation + attestation history | Invite new people, vouch, create Cultural DIDs |

Tiers upgrade seamlessly. All history, attestations, and tickets carry over — the DID never changes.

### Authentication: Three Paths

1. **Magic link** (email) → Soft DID session
2. **Challenge-response** (Ed25519 signature) → Preliminary/Established DID session
3. **DFOS chain** → Bridged identity (same Ed25519 keypair, dual DID)

Both return a session cookie (`imajin_session` / `imajin_session_dev`) that works across all `*.imajin.ai` services.

### .fair: Attribution as JSON

A `.fair.json` file is metadata that says who contributed to something and how value should split. It's not a protocol — it's a file format. Any platform can read it. Manifests are cryptographically signed with Ed25519.

```json
{
  "id": "track-123",
  "type": "track",
  "title": "My Song",
  "version": "0.3.0",
  "contributors": [
    { "id": "did:imajin:5Qn8...", "role": "artist", "weight": 0.6 },
    { "id": "did:imajin:8Xk2...", "role": "producer", "weight": 0.4 }
  ],
  "signature": "...",
  "platformSignature": "..."
}
```

The media service auto-creates .fair sidecars on upload. Events carry them for revenue splitting. Settlement verifies signatures cryptographically before processing payments.

### Trust Graph

Relationships between identities. Pods (1:1 connections), groups, invites. The trust graph determines who can reach whom — messaging, discovery, and the declared-intent marketplace all route through it. Every connection action emits cryptographic attestations (`connection.invited`, `connection.accepted`, `vouch`).

```bash
# Create an invite link
curl -X POST https://connections.imajin.ai/api/invites \
  -H "Cookie: imajin_session=<token>"

# Check connection status
curl https://connections.imajin.ai/api/connections/status/<their-did> \
  -H "Cookie: imajin_session=<token>"
```

### Attestations

Cryptographically signed records of actions and trust. Live attestation types:

| Type | Emitted By | What It Records |
|------|-----------|----------------|
| `transaction.settled` | pay | Payment processed with .fair chain |
| `customer` | pay | First transaction with a service |
| `connection.invited` | connections | Invite extended |
| `connection.accepted` | connections | Invite accepted |
| `vouch` | connections | Inviter vouches for acceptee |
| `session.created` | auth | Login with auth strength metadata |

```bash
# Query attestations for a DID
curl https://auth.imajin.ai/api/attestations?subject_did=did:imajin:xxx&type=vouch \
  -H "Cookie: imajin_session=<token>"
```

### Chat (DID-Based)

Every conversation is a DID. DMs, groups, and event chats all use the same primitives:

```bash
# Send a message to a conversation
curl -X POST https://chat.imajin.ai/api/d/did:imajin:event:summer-camp/messages \
  -H "Content-Type: application/json" \
  -H "Cookie: imajin_session=<token>" \
  -d '{"content": "Hello everyone!"}'
```

Real-time via WebSocket with deferred token authentication. `<Chat did="..." />` drop-in component available in `@imajin/chat`.

### Payments

Stripe-backed today. Every service that charges calls `pay.imajin.ai`:

```bash
# Check balance
curl https://pay.imajin.ai/api/balance/<your-did> \
  -H "Cookie: imajin_session=<token>"

# View transaction history
curl https://pay.imajin.ai/api/transactions/<your-did> \
  -H "Cookie: imajin_session=<token>"
```

---

## Building on Imajin

### Option A: Use the APIs Directly

Every service is a standard REST API. Call them from any language. Session cookies handle auth across services.

Each service publishes an OpenAPI spec:
```bash
curl https://auth.imajin.ai/api/spec
curl https://events.imajin.ai/api/spec
curl https://pay.imajin.ai/api/spec
# etc.
```

### Option B: Run Your Own Node

The entire stack is open source. Self-host on a Raspberry Pi, a VPS, or a server in your closet.

```
git clone https://github.com/ima-jin/imajin-ai
cd imajin-ai
pnpm install
# Configure .env.local for each service
# See docs/ENVIRONMENTS.md for port assignments
```

Register your node with the federation registry:
```bash
curl -X POST https://registry.imajin.ai/api/node/register \
  -H "Content-Type: application/json" \
  -d '{"did": "<your-node-did>", "hostname": "yournode.example.com"}'
```

### Option C: Add .fair to Your Existing App

You don't need Imajin at all. Just create `.fair.json` files alongside your content:

```bash
echo '{
  "id": "my-project",
  "type": "project",
  "title": "My Project",
  "version": "0.3.0",
  "contributors": [
    { "id": "alice@example.com", "role": "engineer", "weight": 0.7 },
    { "id": "bob@example.com", "role": "engineer", "weight": 0.3 }
  ]
}' > my-project.fair.json

# Validate against the schema
npx ajv-cli validate -s node_modules/.fair/schema/fair.schema.json -d my-project.fair.json
```

---

## Architecture

```
┌─────────────────────────────────────────┐
│           Trust-Gated Services          │
│ events · chat · media · learn · input   │
│ market · coffee · links · dykil         │
├─────────────────────────────────────────┤
│          Attestation Layer              │
│  6 live types · crypto verification     │
│        countersignatures                │
├─────────────────────────────────────────┤
│           Trust Graph Layer             │
│        connections · pods · vouches     │
├─────────────────────────────────────────┤
│    Identity + Commerce + Protocol       │
│  auth (stable DIDs) · pay (Stripe/SOL) │
│  DFOS bridge · key rotation · CID      │
├─────────────────────────────────────────┤
│       Attribution + Discovery           │
│       .fair · registry · profile        │
├─────────────────────────────────────────┤
│          Physical Presence              │
│         Unit 8×8×8 · GPU Node          │
└─────────────────────────────────────────┘
```

**Key architectural decisions:**
- **Ed25519 keypairs** for identity. Your DID is derived from your public key. It's also a valid Solana wallet address — no bridging needed. Same keypair bridges to DFOS (`did:dfos`) chains.
- **Stable DIDs** — all identities are `did:imajin:xxx` from birth. Email is a credential, not the identity. Tier reflects credential strength, not DID format.
- **Shared session cookies** across `*.imajin.ai`. Authenticate once, use everywhere. Dev/prod isolated (`imajin_session_dev` / `imajin_session`).
- **Postgres** for all services. Each service has its own schema in a shared database. Per-service migration tracking.
- **Next.js** API routes. Standard Node.js. No custom framework.
- **.fair sidecars** travel with content. Cryptographically signed. Settlement verifies signatures before processing.
- **DID-based conversations** — every chat conversation is a DID (`did:imajin:event:*`, `did:imajin:dm:*`, `did:imajin:group:*`). Auth service is the single access control authority.
- **Attestations** — every trust-relevant action emits a cryptographic attestation. Attestations are the substance of the trust graph.

---

## What Exists Today vs. What's Planned

### Live Now (March 2026)
- ✅ Three-tier DID identity (soft/preliminary/established) — all `did:imajin:xxx` from birth
- ✅ Challenge-response auth + magic link + DFOS chain bridge
- ✅ Events with Stripe payments and .fair attribution (66 tickets sold)
- ✅ Trust graph (pods, invites, groups, vouch attestations)
- ✅ DID-based real-time chat with WebSocket, media, reactions
- ✅ Media service with .fair sidecars and DID-pegged storage
- ✅ Course platform with presentations and interactive content
- ✅ Consent-based marketplace (listings, seller dashboards, checkout)
- ✅ Attestation infrastructure — 6 live types with cryptographic signing
- ✅ Cryptographic .fair signature verification at settlement
- ✅ DFOS protocol bridge (key rotation, CID, countersignatures)
- ✅ Federation registry
- ✅ 15 services, self-hosted, ~120 registered identities
- ✅ Postgres backups (hourly, local + NAS)

### Coming Next
- ⏳ DFOS adoption across all services (P25 — 10 issues)
- ⏳ `@imajin/graph` trust-scoped query layer
- ⏳ Standing computation (reputation from attestation history)
- ⏳ Portable exit credentials (take your reputation when you leave)
- ⏳ MJN token settlement on Solana (currently Stripe-only)
- ⏳ The AttMart — declared-intent attention marketplace
- ⏳ Family / Cultural / Org DID scopes
- ⏳ Places app (local business discovery, check-ins)

---

## FAQ

**Do I need crypto to use this?**
No. Payments are Stripe. Identity works with just an email. Crypto (Ed25519 keypairs, Solana settlement) is available for those who want sovereignty — but it's never required.

**Is this a blockchain project?**
The identity layer uses Ed25519 cryptography (same as Solana). Your DID happens to be a valid Solana wallet. The platform also bridges to DFOS chains for cryptographic identity proofs. But the platform runs on Postgres and HTTP today. On-chain settlement is planned, not shipped.

**What's the difference between MJN and .fair?**
.fair is a JSON file format for attribution (who made it, who gets paid). MJN is the network that routes identity, trust, and settlement around those attributions. You can use .fair without MJN. You can't use MJN without .fair.

**What's the DFOS bridge?**
DFOS (by Metalabel) is an open-source cryptographic identity protocol. Imajin bridges to it — same Ed25519 keypair produces both a `did:imajin:xxx` and a `did:dfos:xxx`. Your DFOS chain provides cryptographic proofs of identity history (key rotation, countersignatures). Imajin is Layer 6 — the economic, settlement, and inference layer on top of DFOS's proof substrate.

**Can I use this without Imajin?**
Yes. The APIs are open. The code is open source. .fair is a standalone file format. Run your own node or just adopt the parts you want.

**Where's the SDK?**
Not yet. For now, it's direct HTTP calls. The OpenAPI specs at `/api/spec` can generate client libraries in any language.

---

## Links

- **Source code:** [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)
- **Whitepaper:** [MJN Protocol Specification](./mjn-whitepaper.md)
- **.fair spec:** [github.com/ima-jin/.fair](https://github.com/ima-jin/.fair)
- **OpenAPI specs:** `https://<service>.imajin.ai/api/spec`
- **First demonstration:** April 1, 2026

---

*The whitepaper tells you why this matters. This guide tells you how it works. Start with `curl` and go from there.*

*Updated March 21, 2026. 15 services, ~120 identities, 830+ commits.*
