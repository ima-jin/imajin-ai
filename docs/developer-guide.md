# MJN Developer Guide

**What you need to know to build on the Imajin network.**

This is the practical companion to the MJN protocol RFCs. The RFCs explain *why*. This explains *how*.

---

## What MJN Actually Is

MJN is a set of HTTP services that add identity, attribution, and payments to your app. There's no special browser. No special protocol. No SDK required. It's JSON over HTTPS.

You interact with MJN the same way you interact with Stripe or Auth0 — by calling APIs.

**The reference implementation** has one kernel plus independently owned apps.
The table is a capability/routing map, not a workspace or live deployment inventory;
current source inventory and dated acceptance evidence live in the [root README](../README.md).

| Service | URL | What It Does |
|---------|-----|-------------|
| **auth** | jin.imajin.ai/auth | Identity — DIDs, authentication, sessions, attestations, DFOS bridge |
| **profile** | jin.imajin.ai/profile | Public profiles, handles, discovery |
| **connections** | jin.imajin.ai/connections | Trust graph — pods, invites, groups, vouch attestations |
| **pay** | jin.imajin.ai/pay | Payments — Stripe checkout, balances, settlement with .fair verification |
| **events** | jin.imajin.ai/events | Events, tickets, check-in, registration surveys — standalone [ima-jin/events](https://github.com/ima-jin/events), not a kernel workspace app (#2517) |
| **chat** | jin.imajin.ai/chat | DID-based messaging — conversations, media, reactions, WebSocket |
| **notify** | jin.imajin.ai/notify | Notifications, preferences, event broadcasts |
| **media** | jin.imajin.ai/media | Asset storage with .fair attribution, DID-pegged folders |
| **learn** | jin.imajin.ai/learn | Courses, modules, presentations, enrollment, progress |
| **market** | jin.imajin.ai/market | Consent-based local commerce, listings, seller dashboards |
| **registry** | jin.imajin.ai/registry | Node federation, service discovery |
| **www** | imajin.ai | Landing page, essays, bug reports, app launcher |
| **coffee** | jin.imajin.ai/coffee | Tipping / support pages |
| **links** | jin.imajin.ai/links | Link-in-bio pages |
| **dykil** | jin.imajin.ai/dykil | Community spending surveys |

`/registry/api/specs` lists configured service candidates, not proof every spec
exists or a complete live deployment inventory. Not every route group has a spec.
The generated [route index](../apps/kernel/public/llms.txt) and
[contract reference](../apps/kernel/public/llms-full.txt) cover the current handler tree.

### v0.8.28 integration delta (2026-10-26 source)

Since v0.8.27, [kernel-owned details](../apps/kernel/README.md#pre-cut-delta-for-v0828)
cover recipient-organization owner/admin card checkout, distinct 403 party/payer codes,
and additive manifest-secret sync followed by a separate signed Generate or Set.
EMT retains its opaque-handle capability model. Chat uses TLS in transit and plaintext
at rest with notification previews; MLS/hybrid post-quantum encryption is planned,
not implemented ([security](../SECURITY.md)). These are merged-source statements,
not proof of deployment. [Release close-out](npm-publishing.md) now generates missing
GitHub Releases and rolls milestones forward independently of npm publishing.

### v0.8.27 integration additions (2026-10-25 source)

- [Legal entity and bank details](DEVELOPER.md#sealed-bank-details-api-3075):
  per-field disclosure and individually sealed financial fields, human-session
  auth-scoped owner/admin checks, immutable replacement and retained history.
  Tier 0 is not zero-custody; bank settings UI/invoice disclosure are separate.
- [SSH signing / GitHub OIDC deploy](deploy/vault-ssh-deploy.md):
  purpose-scoped CA grants, capped certificates, verified repo/environment
  identity, pinned host keys and non-swappable tmpfs. Hosts enforce trust/principals.
- [Corpus](../apps/corpus/README.md): registry-resolved owner-DID partitions,
  explicit live grants and that owner's OAuth connector; no node-token fallback.
- [Cloudflare grantee metadata](guide/domain-ownership.md#domain-scoped-credentials)
  and [production-evidence-gated inference deployment](../deploy/infer-passthrough/README.md).
  Source availability is not evidence of a live rollout.

Events setup, API implementation and deployment now belong to its standalone
repository. Existing routing stays **`/events`**, with **3006 dev / 7006 prod**;
the HTTP examples below are app API examples, not monorepo startup instructions.

---

## Registered app sign-in

Use the [app registration contract](REGISTRATION.md) and the published
`@ima-jin/auth-client` SDK for app-owned sessions. The developer registration and
owner editor at `/auth/developer/apps` expose two independent controls:
`visibility` controls discovery; `signInAudience: "members" | "anyone"` controls
who may consent to a private app. The default `members` preserves owner/current
member-only consent. Choose `anyone` for a private customer-facing site whose
users must not become organization members; it stays out of the public directory.
No group membership, extra scope or service permission is granted by that choice.

The same field is accepted by `POST /api/registry/apps`, owner-only
`PATCH /api/registry/apps/{appId}`, and operator-countersigned
`POST /api/apps/provision`. Invalid values are rejected. Omitted PATCH preserves
the setting; widening from `members` to `anyone` requires the owner directly
(`403 AGENT_APPROVAL_REQUIRED` for a delegate). A claim-code reissue must omit the
field and never changes it. See the registry and Jin OpenAPI specs for the full API.

## The 5-Minute Walkthrough

Here's a complete flow: create an identity, buy an event ticket, and see .fair attribution — using nothing but `curl`.

### Step 1: Get an Identity (Soft DID — Email)

The simplest path. No cryptography. Just an email address.

```bash
# Start onboarding — sends a verification email
curl -X POST https://jin.imajin.ai/auth/api/onboard \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "name": "Your Name"}'

# Response: { "sent": true }
# Check your email, click the link. You now have a soft DID.
# Format: did:imajin:xxx (stable — same format as hard DIDs)
```

A soft DID supports low-assurance onboarding/purchases under each app's policy,
but cannot send chat messages or sign attestations. Email is a credential attached
to the DID, not embedded in it; verification is required before issuing a session.

### Step 2: Get an Identity (Hard DID — Keypair)

Use the kernel's `/register` flow or the SDK's secure key-management path.
Keep the private key in its owner-only keystore; never print it to a terminal.
Key possession is distinct from a node's decision to serve a suspended identity.

```bash
# Register with your public key (invite-only — you need an invite code)
curl -X POST https://jin.imajin.ai/auth/api/register \
  -H "Content-Type: application/json" \
  -d '{
    "publicKey": "<your-public-key-hex>",
    "handle": "yourhandle",
    "name": "Your Name",
    "scope": "actor",
    "subtype": "human",
    "signature": "<sign-the-payload-with-your-private-key>",
    "inviteCode": "<invite-code>"
  }'

# Response: { "did": "did:imajin:5Qn8...", "handle": "yourhandle", "created": true }
# Your DID encodes public-key bytes in base58; the did:imajin string is not a Solana address.
```

### Step 3: Log In (Challenge-Response)

```bash
# Request a challenge
curl -X POST https://jin.imajin.ai/auth/api/login/challenge \
  -H "Content-Type: application/json" \
  -d '{"handle": "yourhandle"}'

# Response: { "challengeId": "chl_abc123", "challenge": "a1b2c3...", "expiresAt": "..." }

# Sign the challenge with your private key, then verify
curl -X POST https://jin.imajin.ai/auth/api/login/verify \
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
curl https://jin.imajin.ai/events/api/events

# Start checkout for a specific event tier
curl -X POST https://jin.imajin.ai/events/api/checkout \
  -H "Content-Type: application/json" \
  -H "Cookie: imajin_session=<your-session-token>" \
  -d '{"eventId": "evt_abc123", "tierId": "tier_xyz"}'

# Response: { "checkoutUrl": "https://checkout.stripe.com/..." }
# Complete payment on Stripe. Webhook confirms → ticket created.
```

### Step 5: See .fair Attribution

Every event (and every media asset) has a .fair manifest:

The 0.3.0 examples below are **legacy illustrations**, not the current settlement
contract or evidence of a standalone app response. Current kernel settlement
builders emit 0.4.0 or tax-bearing 0.5.0; media v1.1 is a distinct shape.
Use the current [package documentation](../packages/fair/README.md) and served specs.

```bash
curl https://jin.imajin.ai/events/api/events/<event-id>/fair

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

### Identity: Five Standing Tiers

All DIDs use the same stable format: `did:imajin:xxx`. Identity is decoupled from authentication method.

| Tier | How You Get It | What You Can Do |
|------|---------------|----------------|
| **Soft** | Verify an email | Low-assurance participation; no chat send/signing |
| **Preliminary** | Generate an Ed25519 keypair + invite code | Create events, connect, full trust graph |
| **Established** | Earn through participation + attestation history | Invite new people, vouch, create Cultural DIDs |
| **Steward** | Trusted community role | Route-specific steward capabilities |
| **Operator** | Operator role | Operator-gated capabilities |

Tiers upgrade seamlessly. All history, attestations, and tickets carry over — the DID never changes.

### Authentication: Three Paths

1. **Magic link** (email) → Soft DID session
2. **Challenge-response** (Ed25519 signature) → Preliminary/Established DID session
3. **DFOS chain** → Bridged identity (same Ed25519 keypair, dual DID)

Verified browser login/onboarding sets `imajin_session` / `imajin_session_dev`.
Cookies are host-only by default, with explicit domain-scope rollback; app-token
and bearer flows do not imply a cookie. `/auth/api/session/soft` resolves an
identity without setting one. See [cookie isolation](security/cookie-isolation.md).

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

Media creates .fair sidecars on upload; app manifests can carry payout instructions.
Verification is path-dependent, with transitional missing-signature and funded
exceptions. See the whitepaper's settlement caveats rather than assuming a universal gate.

### Trust Graph

Relationships between identities. Pods (1:1 connections), groups, invites. The trust graph determines who can reach whom — messaging, discovery, and the declared-intent marketplace all route through it. Every connection action emits cryptographic attestations (`connection.invited`, `connection.accepted`, `vouch`).

```bash
# Create an invite link
curl -X POST https://jin.imajin.ai/connections/api/invites \
  -H "Cookie: imajin_session=<token>"

# Check connection status
curl https://jin.imajin.ai/connections/api/connections/status/<their-did> \
  -H "Cookie: imajin_session=<token>"
```

### Attestations

Cryptographically signed records of claims. The shared vocabulary is
[80+ and growing](../packages/auth/src/types/attestation.ts); these are selected
examples, not a count of types emitting in production. Node-witnessed and
user-authored signatures have different proof strength.

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
curl https://jin.imajin.ai/auth/api/attestations?subject_did=did:imajin:xxx&type=vouch \
  -H "Cookie: imajin_session=<token>"
```

### Chat (DID-Based)

Every conversation is a DID. DMs, groups, and event chats all use the same primitives:

```bash
# Send a message to a conversation
curl -X POST https://jin.imajin.ai/chat/api/d/did:imajin:event:summer-camp/messages \
  -H "Content-Type: application/json" \
  -H "Cookie: imajin_session=<token>" \
  -d '{"content": "Hello everyone!"}'
```

Real-time via WebSocket with deferred token authentication. `<Chat did="..." />` drop-in component available in `@imajin/chat`.

### Payments

Stripe-backed today. Every service that charges calls `jin.imajin.ai/pay`:

```bash
# Check balance
curl https://jin.imajin.ai/pay/api/balance/<your-did> \
  -H "Cookie: imajin_session=<token>"

# View transaction history
curl https://jin.imajin.ai/pay/api/transactions/<your-did> \
  -H "Cookie: imajin_session=<token>"
```

---

## Building on Imajin

### Option A: Use the APIs Directly

Every service is a standard REST API. Call them from any language. Session cookies handle auth across services.

Each service publishes an OpenAPI spec:
```bash
curl https://jin.imajin.ai/auth/api/spec
curl https://jin.imajin.ai/events/api/spec
curl https://jin.imajin.ai/pay/api/spec
# etc.
```

### Option B: Run Your Own Node

The reference code is source-available under [INL v1.0](../LICENSE.md).
Self-host the kernel; deploy extracted apps separately.

```
git clone https://github.com/ima-jin/imajin-ai
cd imajin-ai
pnpm install
# Configure .env.local for each service
# See docs/ENVIRONMENTS.md for port assignments
```

`POST /registry/api/node/register` requires a signed `attestation` containing
nodeId, publicKey, buildHash, hostname and signature, plus an approved build.
Bare `{did, hostname}` is not the contract. Read `/registry/api/spec` and
the route's validation before constructing a request.

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
│ events · chat · media · learn · notify  │
│ market · coffee · links · dykil         │
├─────────────────────────────────────────┤
│          Attestation Layer              │
│  Extensible vocabulary · verification  │
│        countersignatures                │
├─────────────────────────────────────────┤
│           Trust Graph Layer             │
│        connections · pods · vouches     │
├─────────────────────────────────────────┤
│    Identity + Commerce + Protocol       │
│  auth (stable DIDs) · pay (receipt rails)│
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
- **Ed25519 keypairs** for hard identities; soft identities have no actor key.
  Key-based DIDs encode public-key bytes, not a Solana wallet address.
  DFOS linking is optional and separate.
- **Stable DIDs** — all identities are `did:imajin:xxx` from birth. Email is a credential, not the identity. Tier reflects credential strength, not DID format.
- **Host-only session cookies** by default; scoped app tokens cross app boundaries.
  Dev/prod cookies remain distinct (`imajin_session_dev` / `imajin_session`).
- **Postgres** for kernel relational state; corpus uses SQLite and vault content is file-backed.
- **Next.js** API routes. Standard Node.js. No custom framework.
- **.fair sidecars** carry attribution. Verification differs by settlement path;
  consult the whitepaper's explicit signature exceptions.
- **DID-based conversations** — every chat conversation is a DID (`did:imajin:event:*`, `did:imajin:dm:*`, `did:imajin:group:*`). Auth service is the single access control authority.
- **Attestations** — every trust-relevant action emits a cryptographic attestation. Attestations are the substance of the trust graph.

---

## What Exists Today vs. What's Planned

### Live Now (March 2026)
Historical March snapshot, not present release inventory. The generated README
and source-derived route references above supersede its counts and roadmap status.
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
- ✅ 9 apps + 21 shared packages, self-hosted, 246 registered identities
- ✅ Postgres backups (hourly, local + NAS)

### Coming Next
Historical March roadmap, not a current release commitment. Identity scopes and
the published SDK have since landed; generalized portable standing and exit
credentials remain distinct work.
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
No. Email-backed identity and implemented Stripe/receiver-confirmed EMT paths
are distinct from key-based signatures. A live Solana settlement rail is not established.

**Is this a blockchain project?**
The identity layer uses Ed25519; the DID string is not a Solana wallet address.
DFOS linking supplies separate chain proofs. On-chain settlement remains planned,
not a consequence of sharing a cryptographic curve.

**What's the difference between MJN and .fair?**
.fair is a JSON file format for attribution (who made it, who gets paid). MJN is the network that routes identity, trust, and settlement around those attributions. You can use .fair without MJN. You can't use MJN without .fair.

**What's the DFOS bridge?**
DFOS (by Metalabel) is an open-source cryptographic identity protocol. Imajin bridges to it — same Ed25519 keypair produces both a `did:imajin:xxx` and a `did:dfos:xxx`. Your DFOS chain provides cryptographic proofs of identity history (key rotation, countersignatures). Imajin is Layer 6 — the economic, settlement, and inference layer on top of DFOS's proof substrate.

**Can I use this without Imajin?**
Yes. The APIs are open and the code is source-available under INL v1.0.
.fair is a standalone format. Run your node or adopt the parts you need.

**Where's the SDK?**
The published `@ima-jin/auth-client` SDK supplies sign-in and session handlers.
See the [generated package/status table](../README.md#packages-sdk);
workspace `@imajin/*` imports are not external install names.

---

## Links

- **Source code:** [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)
- **Protocol RFCs:** See `docs/canon/rfcs/` for protocol specifications
- **.fair spec:** [github.com/ima-jin/.fair](https://github.com/ima-jin/.fair)
- **OpenAPI specs:** `https://jin.imajin.ai/{service}/api/spec`
- **First demonstration:** April 1, 2026

---

*The RFCs tell you why this matters. This guide tells you how it works. Start with `curl` and go from there.*

*Updated May 10, 2026. 9 apps + 21 shared packages, 246 identities, 2,290 commits.*
