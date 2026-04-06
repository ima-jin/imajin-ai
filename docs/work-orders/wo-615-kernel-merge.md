# Work Order: Kernel Merge (#615)

**Priority:** High — unlocks single-domain routing, forest subdomains, faster builds
**Epic:** #615
**Estimated effort:** 2-3 days (phased, can ship incrementally)
**Depends on:** Scope-aware services (#602) ✅

---

## Problem

9 kernel services × separate Next.js builds × separate pm2 processes × separate Caddy entries × cross-service HTTP calls × cross-subdomain cookies = slow, fragile, hard to reason about. The scope switch (#602) made it worse — `actingAs` validation is now a cross-service HTTP call on every request.

---

## Target Architecture

One Next.js app (`apps/kernel`) with route groups. One build. One process. One cookie domain.

```
apps/
  kernel/
    app/
      (auth)/api/...        ← auth routes
      (pay)/api/...         ← pay routes
      (profile)/api/...     ← profile routes
      (registry)/api/...    ← registry routes
      (connections)/api/... ← connections routes
      (chat)/api/...        ← chat routes + pages
      (media)/api/...       ← media routes
      (notify)/api/...      ← notify routes
      page.tsx              ← landing (from www)
      layout.tsx            ← unified layout
      groups/               ← from auth
      onboard/              ← from auth
      login/                ← from auth
      register/             ← from auth
      conversations/        ← from chat
      ...
    src/
      db/
        index.ts            ← one connection pool
        schemas/            ← re-exports from each schema
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
  events/                   ← userspace (unchanged)
  market/                   ← userspace (unchanged)
  coffee/                   ← userspace (unchanged)
  learn/                    ← userspace (unchanged)
  links/                    ← userspace (unchanged)
  dykil/                    ← userspace (unchanged)
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

**Route grouping strategy:**
- API routes: `(service)/api/...` → keeps `/api/...` paths (no `/auth/api/...` prefix)
- Problem: route conflicts between services (multiple `/api/health`, `/api/spec`)
- Solution: service-specific health/spec → `/api/auth/health`, `/api/pay/health`, etc.
  OR: single `/api/health` that reports all services, single `/api/spec` that returns combined spec

### Database (9 Postgres schemas → one connection pool)

All services already use the same Postgres instance (`imajin_dev` / `imajin_prod`). Each uses its own schema (`auth.*`, `pay.*`, etc.). The merge consolidates from 9 drizzle clients to 1.

| Schema | Tables (approx) |
|--------|----------------|
| auth | identities, tokens, challenges, credentials, stored_keys, mfa_methods, devices, attestations, group_identities, group_controllers, onboard_tokens |
| pay | balances, transactions, stripe_accounts, escrow |
| profile | profiles, forest_config |
| registry | services, nodes, relay_config, relay_peer_cursors |
| connections | pods, pod_members, pod_links, connections, nicknames |
| chat | conversations, conversation_members, messages, conversation_reads, invites, keys |
| media | assets, folders, asset_folders |
| notify | notifications, preferences |
| www | subscribers, bugs |

**No schema conflicts** — each uses its own Postgres schema namespace.

### Env Vars (89 unique vars → ~40 consolidated)

Most cross-service URLs become unnecessary (internal imports). Remaining:
- `DATABASE_URL` (one)
- External service URLs: userspace apps (events, coffee, etc.), Stripe, SendGrid, Solana, Anthropic, GPU node
- API keys: Stripe, SendGrid, Anthropic, internal webhook secrets
- `NEXT_PUBLIC_*` for client-side URLs (kernel's own domain + userspace apps)

### Cross-Service Calls → Direct Imports

The biggest win. Current HTTP calls between kernel services become function calls:

| Caller → Callee | Current | After Merge |
|-----------------|---------|-------------|
| * → auth `/api/session` | HTTP (every request) | Direct function call |
| * → auth `/api/validate` | HTTP | Direct function call |
| auth → profile `/api/profiles` | HTTP | Direct import |
| auth → connections | HTTP | Direct import |
| chat → auth, profile | HTTP (63 calls) | Direct import |
| profile → auth, pay, connections, media | HTTP (25+ calls) | Direct import |
| connections → auth | HTTP (31 calls) | Direct import |
| notify → auth, registry | HTTP | Direct import |
| pay → auth | HTTP | Direct import |

**`requireAuth()` becomes the biggest optimization** — no more HTTP round-trip to auth service on every authenticated request. Direct DB query.

### Chat WebSocket

Chat has a custom `server.js` + `ws-server.js` for WebSocket support. The kernel needs a custom server too. Options:
1. **Move chat's server.js to kernel** — kernel runs with custom server, WebSocket on `/ws`
2. **Extract WebSocket to standalone service** — kernel stays pure Next.js, WS runs separately

Option 1 is simpler and keeps everything in one process.

### Build System

- `build-changed.sh` → detects kernel as one app instead of 9
- Build time: ~20 min (9 apps) → ~3-4 min (1 app with all routes)
- `check-env.ts` → one env check instead of 9
- `pm2` → one `dev-kernel` process instead of 9 separate processes

### Caddy

```
# Before: 9 blocks
dev-www.imajin.ai → localhost:3000
dev-auth.imajin.ai → localhost:3001
dev-pay.imajin.ai → localhost:3004
...

# After: 1 block (or wildcard for forest subdomains)
dev-www.imajin.ai → localhost:3000
dev-*.imajin.ai → localhost:3000   # forest subdomains (#614)
```

Userspace apps keep their own Caddy entries.

---

## Execution Plan

### Phase 1: Scaffold + DB (agent-friendly)

1. Create `apps/kernel/` with `package.json`, `next.config.mjs`, `tsconfig.json`
2. Set up unified DB: `src/db/index.ts` with one connection pool, re-export all schemas
3. Create `.env.local` with consolidated vars
4. Verify: `pnpm build` succeeds with empty app

### Phase 2: Move www (simplest, proves the pattern)

1. Move `apps/www/app/*` → `apps/kernel/app/` (landing, articles, project, etc.)
2. Move `apps/www/src/*` → `apps/kernel/src/`
3. Update imports
4. Verify: landing page works

### Phase 3: Move auth (most depended-on)

1. Move API routes to `apps/kernel/app/(auth)/api/...`
2. Move pages (login, register, groups, onboard) to `apps/kernel/app/...`
3. Move `src/db/schema.ts` → `apps/kernel/src/db/schemas/auth.ts`
4. Move `src/lib/*` → `apps/kernel/src/lib/auth/`
5. Key refactor: `requireAuth()` in `@imajin/auth` package stays as shared package, but kernel can also call auth DB directly for internal optimization
6. Verify: login flow works, group creation works

### Phase 4: Move remaining services (parallel, agent-friendly)

Each service follows the same pattern. Can run in parallel via agents:

1. **pay** — routes + checkout pages + schema
2. **profile** — routes + pages + schema
3. **registry** — routes + docs page + schema + relay
4. **connections** — routes + pages + schema
5. **chat** — routes + pages + schema + WebSocket server
6. **media** — routes + schema
7. **notify** — routes + schema

### Phase 5: Cleanup + Optimization

1. Remove old `apps/{service}` directories
2. Update `@imajin/config` — kernel services share one port
3. Update `pm2` ecosystem config
4. Update Caddy config
5. Replace cross-service HTTP calls with direct imports (incremental — can ship first without this)
6. Update `build-changed.sh`
7. Update docs (ENVIRONMENTS.md, DEVELOPER.md, README)
8. Update CI/CD workflows

### Phase 6: Optimize (post-merge, incremental)

1. Replace `requireAuth()` HTTP call with direct DB session check
2. Replace other cross-service fetches with imports
3. Remove now-unnecessary env vars
4. Implement path-based routing (#274)
5. Implement forest subdomain routing (#614)

---

## Route Conflict Resolution

Services that share route paths:

| Path | Services | Resolution |
|------|----------|-----------|
| `/api/health` | all | Single `/api/health` endpoint, checks all schemas |
| `/api/spec` | all | Single `/api/spec`, returns combined OpenAPI spec |
| `/api/session` | auth, chat | Auth owns it, chat imports directly |

No other conflicts — service APIs are naturally namespaced (`/api/events/*`, `/api/groups/*`, etc.)

---

## Risk Mitigation

1. **Incremental shipping** — each phase produces a working build. Can pause after any phase.
2. **Old apps stay until verified** — don't delete until kernel is confirmed working
3. **Env var audit** — generate consolidated .env.local from all 9 service .env.local files
4. **Route testing** — curl every API endpoint before/after
5. **Chat WebSocket** — test separately, it's the most fragile piece

---

## Agent Task Decomposition

Phase 2-4 are highly parallelizable. Each service move follows the same pattern:

```
Move {service} to kernel:

1. Copy apps/{service}/app/api/* → apps/kernel/app/(service)/api/
2. Copy apps/{service}/app/*.tsx pages → apps/kernel/app/ (appropriate location)
3. Copy apps/{service}/src/db/schema.ts → apps/kernel/src/db/schemas/{service}.ts
4. Copy apps/{service}/src/lib/* → apps/kernel/src/lib/{service}/
5. Update all imports from '@/src/...' to new paths
6. Update all imports from relative DB paths
7. Add schema re-export to apps/kernel/src/db/index.ts
8. Verify: pnpm build succeeds
9. Verify: key routes return expected responses
```

---

## Done When

- `apps/kernel` builds and runs all 364 API routes + 39 pages
- One pm2 process serves everything
- Userspace apps unchanged, still talk to kernel via HTTP
- Login, groups, chat, payments, media upload all work
- WebSocket chat works
- Build time under 5 minutes
- Old app directories removed
