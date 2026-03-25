# RFC-19: Kernel/Userspace Architecture — Sovereign App Federation

**Status:** Draft
**Authors:** Ryan Veteze, Jin
**Created:** 2026-03-25
**Related:** #274, #244, RFC-09, Essay 34

---

## Summary

The Imajin platform splits into a **kernel** (sovereign infrastructure that every node runs) and a **userspace** (federated ecosystem of independent apps that link up with nodes through a protocol handshake, compliance validation, and delegated sessions).

Apps are not hosted by us. Apps are hosted by anyone, discovered through the registry, validated for protocol compliance, and linked to a user's node through a cryptographic handshake. Our implementations of events, market, learn, etc. are just the first apps in the ecosystem. Anyone can build a better one. Users switch. The chains don't care.

This is how to save the app store.

---

## The Kernel

The kernel is the sovereign infrastructure layer. It handles identity, payments, trust, communication, and discovery. It does not handle features. Features are apps.

### What's in the kernel

| Service | Why it's kernel |
|---------|----------------|
| **auth** | Identity is infrastructure. DIDs, sessions, delegation, attestations. |
| **pay** | Settlement is infrastructure. Stripe, future MJN/MJNx. |
| **registry** | Discovery is infrastructure. Node federation, app manifests, compliance. |
| **connections** | Trust is infrastructure. The graph that everything else reads. |
| **chat** | Communication is infrastructure. Messaging, not a feature. |
| **media** | Asset resolution is infrastructure. Storage, .fair attribution, CID. |
| **input** | Processing is infrastructure. Voice, files, transcription. |
| **profile** | Public identity is infrastructure. Your face to the network. |

### What's NOT in the kernel

Everything else. Events, market, learn, coffee, links, dykil — these are **userspace apps**. They consume the kernel. They're replaceable. Even ours.

### Kernel deployment

One Next.js application. One domain (`jin.imajin.ai`). One build. One process.

```
apps/jin/
├── app/
│   ├── (www)/              # Landing, essays
│   ├── auth/               # Identity
│   ├── pay/                # Settlement
│   ├── registry/           # Discovery + app federation
│   ├── connections/        # Trust graph
│   ├── chat/               # Messaging
│   ├── media/              # Assets
│   ├── input/              # Processing
│   └── profile/            # Public identity
├── lib/
│   ├── auth.ts             # Direct function call, not HTTP
│   ├── db.ts               # Single connection pool
│   └── session.ts          # One middleware
└── middleware.ts            # Auth for all routes
```

What this eliminates:
- CORS (same origin)
- Cookie domain gymnastics (one domain)
- 15 separate pm2 processes (one process + chat WS)
- Service-to-service HTTP for auth (direct function call)
- Multi-port local dev (one `pnpm dev`, one port)
- Ecosystem config drift (one app, nothing to misconfigure)

Chat's WebSocket server stays as a separate process (stateful connection registry). Caddy routes `/chat/ws` to it.

---

## The Userspace

### What is a userspace app?

An independent application — hosted anywhere, built by anyone — that speaks the Imajin protocol. It authenticates through the kernel, settles through pay, reads trust from connections, and emits attestations that flow back to user chains.

A userspace app can be:
- **A Next.js app** in the monorepo (our first-party apps)
- **A separate repo** (fixready, karaoke)
- **Built by a third party** in any language or framework
- **Hosted anywhere** — their server, a VPS, a Raspberry Pi

The only requirement: speak the protocol correctly.

### App manifest

Every userspace app declares itself:

```json
{
  "did": "did:imajin:app:market",
  "name": "Market",
  "description": "Local commerce, trust-based discovery",
  "url": "https://market.imajin.ai",
  "icon": "🏪",
  "author_did": "did:imajin:6JSKE52ySFid2x7ejUEw6VV1NyJA1idfVKpg3We9b5Nc",
  "scopes": ["identity:read", "trust:read", "media:read", "attestation:write"],
  "compliance": {
    "version": "1.0",
    "passed_at": "2026-03-25T00:00:00Z",
    "suite_hash": "sha256:abc123..."
  },
  "attestations_emitted": ["market.purchase", "market.listing"],
  "settlement_model": "pay_service"
}
```

### Discovery

Users browse the registry. Search across thousands of apps. Filter by category, trust score, compliance status, author standing. The registry is a phone book, not a gatekeeper.

```
jin.imajin.ai/registry/apps
├── Featured apps
├── Categories (commerce, education, creative, community, tools)
├── Search
└── Each app shows:
    ├── Manifest (scopes, attestations, compliance)
    ├── Author profile + trust standing
    ├── User reviews (trust-graph-scoped, countersigned)
    ├── Install count
    └── [Add to my node]
```

### The Handshake

When a user adds an app to their node:

1. **Node initiates.** Sends to app:
   ```json
   {
     "node_did": "did:imajin:node:jin",
     "user_did": "did:imajin:6JSKE...",
     "granted_scopes": ["identity:read", "trust:read", "media:read"],
     "kernel_url": "https://jin.imajin.ai"
   }
   ```

2. **App responds.** Sends back:
   ```json
   {
     "app_did": "did:imajin:app:market",
     "compliance_attestation": "...",
     "accepted_scopes": ["identity:read", "trust:read", "media:read"]
   }
   ```

3. **Both sign.** Countersigned attestation on both chains:
   - User's chain: `app.linked` — "I added Market to my node"
   - App's chain: `node.linked` — "jin.imajin.ai linked to me"

4. **Delegated session minted.** Scoped token per #244. App can now:
   - Verify the user's identity via kernel auth API
   - Read trust graph (within granted scopes)
   - Resolve media assets
   - Settle payments through pay
   - Emit attestations back to the user's chain

5. **App appears in launcher.** Kernel's nav pulls from registry, shows linked apps alongside kernel routes.

### Compliance Validation

An app must pass the compliance test suite before it's listed. Same principle as DFOS relay conformance (38/38).

The suite validates:

| Check | What it tests |
|-------|---------------|
| **Auth conformance** | App correctly verifies DIDs via kernel auth API |
| **Scope respect** | App only requests/accesses data within declared scopes |
| **Attestation format** | Emitted attestations match declared types, properly signed |
| **Settlement integration** | Transactions route through pay service correctly |
| **Session handling** | Delegated tokens used correctly, not stored/leaked |
| **Revocation respect** | When user revokes, app stops accessing immediately |
| **Error handling** | Graceful degradation when kernel is unreachable |

The suite is open source. A developer runs it locally during development. When they're ready, they submit to the registry. The registry runs the suite against the live app. Pass → listed. Fail → feedback on what to fix.

This isn't gatekeeping. It's quality assurance. The difference: anyone can run the suite, anyone can submit, the criteria are public and deterministic. No review board. No policy team. No "we've decided your business model is inconvenient." Just: does your app speak the protocol?

### Revocation

User removes an app:
1. Handshake attestation marked revoked on user's chain
2. Delegated session token invalidated
3. App loses all access
4. App disappears from launcher
5. User's data stays on their chain — the app never had it, it only had proofs

The app can't hold you hostage because it never held your data.

---

## The Protocol Surface

What an app needs to implement to join the network:

### Required

```
1. Accept delegated session token (OAuth 2.1 + PKCE via kernel auth)
2. Verify identity via kernel: GET {kernel}/auth/api/session
3. Respect granted scopes (don't request what you weren't given)
4. Emit attestations in the correct format (signed by app DID)
```

### Optional (but expected for commerce apps)

```
5. Route payments through kernel: POST {kernel}/pay/api/checkout
6. Resolve media via kernel: GET {kernel}/media/api/assets/{id}
7. Read trust graph: GET {kernel}/connections/api/trust/{did}
```

### That's it.

Import `@imajin/auth` if you're in TypeScript. Or implement the protocol in any language — it's HTTP + Ed25519 signatures. The barrier is one import for JS devs, a few HTTP calls for everyone else.

---

## Economics

### For app developers

No revenue share. No 30% cut. You host it, you run it, you keep the revenue.

If your app routes transactions through pay, the settlement fee goes to the node operator (not us, not a platform). The app developer's revenue model is their own: subscriptions, transaction fees, freemium, whatever.

### For users

No app store tax. The node operator pays infrastructure costs. The user pays the app directly (if the app charges). Nobody in the middle.

### For the ecosystem

Apps that generate real transactions create real attestations. Those attestations feed the trust graph. The trust graph enriches every other app. Virtuous cycle — more apps → more activity → richer chains → more trust → more apps.

MJN accrues to participants, not platforms.

---

## Migration Path

### Phase 1: Kernel merge

1. Create `apps/jin/` — single Next.js app
2. Move 8 kernel services into route groups
3. Merge auth into direct function calls
4. Chat WS stays separate
5. One domain: `jin.imajin.ai`
6. Subdomain redirects (301) for old URLs
7. `registry.imajin.ai` stays permanent (DFOS spec)

### Phase 2: Userspace extraction

1. Events, market, coffee, learn, links, dykil become standalone apps
2. Each gets its own app DID
3. Each registers with the registry
4. Handshake flow implemented

### Phase 3: Compliance suite

1. Build the test suite (open source)
2. Run against our own apps first (eat the dog food)
3. Publish developer guide for building userspace apps
4. Open the registry to external submissions

### Phase 4: App discovery

1. Registry gets app browsing UI
2. Launcher shows linked apps
3. User reviews (trust-graph-scoped)
4. Developer dashboard (installs, usage)

---

## What This Decides

| Question | Answer |
|----------|--------|
| How many apps does the kernel have? | One. |
| Can anyone build a userspace app? | Yes. In any language. |
| How does an app join the network? | Register with registry, pass compliance suite, handshake with user nodes. |
| Who hosts userspace apps? | The developer. Anywhere they want. |
| What does the kernel provide? | Identity, payments, trust, communication, media, discovery. |
| What does the kernel NOT provide? | Features. Features are apps. |
| Is there a revenue share? | No. |
| Is there a review board? | No. Compliance suite is deterministic. |
| Can a user switch apps? | Yes. Revoke one, add another. Chains persist. |
| What happens to the data? | It was always on the user's chain. The app only had proofs. |

---

## Shell Architecture

The kernel serves a **shell** — a thin wrapper that provides the toolbar, launcher, notifications, and user menu. Userspace apps render inside it via iframe.

```
┌──────────────────────────────────────────────┐
│  🟠 jin    [Chat] [Events] [Market] 🔔  👤  │  ← kernel (always)
├──────────────────────────────────────────────┤
│                                              │
│                                              │
│       market.somedev.com renders here        │  ← iframe (sandboxed)
│                                              │
│                                              │
└──────────────────────────────────────────────┘
```

**The kernel controls:**
- What URL loads in the iframe (only registered, compliant apps)
- The toolbar, launcher, notifications, user menu (always kernel state)
- What `postMessage` messages it accepts (typed, scoped)
- When to kill the iframe (user revokes → gone)

**The app controls:**
- Everything inside its frame
- Its own UI, data, hosting, tech stack

**The browser enforces isolation for free.** An iframe from `market.somedev.com` can't read cookies from `jin.imajin.ai`, can't touch the DOM outside its frame, can't sniff the toolbar. The only bridge is `postMessage` — which the kernel validates.

### postMessage Protocol

Typed messages between kernel shell and app iframe:

```typescript
// App → Kernel
{ type: "set_title", title: "My Listing" }
{ type: "set_badge", count: 3 }
{ type: "navigate", path: "/market/listings/123" }
{ type: "toast", message: "Purchase complete!", level: "success" }
{ type: "request_payment", checkout: { items: [...], successUrl: "..." } }

// Kernel → App
{ type: "session", token: "..." }           // delegated session on load
{ type: "theme", mode: "dark" }             // sync appearance
{ type: "scope_revoked", scope: "media:read" }  // permission change
{ type: "unload" }                          // user navigating away
```

### Progressive enhancement

- **Phase 1 (now):** Shared `<PlatformHeader>` component via `@imajin/ui`. Userspace apps import it. Works today, ships fast.
- **Phase 2:** Full shell architecture with iframe embedding. The platform feels like one app while being many.

---

## Threat Model: What Can a Rogue App Do?

**Short answer: basically nothing.**

A userspace app receives a scoped delegated session token. It can ask the kernel questions within its granted scopes. It never receives the user's chain, private key, or raw data — only proofs.

### What a rogue app CAN do

| Attack | Impact |
|--------|--------|
| Show garbage in its iframe | User closes it. No platform impact. |
| Stop responding | Kernel shows "app unavailable." |
| Spam attestations | Costs gas. Attestations are self-referential (no countersignature from victim). Trust graph ignores them. |
| Call kernel APIs outside scopes | Rejected. Token is scoped. |
| Try to exfiltrate data | There's no data to exfiltrate. App only has proofs, not records. |

### What a rogue app CANNOT do

- Read other apps' data (iframe isolation)
- Access the user's chain directly (only kernel has chain access)
- Modify the toolbar or launcher (kernel DOM, not app DOM)
- Impersonate the user (delegated token ≠ user's signing key)
- Survive revocation (kernel stops loading the iframe, token invalidated)
- Persist after removal (app never had data, only proofs)

### Ongoing compliance

The compliance suite catches drift — an app passes initially, then ships an update that breaks protocol. Detection:

1. **Periodic re-validation.** Registry re-runs the suite on a schedule.
2. **User reports.** Flag an app → triggers re-validation.
3. **Attestation monitoring.** Kernel detects malformed or unauthorized attestations.
4. **Scope violations.** Kernel logs when an app requests scopes it wasn't granted.

Non-compliant apps get flagged in the registry. Existing user links stay (user choice) but new installs are blocked and a warning shows. This is structurally better than app store review — compliance is deterministic and ongoing, not a one-time human check that you can bypass with post-approval updates.

---

## Open Questions

1. **Compliance suite scope.** How deep does validation go? Functional tests only, or also security/performance?
2. **App versioning.** How do breaking changes in the protocol affect existing apps?
3. **Node-hosted apps.** Can an app package be installed directly on a node (like WordPress plugins)? Or always remote?
4. **App-to-app communication.** Can userspace apps talk to each other, or only to the kernel?
5. **Governance.** Who maintains the compliance suite? Protocol team? Community vote?

---

## References

- #274: Unified domain (superseded — kernel merge replaces basePath)
- #244: Delegated app sessions
- RFC-09: Application plugin architecture
- #232: Slug prefixes
- #465: Agent sandbox
- Essay 34: How to Save the App Store
- DFOS relay conformance: Prior art for protocol compliance testing

---

*The kernel is permanent. The userspace is disposable. The protocol is the product.*
