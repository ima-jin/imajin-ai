# RFC-19: Kernel/Userspace Architecture — Unified Kernel App + Registered Userspace Services

**Status:** Draft
**Authors:** Ryan Veteze, Jin
**Created:** 2026-03-25
**Related:** #274 (unified domain), #244 (delegated app sessions), RFC-09 (plugin architecture)

---

## Summary

Split the platform into two deployment tiers: a **kernel** (single Next.js app, one domain, one process) and a **userspace** (independent apps on their own domains, registered with the kernel via the registry).

This replaces the current architecture of 15 separate Next.js apps behind Caddy reverse proxy with subdomain routing.

## Motivation

### Current state: 15 apps, 15 ports, 15 builds

Every service is a standalone Next.js app with its own port, build, and pm2 process. Cross-service communication happens via HTTP fetch. Auth cookies require `domain: .imajin.ai` and CORS headers everywhere. Local dev requires running 5-10 services simultaneously.

Problems:
- **CORS everywhere.** Every service-to-service call crosses origin boundaries.
- **Cookie complexity.** Session cookie must be domain-scoped, `SameSite=None`, `Secure=true`. Breaks on localhost.
- **Redundant auth.** Every app re-implements session verification via HTTP call to auth service.
- **Build overhead.** 15 separate builds. Change a shared package → rebuild everything anyway.
- **Developer friction.** Chris's first dev setup took 2 days. Most issues were cross-service URL resolution and cookie handling.
- **Fragile infrastructure.** Ecosystem configs drift. Services point to stale paths. Missing from pm2. Power surge → manual triage.

### The insight: kernel services aren't independent

Auth, pay, chat, connections, profile, registry, media, input — these share a database, a session, an identity model. They're not microservices with independent scaling needs. They're modules of one application deployed as separate processes for historical reasons.

Meanwhile, market, coffee, dykil, links, learn — these are genuinely different apps that happen to consume the kernel. They could be built by anyone. They should be independent.

## Design

### Kernel: One App, One Domain

Merge core platform services into a single Next.js application at `jin.imajin.ai`:

```
apps/jin/
├── app/
│   ├── (www)/                    # Landing, essays, public pages
│   │   ├── page.tsx
│   │   └── articles/
│   ├── auth/                     # Identity, registration, sessions
│   │   ├── api/
│   │   │   ├── register/
│   │   │   ├── challenge/
│   │   │   ├── authenticate/
│   │   │   ├── access/[did]/
│   │   │   └── attestations/
│   │   ├── register/
│   │   └── login/
│   ├── pay/                      # Payments, settlements
│   │   └── api/
│   ├── chat/                     # Messaging (Next.js routes)
│   │   ├── api/
│   │   └── conversations/
│   ├── connections/              # Trust graph
│   │   ├── api/
│   │   └── pods/
│   ├── profile/                  # Public profiles
│   │   └── [handle]/
│   ├── events/                   # Events & ticketing
│   │   ├── api/
│   │   └── [eventId]/
│   ├── registry/                 # Node discovery, DFOS relay
│   │   └── api/
│   ├── media/                    # Asset storage, .fair
│   │   └── api/
│   └── input/                    # Voice, file processing
│       └── api/
├── lib/                          # Shared server utilities
│   ├── auth.ts                   # Direct function call, no HTTP
│   ├── db.ts                     # Single DB connection pool
│   └── session.ts                # Middleware, no cookie dance
├── middleware.ts                  # Auth middleware for all routes
├── next.config.js
└── package.json
```

**What changes:**
- `requireAuth()` becomes a direct function call, not an HTTP fetch to another service
- One database connection pool, not 15
- One session middleware, not 15 cookie-forwarding implementations
- One build, one pm2 process (or a few workers)
- `localhost:3000/auth/register` just works — no multi-port setup
- CORS disappears entirely for kernel routes

**What stays the same:**
- Route structure: `/auth/...`, `/events/...`, `/chat/...` — identical URLs
- API contracts: same endpoints, same request/response shapes
- Database schemas: still per-service schemas in Postgres (`auth.*`, `events.*`, `chat.*`)
- Package separation: `@imajin/auth`, `@imajin/db`, etc. remain as importable packages

### Chat WebSocket Server

Chat currently uses a custom `server.js` with WebSocket support. Two options:

1. **Separate WS process.** Keep chat's WebSocket server as a standalone Node process on its own port. Caddy routes `/chat/ws` to it. The Next.js routes for chat API/pages live in the kernel.

2. **Next.js custom server.** The kernel uses a custom `server.js` that handles both Next.js and WebSocket upgrades. More unified but adds complexity to the kernel's entry point.

Recommendation: Option 1. The WS server is stateful (connection registry, typing indicators) and benefits from running independently. It's a runtime concern, not a routing concern.

### Userspace: Independent Apps, Registered with Kernel

Userspace apps run on their own domains and authenticate through the kernel:

```
market.imajin.ai    → apps/market (standalone Next.js)
coffee.imajin.ai    → apps/coffee (standalone Next.js)
learn.imajin.ai     → apps/learn  (standalone Next.js)
links.imajin.ai     → apps/links  (standalone Next.js)
dykil.imajin.ai     → apps/dykil  (standalone Next.js)
fixready.imajin.ai  → separate repo
karaoke.imajin.ai   → separate repo
```

**Registration flow (extends #244):**

1. App registers with registry: `POST /registry/api/apps`
   ```json
   {
     "name": "market",
     "url": "https://market.imajin.ai",
     "scopes": ["identity:read", "trust:read", "media:read"],
     "icon": "🏪",
     "description": "Local commerce, trust-based discovery"
   }
   ```
2. Registry stores the app manifest
3. Kernel's nav/launcher pulls registered apps and shows them alongside kernel routes
4. User clicks → navigated to app's own domain
5. App verifies session via kernel's auth API: `GET jin.imajin.ai/auth/api/session`

**What this means for developers:**
- Build a Next.js app (or anything — it's just HTTP)
- Import `@imajin/auth` for client-side identity
- Call the kernel's APIs for auth, payments, trust, media
- Register with the registry
- You're on the platform

This is the "userspace is open" post made architectural. One import, read chains, verify proofs.

### Embedding vs Linking

Two modes for userspace apps in the kernel UI:

1. **Linked** (default) — app appears in the nav, clicking navigates to its domain. Cross-domain session via `.imajin.ai` cookie. This is what we do today.

2. **Embedded** (future) — app renders inside the kernel layout via iframe or module federation. Deeper integration, same-origin feel. Requires trust (app could be malicious). Only for vetted/first-party apps.

Start with linked. Embedding is a Phase 2 optimization.

## Migration Path

### Phase 1: Kernel Merge (blocking for April 1)

1. Create `apps/jin/` with unified Next.js config
2. Move routes from 10 kernel services into route groups
3. Merge middleware and auth into direct function calls
4. Chat WS server stays separate on its own port
5. Single build, single pm2 process
6. Caddy: `jin.imajin.ai` → one port + WS port for chat
7. Subdomain redirects for old URLs (301)
8. `registry.imajin.ai` stays as permanent alias (DFOS spec)

### Phase 2: Userspace Registration

1. Registry gets app manifest endpoints
2. Kernel nav pulls from registry for launcher
3. Userspace apps register (market, coffee, learn, links, dykil)
4. Delegated session flow from #244

### Phase 3: External Developer Onboarding

1. Developer guide for building userspace apps
2. App submission / review process
3. Bounty model from RFC-09
4. Settlement fee sharing

## What This Decides

| Question | Answer |
|----------|--------|
| How many Next.js apps? | 1 kernel + N userspace |
| How does auth work? | Direct function call in kernel, API call from userspace |
| Where do cookies live? | `.imajin.ai` — works for both kernel and userspace subdomains |
| What about CORS? | Gone for kernel. Standard cross-origin for userspace. |
| Can anyone build an app? | Yes. Register with registry, speak the protocol. |
| What about local dev? | `pnpm dev` → `localhost:3000`. One process. Everything works. |
| What about events? | Kernel service. It's part of the sovereign stack. |
| What about market? | Userspace. It's a replaceable commerce surface. |

## Open Questions

1. **Where does events live?** It's arguably kernel (ticketing = trust = chat) but also could be userspace (replaceable). Current recommendation: kernel, because ticket purchases create chat memberships and attestations — deep kernel integration.

2. **Build time.** One big Next.js app will build slower than 15 small ones. Acceptable tradeoff? Turbopack helps. Could also split to route-group-level code splitting.

3. **Independent scaling.** If media or input need more resources, they can't scale independently as kernel routes. Counter: they haven't needed to yet, and we can extract later if needed.

4. **Chat's custom server.** Does the WS server stay separate forever, or do we eventually bring it into a custom Next.js server?

5. **Migration strategy.** Big bang (move everything at once) vs incremental (merge 2-3 services at a time)?

## References

- #274: Unified domain (original basePath approach — superseded by this RFC)
- #244: Delegated app sessions
- RFC-09: Application plugin architecture
- #232: Slug prefixes
- #465: Agent sandbox (kneecapped kernel)
- Essay 34: How to Save the App Store
