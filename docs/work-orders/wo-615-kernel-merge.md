# Work Order: Kernel Merge (#615)

**Priority:** High — unlocks single-domain routing, forest subdomains, faster builds
**Epic:** #615
**Estimated effort:** 2-3 days (phased, can ship incrementally)
**Depends on:** Scope-aware services (#602) ✅
**Related:** RFC-19, #244, #232, #274, #614

---

## Problem

9 kernel services × separate Next.js builds × separate pm2 processes × separate Caddy entries × cross-service HTTP calls × cross-subdomain cookies = slow, fragile, hard to reason about. The scope switch (#602) made it worse — `actingAs` validation is now a cross-service HTTP call on every request.

---

## Target Architecture

One Next.js app (`apps/kernel`) with route groups. One build. One process. One cookie domain.

### URL Convention

**Full service name for app UI and API routes:**
- `/auth/login`, `/auth/groups`, `/auth/api/session`
- `/pay/checkout`, `/pay/api/balance`
- `/chat/conversations`, `/chat/api/messages`
- `/media/api/assets`, `/profile/api/profiles`

**Short prefix for public content URLs (#232):**
- `/e/summer-camp` — shareable event links (goes on posters)
- `/p/ryan` — shareable profile handles
- `/c/[slug]` — shareable course links

Rule: if a human would share it, short prefix. If it's app chrome, full service name.

### App Tiers

| Tier | Where it runs | Kernel access | Example |
|------|--------------|---------------|---------|
| **Kernel** | In the kernel app | Direct imports, one DB pool | auth, pay, chat, media, profile, registry, connections, notify |
| **1st party** | Same node, own process | localhost HTTP to kernel | events, market, coffee, learn, links, dykil |
| **2nd party** | Installed on user's node | localhost HTTP to kernel | third-party app installed locally |
| **3rd party** | Remote server | HTTPS to kernel, iframe sandbox | third-party app hosted elsewhere |

The kernel doesn't care about the tier. Same handshake, same compliance, same scopes. The difference is where the process runs and whether it gets `localhost` or `https://`.

1st party userspace apps route to kernel via localhost behind the scenes — same advantage a 2nd party installed app gets. This is eating the dog food: if our apps can't work with just the kernel API + their own schema, a third-party app can't either.

### Userspace App Isolation

Userspace apps (all tiers):
- Own DB connection for their own Postgres schema only (events.*, market.*, etc.)
- Talk to kernel via HTTP for auth, pay, connections, media, profile, chat
- **No direct access to kernel schemas** — clean protocol boundary
- Same API surface a third-party app would use
- `@imajin/db` stays as utility package (connection helper), but never imports kernel schemas

### Directory Structure

```
apps/
  kernel/
    app/
      auth/                 ← auth UI pages (login, register, groups, onboard)
        api/...             ← auth API routes
      pay/
        api/...
        checkout/...
      profile/
        api/...
      registry/
        api/...
      connections/
        api/...
      chat/
        api/...
        conversations/...
      media/
        api/...
      notify/
        api/...
      page.tsx              ← landing (from www)
      layout.tsx            ← unified layout
      articles/             ← from www
      project/              ← from www
    src/
      db/
        index.ts            ← one connection pool, all kernel schemas
        schemas/
          auth.ts
          pay.ts
          profile.ts
          registry.ts
          connections.ts
          chat.ts
          media.ts
          notify.ts
          www.ts
      lib/                  ← shared kernel utilities
    server.ts               ← custom server (for chat WebSocket)
    ws-server.js            ← chat WebSocket (moved from chat)
    .env.local              ← consolidated env vars
    next.config.mjs
    package.json
  events/                   ← 1st party userspace (unchanged)
  market/                   ← 1st party userspace (unchanged)
  coffee/                   ← 1st party userspace (unchanged)
  learn/                    ← 1st party userspace (unchanged)
  links/                    ← 1st party userspace (unchanged)
  dykil/                    ← 1st party userspace (unchanged)
```

---

## What Changes

### Routes (364 API routes + 39 pages → one app)

| Service | API Routes | Pages | Notes |
|---------|-----------|-------|-------|
| auth | 100 | 8 | login, register, groups, onboard pages |
| pay | 39 | 3 | checkout pages |
| profile | 48 | 5 | profile pages |
| registry | 15 | 2 | docs page |
| connections | 42 | 3 | connections pages |
| chat | 62 | 3 | custom server.js for WebSocket |
| media | 33 | 1 | - |
| notify | 11 | 2 | - |
| www | 14 | 12 | landing, articles, project |

### Database (9 connection pools → 1)

All services already use the same Postgres instance (`imajin_dev` / `imajin_prod`). Each uses its own Postgres schema namespace (`auth.*`, `pay.*`, etc.). The merge consolidates from 9 drizzle clients to 1. **No schema changes at the Postgres level.**

| Schema | Key Tables |
|--------|-----------|
| auth | identities, tokens, challenges, credentials, stored_keys, mfa_methods, devices, attestations, group_identities, group_controllers, onboard_tokens |
| pay | balances, transactions, stripe_accounts, escrow |
| profile | profiles, forest_config |
| registry | services, nodes, relay_config, relay_peer_cursors |
| connections | pods, pod_members, pod_links, connections, nicknames |
| chat | conversations, conversation_members, messages, conversation_reads, invites, keys |
| media | assets, folders, asset_folders |
| notify | notifications, preferences |
| www | subscribers, bugs |

### Env Vars (89 unique vars → ~40 consolidated)

Cross-service URLs between kernel services become unnecessary (direct imports). Remaining:
- `DATABASE_URL` (one)
- External service URLs: userspace apps (events, coffee, etc.) for kernel→userspace calls
- API keys: Stripe, SendGrid, Anthropic, GPU node
- `NEXT_PUBLIC_*` for client-side URLs (kernel domain + userspace app domains)

### Cross-Service Calls → Direct Imports

The biggest win. Current HTTP calls between kernel services become function calls:

| Caller → Callee | Current | After |
|-----------------|---------|-------|
| * → auth `/api/session` | HTTP (every request) | Direct DB query |
| * → auth `/api/validate` | HTTP | Direct function call |
| auth → profile | HTTP | Direct import |
| auth → connections | HTTP | Direct import |
| chat → auth, profile | HTTP (63 calls) | Direct import |
| profile → auth, pay, connections, media | HTTP (25+ calls) | Direct import |
| connections → auth | HTTP (31 calls) | Direct import |
| notify → auth, registry | HTTP | Direct import |
| pay → auth | HTTP | Direct import |

**`requireAuth()` is the biggest optimization** — no more HTTP round-trip on every authenticated request.

### Chat WebSocket

Chat has `server.js` + `ws-server.js` (346 lines) for WebSocket. Kernel gets a custom server too:
- Move chat's server/WS code to kernel
- WebSocket on `/chat/ws` (or `/ws`)
- One process, HTTP + WS

### Build System

- Build time: ~20 min (9 apps) → ~3-4 min (1 app)
- `pm2`: 9 kernel processes → 1 `dev-kernel` process
- Userspace apps still build independently

### Caddy

```
# Before: 9 blocks for kernel services
dev-www.imajin.ai → localhost:3000
dev-auth.imajin.ai → localhost:3001
dev-pay.imajin.ai → localhost:3004
# ... 6 more

# After: 1 block (enables forest subdomains later via wildcard)
dev-www.imajin.ai → localhost:3000

# Userspace apps keep their own entries
dev-events.imajin.ai → localhost:3006
dev-market.imajin.ai → localhost:3104
# ...
```

---

## Execution Plan

### Phase 1: Scaffold + DB

1. Create `apps/kernel/` with `package.json`, `next.config.mjs`, `tsconfig.json`
2. Set up unified DB: `src/db/index.ts` with one connection pool, re-export all kernel schemas
3. Create `.env.local` — consolidated from all 9 service env files
4. Set up custom server (from chat's `server.js`) with WebSocket support
5. Verify: `pnpm build` succeeds with a minimal landing page

### Phase 2: Move www (simplest, proves the pattern)

1. Move `apps/www/app/*` → `apps/kernel/app/` (landing, articles, project, etc.)
2. Move `apps/www/src/*` → `apps/kernel/src/`
3. Update imports
4. Verify: landing page renders, newsletter subscription works

### Phase 3: Move auth (most depended-on)

1. Move API routes → `apps/kernel/app/auth/api/...`
2. Move pages (login, register, groups, onboard) → `apps/kernel/app/auth/...`
3. Move schema → `apps/kernel/src/db/schemas/auth.ts`
4. Move lib → `apps/kernel/src/lib/auth/`
5. Verify: login flow, group creation, session validation all work

### Phase 4: Move remaining 6 services (parallelizable)

Each follows the same pattern. Can run in parallel via agents:

**pay** → `app/pay/api/*` + `app/pay/checkout/*` + schema
**profile** → `app/profile/api/*` + `app/profile/*` pages + schema
**registry** → `app/registry/api/*` + relay routes + schema
**connections** → `app/connections/api/*` + pages + schema
**chat** → `app/chat/api/*` + `app/chat/conversations/*` + schema + WS integration
**media** → `app/media/api/*` + schema
**notify** → `app/notify/api/*` + schema

### Phase 5: Cleanup + Infrastructure

1. Delete old `apps/{service}` directories (9 services)
2. Update Caddy: remove 8 kernel service blocks, keep 1
3. Update pm2: remove 8 kernel processes, add 1 `dev-kernel`
4. Update `@imajin/config` service definitions — kernel services share one port
5. Update `build-changed.sh` — kernel is one build target
6. Update docs (ENVIRONMENTS.md, DEVELOPER.md, README)
7. Add 301 redirects from old subdomains → new paths
8. Update userspace apps' env vars: all `*_SERVICE_URL` vars point to kernel

### Phase 6: Optimize (incremental, post-merge)

1. Replace `requireAuth()` HTTP call with direct DB session check
2. Replace remaining cross-service fetches with direct imports
3. Remove unused env vars
4. Path-based routing (#274)
5. Forest subdomain routing (#614)

---

## Route Conflict Resolution

| Path | Services | Resolution |
|------|----------|-----------|
| `/api/health` | all 9 | Single `/api/health` endpoint, checks all schemas |
| `/api/spec` | all 9 | Single `/api/spec`, returns combined OpenAPI spec |
| `/api/session` | auth, chat | Auth owns it at `/auth/api/session` |

All other routes are naturally namespaced under their service prefix.

---

## Risk Mitigation

1. **Incremental shipping** — each phase produces a working build. Can pause after any phase.
2. **Old apps stay until verified** — don't delete until kernel is confirmed working.
3. **Env var audit** — generate consolidated .env.local from all 9 service .env.local files.
4. **Route testing** — curl every API endpoint before/after.
5. **Chat WebSocket** — test separately, most fragile piece.
6. **Userspace apps unaffected** — they keep working throughout, just update env vars at the end.

---

## Agent Task Template

Each service move (Phase 4) follows this pattern:

```
Move {service} to kernel:

1. Copy apps/{service}/app/api/* → apps/kernel/app/{service}/api/
2. Copy apps/{service}/app/*.tsx pages → apps/kernel/app/{service}/
3. Copy apps/{service}/src/db/schema.ts → apps/kernel/src/db/schemas/{service}.ts
4. Copy apps/{service}/src/lib/* → apps/kernel/src/lib/{service}/
5. Update all imports from '@/src/...' to new kernel paths
6. Update all DB imports to use kernel's unified db client
7. Add schema re-export to apps/kernel/src/db/index.ts
8. Verify: pnpm build succeeds
```

---

## Done When

- `apps/kernel` builds and runs all 364 API routes + 39 pages
- One pm2 process serves everything including WebSocket
- Userspace apps unchanged, talk to kernel via HTTP (localhost)
- Login, groups, chat, payments, media upload all work
- WebSocket chat works
- Build time under 5 minutes
- Old kernel app directories removed
- Caddy config simplified to 1 kernel block + userspace blocks
