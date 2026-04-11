# Work Order Series: Admin Console — Phase 1

**Goal:** Node operator's control panel. Act-as the node DID, manage users, services, subscribers, newsletters, federation, storage, moderation, and config.

**Critical path:**
```
#675 Node Identity → #664 Scaffolding → everything else in parallel
```

**Estimated total:** 2-3 weeks of focused work across 5 work orders.

---

## Work Order 1: Node Identity Bootstrap (#675)
**Estimated effort:** 1 day
**Status:** Ready now
**Blocks:** Everything else

The node needs a `did:imajin:` identity before the admin console can exist. Without it, there's no DID to act-as, no issuer for attestations, no owner for mailing lists.

### 675a: Create node identity
- Generate Ed25519 keypair for the node
- Insert into `auth.identities`: `type: 'node'`, name from hostname or env
- Store in `relay.relay_config`: add `imajin_did` column
  ```sql
  ALTER TABLE relay.relay_config ADD COLUMN imajin_did TEXT;
  UPDATE relay.relay_config SET imajin_did = '{new_did}' WHERE id = 'singleton';
  ```
- Drizzle schema + migration for the new column

### 675b: Link to DFOS chain
- Insert into `auth.identity_chains`: link `did:dfos:k4a9aed2dz9f7vkntah3tr` ↔ new `did:imajin:`
- Same pattern as user DFOS chain linking

### 675c: Register as group entity + operator as controller
- Insert into `auth.group_identities`: `group_did = node_did, scope = 'node', created_by = operator_did`
- Insert into `auth.group_controllers`: `group_did = node_did, controller_did = operator_did, role = 'owner'`
- After this, the node DID appears in Ryan's scope switcher

### 675d: Fix attestation issuer references
- `verification.ts`: `RELAY_DID || AUTH_DID || ''` → read `relay.relay_config.imajin_did` at module load, fall back to `RELAY_DID` env var
- `emit-session-attestation.ts`: `PLATFORM_DID` → same node DID source
- `register/route.ts`: same (the preliminary emission we added tonight)
- `check-in/route.ts`: same
- Remove all `AUTH_DID` references (dead code)
- Create a shared helper: `getNodeDid()` in `@/src/lib/kernel/node-identity.ts` — reads from DB once, caches, env fallback

### 675e: Backfill attestations (optional)
- Update attestations where `issuer_did = ''` to the new node DID
- Update attestations where `issuer_did = 'did:imajin:platform'` (if any leaked through)

### Verification
- Ryan can switch to node DID in scope switcher
- `getNodeDid()` returns the correct DID
- New registrations emit preliminary attestation with node DID as issuer
- Session attestations use node DID

---

## Work Order 2: Admin Console Scaffolding (#664)
**Estimated effort:** 1 day
**Status:** Blocked by WO1
**Blocks:** All Phase 1 features

### 664a: Route + layout
- `/admin` route group in `apps/kernel/app/www/admin/` (or `apps/kernel/app/admin/`)
- Layout with sidebar navigation
- Tabs: Overview, Users, Subscribers, Newsletter, Services, Federation, Storage, Config, Moderation, Security
- Dark theme consistent with existing UI

### 664b: Auth gate
- Layout-level check: must be acting-as a DID with scope = 'node' (from `group_identities`)
- Redirect to `/` if not authorized
- Show "Switch to node admin" prompt if authenticated but not acting-as node

### 664c: Overview landing page
- Total identities (count by tier: soft/preliminary/established)
- Active sessions (last 24h from session attestations)
- Subscriber count (from `www.contacts`)
- Service health summary (ping all `/api/health` endpoints)
- Recent attestations (last 10 from `auth.attestations`)
- Simple stat cards + one list — no charts needed for v1

### Verification
- Switching to node DID in scope switcher → admin console accessible
- Switching back → redirected away
- Overview shows real data from existing tables

---

## Work Order 3: Users + Service Health (#665, #666)
**Estimated effort:** 2-3 days
**Status:** Blocked by WO2
**Can be split across two agents**

Highest-value, lowest-complexity. Both are mostly read-only views over existing tables.

### 665a: User list page (`/admin/users`)
- Paginated table: handle, name, type, tier, created_at
- Sort by: created_at, tier
- Filter by: tier, type
- Search by handle or name
- API: `GET /api/admin/users` with query params

### 665b: User detail page (`/admin/users/[did]`)
- Identity info from `auth.identities`
- Profile from `profile.profiles`
- Connection count from `connections.connections`
- MJN balance from `pay.balances`
- Recent attestations (subject or issuer)
- Recent transactions

### 665c: User actions
- Suspend DID: add `suspended_at` column to `auth.identities` (drizzle schema + migration)
- Unsuspend DID
- Manual tier upgrade (with attestation emission via node DID)
- API: `POST /api/admin/users/[did]/suspend`, `POST /api/admin/users/[did]/upgrade-tier`

### 666a: Service health page (`/admin/services`)
- Grid of all services with status cards
- Parallel fetch to each `/api/health` endpoint with 2s timeout
- Status: healthy (200) / degraded (slow) / down (error/timeout)
- Response time display
- Auto-refresh every 60s
- API: `GET /api/admin/services/health` (aggregated, cached 30s)

### 666b: Extend health endpoints
- Add version info (from `NEXT_PUBLIC_VERSION` + `NEXT_PUBLIC_BUILD_HASH`)
- Add uptime (process start time)
- Return: `{ status: 'ok', version: '0.5.1+1724', uptime: 86400 }`

### Verification
- User list shows all 164 prod identities with correct tiers
- User detail shows balance, connections, attestations
- Suspend/unsuspend works + blocks authentication
- Service health shows real-time status of all kernel + userspace services

---

## Work Order 4: Subscribers + Newsletter (#669, #663)
**Estimated effort:** 2-3 days
**Status:** Blocked by WO2
**Can be split across two agents**

### Schema change (shared prerequisite)
- Add `owner_did TEXT` to `www.mailing_lists` (nullable, null = node-level)
- Add `newsletter_sends` table to `registry`: id, sender_did, subject, audience_type, audience_id, recipient_count, sent_at
- Drizzle schema + migration

### 669a: Subscriber list page (`/admin/subscribers`)
- Paginated table from `www.contacts` + `www.subscriptions`
- Scoped by acting-as DID (`mailing_lists.owner_did`)
- Node admin sees all lists
- Filter: verified/unverified, active/unsubscribed, source
- Search by email

### 669b: Mailing list management
- List all mailing lists for acting-as DID
- Create / edit / archive list
- Subscriber count per list

### 669c: Subscriber actions
- Export CSV
- Manual add
- Bulk import (CSV)
- Resend verification
- Remove subscriber

### 663a: Newsletter composer page (`/admin/newsletter`)
- Subject line + markdown textarea with preview toggle
- Audience picker with two modes:
  - **Newsletter mode:** select from mailing lists owned by acting-as DID
  - **Connections mode:** all connections of acting-as DID, filtered by declared interests
- Recipient count display (live, updates with selection)
- "Send Test" button (sends to operator's email)
- "Send" confirmation dialog → calls `notify.broadcast()`

### 663b: Newsletter API
- `POST /api/admin/newsletter/send` — resolve audience, call notify.broadcast()
- `GET /api/admin/newsletter/audiences` — available lists + connection counts
- `GET /api/admin/newsletter/history` — past sends from `newsletter_sends`

### Verification
- Creating a mailing list as node DID → visible in subscriber management
- Import subscribers → appear in list
- Compose newsletter → select audience → send test → send for real
- History shows past sends
- Acting-as a community scope → only sees that scope's lists

---

## Work Order 5: Federation + Storage + Config + Moderation (#670, #674, #667, #668)
**Estimated effort:** 3-4 days
**Status:** Blocked by WO2
**Can be split across 2-4 agents — all independent of each other**

### 670: Federation dashboard (`/admin/federation`)
- Relay status (ping relay endpoint, show version + conformance)
- Peer list from `relay.relay_peer_cursors` with last sync times
- Chain counts from `relay.relay_identity_chains` + `relay.relay_content_chains`
- Recent operations from `relay.relay_operation_log`
- Add/remove peer, force re-sync
- API routes for each

### 674: Storage + media (`/admin/storage`)
- Disk usage overview (total vs capacity on `/mnt/media`)
- Usage per DID from `media.assets` (SUM of file sizes, grouped by owner)
- Asset browser: paginated, filterable by owner/type/date
- Orphan detection: assets not referenced in `media.asset_references`
- Delete action with confirmation

### 667: Node config (`/admin/config`)
- Registration mode: read current env var state, write to `registry.node_config` table (new)
  - `registry.node_config`: key-value table (key TEXT PK, value JSONB, updated_at)
  - Services read from DB with env var fallback
- Node name/description (editable, stored in node's profile)
- Resource limits (max identities, max storage per DID)
- Rate limit config display (read-only for v1, show current hardcoded values)

### 668: Moderation (`/admin/moderation`)
- New tables: `registry.flags`, `registry.moderation_log`
- Moderation queue: flagged items with action buttons (dismiss/warn/suspend/remove)
- Audit log: every moderation action recorded
- Manual flag button (operator spots something)
- Connects to user suspend from #665

### Verification per feature
- Federation: peer list matches actual DFOS mesh, operations log shows real data
- Storage: usage numbers match actual disk, orphan detection finds real orphans
- Config: changing registration mode persists and takes effect
- Moderation: full flag → review → action → audit log flow

---

## Agent Spawn Notes

Each work order section (665a, 665b, etc.) is agent-sized. When spawning:

1. **Always include:** "When your task is complete, append a summary to `memory/YYYY-MM-DD.md`"
2. **Give explicit file paths** — agents nail it when they know exactly where to look
3. **Include the pattern:** `const did = identity.actingAs || identity.id` and the auth gate pattern
4. **Reference existing examples:** event admin page (`apps/events/app/admin/[eventId]/page.tsx`), message composer, guest list
5. **Schema changes:** include drizzle migration generation command (`pnpm drizzle-kit generate`)
6. **Lockfile:** include `pnpm install` if dependencies change, commit `pnpm-lock.yaml`

## Not in Phase 1

- Structured logging (#672) — Phase 2
- Event bus (#673) — Phase 2
- Security monitoring (#671) — Phase 3
- Charts / analytics dashboards — future
- Scheduled sends — future
- Rich text editor — markdown is fine
