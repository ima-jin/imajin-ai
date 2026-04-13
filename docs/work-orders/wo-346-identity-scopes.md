# Work Order: Identity Scopes (#346)

**Goal:** Consolidate three redundant identity classification systems into two fields on `auth.identities`: `scope` + `subtype`. Drop `group_identities` table and `profiles.displayType` column.

**Current state (3 sources of truth):**
| Column | Table | Values |
|--------|-------|--------|
| `identities.type` | auth | `human`, `agent`, `org`, `community`, `family` |
| `group_identities.scope` | auth | `org`, `community`, `family` |
| `profiles.displayType` | profile | `human`, `agent`, `device`, `org`, `event`, `service`, `presence` |

**Target state (1 source of truth):**
| Column | Table | Values |
|--------|-------|--------|
| `identities.scope` | auth | `actor`, `family`, `community`, `business` |
| `identities.subtype` | auth | scope-dependent (e.g. `human`, `agent`, `device`, `cafe`, `inc`, `club`) |

**Branch:** `feat/346-identity-scopes` from `main`

**Critical path:**
```
WO1 (schema migration + auth code) → WO2 (profile + UI + drop group_identities)
```

WO1 must land first — WO2 depends on `scope`/`subtype` columns existing and auth code using them.

---

## Work Order 1: Schema Migration + Auth Layer

**Estimated effort:** 1-2 hours (agent)
**Blocks:** WO2

### 1. Migration SQL

Create new migration in `apps/kernel/src/db/migrations/` (next available number). All DDL must be idempotent.

```sql
-- Step 1: Add new columns
ALTER TABLE auth.identities ADD COLUMN IF NOT EXISTS scope TEXT;
ALTER TABLE auth.identities ADD COLUMN IF NOT EXISTS subtype TEXT;

-- Step 2: Backfill scope + subtype from existing type
UPDATE auth.identities SET scope = 'actor', subtype = type WHERE type IN ('human', 'agent', 'presence');
UPDATE auth.identities SET scope = 'business' WHERE type = 'org';
UPDATE auth.identities SET scope = 'community' WHERE type = 'community';
UPDATE auth.identities SET scope = 'family' WHERE type = 'family';
-- Groups don't have subtypes yet — null is fine

-- Step 3: Make scope NOT NULL now that it's backfilled
-- (Do this as a separate statement after backfill)
ALTER TABLE auth.identities ALTER COLUMN scope SET NOT NULL;

-- Step 4: Drop old type column
ALTER TABLE auth.identities DROP COLUMN IF EXISTS type;

-- Step 5: Index on scope
CREATE INDEX IF NOT EXISTS idx_identities_scope ON auth.identities (scope);
```

### 2. Schema Definition

Update `apps/kernel/src/db/schemas/auth.ts`:

```ts
// identities table — CHANGE:
// Remove:  type: text('type').notNull(),
// Add:
scope: text('scope').notNull(),          // 'actor' | 'family' | 'community' | 'business'
subtype: text('subtype'),                // scope-dependent: 'human' | 'agent' | 'device' | 'cafe' | etc.
```

Update exported types (`Identity`, `NewIdentity`) — these auto-derive from the table, so just verify they look right.

### 3. Auth Code Changes (~30 references)

**Registration (`auth/api/register/route.ts`):**
- `type: 'human'` → `scope: 'actor', subtype: 'human'`
- Validation: accept `scope` + `subtype` in request body (default: `scope: 'actor', subtype: 'human'`)
- The JSDoc comment on line 29 lists old types — update it

**Group creation (`auth/api/groups/route.ts`):**
- `VALID_SCOPES`: `['org', 'community', 'family']` → `['business', 'community', 'family']`
- Identity insert: `type: scope` → `scope: validatedScope, subtype: body.subtype || null`
- Remove `group_identities` insert entirely (table is being dropped in WO2)
- Keep `groupControllers` insert as-is

**Group read (`auth/api/groups/[groupDid]/route.ts`):**
- Read `scope` from `identities` table instead of `groupIdentities`
- Remove `groupIdentities` from the join
- `createdBy`: read from `groupControllers` where `role = 'owner'` instead of `groupIdentities.createdBy`

**Group list (`auth/api/groups/route.ts` GET):**
- Join `groupControllers` → `identities` directly, read `identities.scope`
- Remove `groupIdentities` from the join

**Onboarding (`auth/api/onboard/generate/route.ts`, `onboard/verify/route.ts`):**
- `type: 'human'` → `scope: 'actor', subtype: 'human'`

**Magic link (`auth/api/magic/route.ts`):**
- `type: 'human'` → `scope: 'actor', subtype: 'human'`

**Soft session (`auth/api/session/soft/route.ts`):**
- `type: 'human'` → `scope: 'actor', subtype: 'human'`

**Node registration (`registry/api/node/register/route.ts`, `node/heartbeat/route.ts`):**
- `type: 'agent'` → `scope: 'actor', subtype: 'agent'`

**Identity endpoints (`auth/api/identity/*/route.ts`):**
- Any `identities.type` selections → `identities.scope` + `identities.subtype`

**Verification/lookup (`src/lib/kernel/verification.ts`, `src/lib/kernel/lookup.ts`):**
- `eq(identities.type, 'human')` → `eq(identities.scope, 'actor')` (all current actors are human)

**DFOS integration (`src/lib/auth/dfos.ts`):**
- `type: identities.type` → `scope: identities.scope, subtype: identities.subtype`

**Client-side contexts (`src/contexts/IdentityContext.tsx`, `profile/context/IdentityContext.tsx`):**
- `type: raw.type || 'human'` → `scope: raw.scope || 'actor', subtype: raw.subtype || 'human'`

**requireAuth (`packages/auth/src/require-auth.ts`):**
- `type: data.type` → `scope: data.scope, subtype: data.subtype`
- Return shape: `identity.scope` and `identity.subtype` instead of `identity.type`

**Pay connect (`pay/api/connect/onboard/route.ts`):**
- `identity.type !== 'human'` → `identity.scope !== 'actor'` (or check subtype if you want to restrict to humans only)

**Key auth tab (`auth/login/components/KeyAuthTab.tsx`):**
- `type: 'human'` → `scope: 'actor', subtype: 'human'`

**Profile registration UI (`profile/register/page.tsx`):**
- `type: 'human'` → `scope: 'actor', subtype: 'human'`

**Bootstrap node script (`scripts/bootstrap-node-identity.ts`):**
- Update if it references `type`

### 4. Validation Rules

```ts
const VALID_SCOPES = ['actor', 'family', 'community', 'business'] as const;

// Subtype validation is scope-dependent, application-layer only
const VALID_ACTOR_SUBTYPES = ['human', 'agent', 'device'] as const;
// Business, family, community subtypes: open text for now, no validation
```

### 5. Tests

If any existing tests reference `type: 'human'` or `type: 'agent'`, update to `scope`/`subtype`.

### Done Criteria
- [ ] Migration runs cleanly (dev DB)
- [ ] `identities` table has `scope` + `subtype`, no `type` column
- [ ] All auth routes create identities with `scope` + `subtype`
- [ ] Group creation no longer inserts into `group_identities`
- [ ] `requireAuth()` returns `scope` + `subtype` on the identity object
- [ ] No TypeScript errors (`pnpm --filter @imajin/kernel build` succeeds)

---

## Work Order 2: Profile Layer + Drop group_identities

**Estimated effort:** 1-2 hours (agent)
**Depends on:** WO1 merged to feature branch

### 1. Drop `profiles.displayType`

**Migration SQL:**
```sql
-- Drop displayType column from profiles
ALTER TABLE profile.profiles DROP COLUMN IF EXISTS display_type;

-- Drop the index on it
DROP INDEX IF EXISTS profile.idx_profiles_display_type;
```

**Schema (`apps/kernel/src/db/schemas/profile.ts`):**
- Remove `displayType` column definition
- Remove `displayTypeIdx` index definition

### 2. Drop `group_identities` Table

**Migration SQL:**
```sql
DROP TABLE IF EXISTS auth.group_identities;
```

**Schema (`apps/kernel/src/db/schemas/auth.ts`):**
- Remove `groupIdentities` table definition
- Remove `GroupIdentity` and `NewGroupIdentity` type exports

**DB barrel export (`apps/kernel/src/db/index.ts` or equivalent):**
- Remove `groupIdentities` from exports

### 3. Profile Code Changes (~34 displayType references)

**Dashboard pages (`app/page.tsx`, `app/project/page.tsx`):**
- Raw SQL `WHERE display_type = 'human'` → join to `auth.identities` and filter `WHERE scope = 'actor'`
- Same for `'org'` → `scope IN ('business', 'community', 'family')` or just `scope != 'actor'`
- Agent/device/service counts → `WHERE scope = 'actor' AND subtype != 'human'`

**Profile display (`profile/[handle]/page.tsx`):**
- `profile.displayType` → join identity to get `scope` + `subtype`
- `typeEmoji` / `typeLabels` maps: key by scope+subtype instead of displayType
- Meta descriptions using displayType → use scope+subtype

**Profile edit (`profile/edit/page.tsx`):**
- Remove `displayType` from the type definition

**Profile API routes:**
- `POST /api/profile` — remove `displayType` from request body, don't insert it
- `PATCH /api/profile/[id]` — remove displayType update logic
- `GET /api/profile/search` — filter by scope (joined from identities) instead of displayType
- `POST /api/soft-register` — remove `displayType: 'human'` from insert
- `POST /api/register` — remove `displayType: 'human'` from insert

**Group creation (`auth/api/groups/route.ts`):**
- Profile insert: remove `displayType: scope` — column no longer exists

**Chat session (`chat/api/session/route.ts`):**
- `profile.displayType` → derive from identity scope+subtype

**Admin pages:**
- `admin/users/[did]/page.tsx` — remove `display_type` from SQL select + UI
- `admin/subscribers/page.tsx` — raw SQL referencing `group_identities` → check `identities.scope != 'actor'`
- `admin/newsletter/page.tsx` — same
- `admin/layout.tsx` — same
- `api/admin/verify/route.ts` — same

**`packages/auth/src/require-admin.ts`:**
- Raw SQL `SELECT group_did FROM auth.group_identities` → `SELECT id FROM auth.identities WHERE scope != 'actor'`
- Adjust the admin check logic accordingly

### 4. Profile Queries Helper (optional but recommended)

Since many places now need scope+subtype from identity joined to profile, consider a shared query fragment:

```ts
// In a shared location (e.g. src/lib/kernel/identity.ts)
export function identityLabel(scope: string, subtype: string | null): string {
  if (subtype) return subtype; // 'human', 'cafe', etc.
  return scope; // fallback to scope name
}

export const scopeEmoji: Record<string, string> = {
  actor: '👤',
  family: '👨‍👩‍👧‍👦',
  community: '🌐',
  business: '🏢',
};
```

### Done Criteria
- [ ] `profiles` table has no `display_type` column
- [ ] `group_identities` table dropped
- [ ] All 34 displayType references removed/replaced
- [ ] All 6 group_identities references removed/replaced
- [ ] Admin pages still work (scope checks via identities table)
- [ ] Profile pages render correctly with scope+subtype
- [ ] No TypeScript errors (`pnpm --filter @imajin/kernel build` succeeds)

---

## Work Order 3: Rename groupControllers → identityMembers + Gate Act-As

**Estimated effort:** 1-2 hours (agent)
**Depends on:** WO1 + WO2 committed on feature branch

### Why

`group_controllers` conflates two things: control (act-as) and membership. The table has `role: 'owner' | 'admin' | 'member'` but every row grants act-as access — the `act-as` route doesn't check role. Renaming + role-gating fixes this and prepares the table for #653 (stubs add `maintainer`, `contributor` roles).

### 1. Migration SQL

```sql
-- Rename table
ALTER TABLE auth.group_controllers RENAME TO auth.identity_members;

-- Rename columns to be scope-neutral
ALTER TABLE auth.identity_members RENAME COLUMN group_did TO identity_did;
ALTER TABLE auth.identity_members RENAME COLUMN controller_did TO member_did;

-- Rename indexes
ALTER INDEX IF EXISTS idx_group_controllers_pk RENAME TO idx_identity_members_pk;
ALTER INDEX IF EXISTS idx_group_controllers_controller RENAME TO idx_identity_members_member;
```

### 2. Schema Definition

Update `apps/kernel/src/db/schemas/auth.ts`:

```ts
// Rename groupControllers → identityMembers
export const identityMembers = authSchema.table('identity_members', {
  identityDid: text('identity_did').notNull(),
  memberDid: text('member_did').notNull(),
  role: text('role').notNull().default('member'),         // 'owner' | 'admin' | 'maintainer' | 'member' | ...
  allowedServices: text('allowed_services').array(),
  addedBy: text('added_by'),
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow(),
  removedAt: timestamp('removed_at', { withTimezone: true }),
}, (table) => ({
  pk: index('idx_identity_members_pk').on(table.identityDid, table.memberDid),
  memberIdx: index('idx_identity_members_member').on(table.memberDid),
}));

export type IdentityMember = typeof identityMembers.$inferSelect;
export type NewIdentityMember = typeof identityMembers.$inferInsert;
```

Remove old `groupControllers` + `GroupController` / `NewGroupController` types.

### 3. Act-As Role Gate

In `auth/api/session/act-as/route.ts`, add role check:

```ts
const ACT_AS_ROLES = ['owner', 'admin'];

// In the query:
.where(
  and(
    eq(identityMembers.identityDid, did),
    eq(identityMembers.memberDid, caller.id),
    inArray(identityMembers.role, ACT_AS_ROLES),
    isNull(identityMembers.removedAt)
  )
)
```

### 4. Code Changes (~90 references across 9 files)

All references to `groupControllers` → `identityMembers`, `groupDid` → `identityDid`, `controllerDid` → `memberDid`:

**Files:**
- `apps/kernel/src/db/schemas/auth.ts` — schema definition
- `apps/kernel/src/db/index.ts` — barrel export
- `apps/kernel/app/auth/api/groups/route.ts` — group creation (insert member as owner)
- `apps/kernel/app/auth/api/groups/[groupDid]/route.ts` — group detail + update
- `apps/kernel/app/auth/api/groups/[groupDid]/controllers/route.ts` — list/add controllers
- `apps/kernel/app/auth/api/groups/[groupDid]/controllers/[controllerDid]/route.ts` — remove/update controller
- `apps/kernel/app/auth/api/session/act-as/route.ts` — act-as switching (+ add role gate)
- `apps/kernel/app/auth/api/onboard/generate/route.ts` — scope join on onboard
- `apps/kernel/app/auth/api/onboard/verify/route.ts` — scope join on verify
- `apps/kernel/app/profile/api/forest/[groupDid]/config/route.ts` — forest config access check

**Optional:** Rename the `controllers/` route directories to `members/` for consistency. If too disruptive, leave the URL paths and just change the internal references.

### 5. Identity Hub Scope Switcher

The identity hub lists groups you can act-as. Verify it filters by `role IN ('owner', 'admin')` so members don't see groups in their scope switcher. Check:
- `apps/kernel/app/auth/` — any component that lists "my identities" for the switcher

### Done Criteria
- [ ] `group_controllers` table renamed to `identity_members`
- [ ] Columns renamed: `group_did` → `identity_did`, `controller_did` → `member_did`
- [ ] Act-as route gates on `role IN ('owner', 'admin')`
- [ ] All 90 `groupControllers` references updated
- [ ] Schema types updated (`IdentityMember`, `NewIdentityMember`)
- [ ] No TypeScript errors (`pnpm --filter @imajin/kernel build` succeeds)
- [ ] Commit with descriptive message referencing #346

---

## Work Order 4: Stub Business Identities (#653 core primitive)

**Estimated effort:** 2-3 hours (agent)
**Depends on:** WO1-WO3 committed on feature branch

### Goal

Any authenticated user can create a **stub** — an unclaimed business identity that the community maintains until the real owner arrives. This is the cold-start engine: customers build a business's presence before the business signs up.

A stub is a normal `scope: 'business'` identity where `claimed_by` is null. The creator becomes `role: 'maintainer'` (not owner/admin — no act-as). A separate "Places I Maintain" section surfaces these.

### 1. Schema Changes

**Migration 0020 (`apps/kernel/drizzle/0020_stub_business_identities.sql`):**

```sql
-- Stub tracking on profiles
ALTER TABLE profile.profiles ADD COLUMN IF NOT EXISTS claimed_by TEXT;        -- owner DID, null = unclaimed stub
ALTER TABLE profile.profiles ADD COLUMN IF NOT EXISTS claim_status TEXT;       -- 'unclaimed' | 'pending' | 'claimed'

CREATE INDEX IF NOT EXISTS idx_profiles_claim_status ON profile.profiles (claim_status) WHERE claim_status IS NOT NULL;
```

**Update `apps/kernel/src/db/schemas/profile.ts`:**

Add to the `profiles` table definition:
```ts
claimedBy: text('claimed_by'),                              // owner DID, null = unclaimed stub
claimStatus: text('claim_status'),                          // 'unclaimed' | 'pending' | 'claimed'
```

### 2. API Endpoints

**New: `POST /api/stubs` (`apps/kernel/app/profile/api/stubs/route.ts`)**

Create a stub business identity. Flow:
1. Validate request: `name` required, optional `subtype` (default `null`), optional `handle`, `location` (jsonb in metadata), `category`
2. Create identity: `scope: 'business'`, `subtype: body.subtype || null` — use the same keypair generation + encryption as groups route (`auth/api/groups/route.ts`)
3. Create profile: `displayName`, `handle`, `bio`, `metadata: { location, category }`, `claimStatus: 'unclaimed'`
4. Add creator as maintainer: `identity_members` with `role: 'maintainer'`
5. Emit attestation: `type: 'stub.created'`
6. Return `{ did, name, handle, scope: 'business', claimStatus: 'unclaimed' }`

Reuse the `encryptPrivateKey` helper from groups route — extract it to a shared location if not already shared (e.g. `src/lib/auth/crypto.ts`).

**New: `GET /api/stubs/mine` (`apps/kernel/app/profile/api/stubs/mine/route.ts`)**

List stubs the caller maintains:
```sql
SELECT im.identity_did, im.role, p.display_name, p.handle, p.metadata, p.claim_status
FROM auth.identity_members im
JOIN profile.profiles p ON p.did = im.identity_did
WHERE im.member_did = :callerDid
  AND im.role = 'maintainer'
  AND im.removed_at IS NULL
```

Return array of `{ did, name, handle, metadata, claimStatus, role }`.

**Extend: `GET /api/profile/[id]` response**

When fetching a business profile, include:
- `claimStatus` — from profiles table
- `maintainerCount` — count of `identity_members` where `role = 'maintainer'` for this DID
- `isMaintainer` — if authenticated caller is a maintainer of this stub

### 3. UI Components

**New: "Places I Maintain" section in Identity Hub (`apps/kernel/app/auth/page.tsx`)**

Below the identity switcher / identity detail area, add a section:
- Header: "Places I Maintain" (only shows if user has any maintainer roles)
- List of stubs with name, category (from metadata), claim status badge
- Each item links to the stub's profile page (`/profile/[handle]`)
- "Add a place" button that opens the stub creation flow

This section is NOT in the scope switcher — maintainers cannot act-as stubs.

**New: Stub Creation Form**

Simple form accessible from "Add a place" button:
- Name (required)
- Category (optional — text input or common presets like café, restaurant, shop, venue, studio)
- Location (optional — text input, stored in profile metadata)
- Handle (optional)
- Submit → `POST /api/stubs`

Can be a modal or a new page at `/auth/stubs/new`. Keep it simple.

**Extend: Profile page (`apps/kernel/app/profile/[handle]/page.tsx`)**

For unclaimed business profiles:
- Show "Community-maintained" badge near the name
- Show maintainer count: "Maintained by N people"
- If viewer is authenticated: "Suggest an edit" link (placeholder — just a visual for now, edit flow is #653 follow-up)
- If viewer is authenticated + not already a maintainer: "Help maintain this place" button → adds them as maintainer via new endpoint

**New: `POST /api/stubs/[did]/join` (`apps/kernel/app/profile/api/stubs/[did]/join/route.ts`)**

Join as maintainer of an unclaimed stub:
1. Verify stub exists and `claim_status = 'unclaimed'`
2. Check caller isn't already a member
3. Insert into `identity_members` with `role: 'maintainer'`
4. Return `{ ok: true }`

### 4. IdentitySwitcher Update

The `IdentitySwitcher` component at `apps/kernel/app/auth/components/IdentitySwitcher.tsx` has stale scope icons. Update:
```ts
function scopeIcon(scope: string): string {
  if (scope === 'community') return '🌐';
  if (scope === 'business') return '🏢';
  if (scope === 'family') return '👨‍👩‍👧‍👦';
  return '👤';
}
```

Remove `org`, `node`, `agent`, `device` cases — those are subtypes now, not scopes. The switcher only shows identities you can act-as (owner/admin), which are always scoped identities.

### 5. Validation

- Only `scope: 'actor'` identities (humans) can create stubs — agents/devices cannot
- Handle uniqueness check (same as groups route)
- Stub creation rate limit: consider max 10 stubs per actor (application-layer, not DB constraint) — implement as a count check before insert

### Done Criteria
- [ ] Migration 0020 adds `claimed_by` + `claim_status` to profiles
- [ ] `POST /api/stubs` creates business identity + profile + maintainer membership
- [ ] `GET /api/stubs/mine` returns caller's maintained stubs
- [ ] `POST /api/stubs/[did]/join` allows joining as maintainer
- [ ] `GET /api/profile/[id]` includes claim status + maintainer count for business profiles
- [ ] "Places I Maintain" section visible in identity hub when user has stubs
- [ ] Stub creation form works (modal or page)
- [ ] Profile page shows community-maintained badge for unclaimed stubs
- [ ] IdentitySwitcher scope icons updated for new scope values
- [ ] `encryptPrivateKey` extracted to shared location (not duplicated)
- [ ] No TypeScript errors (`pnpm --filter @imajin/kernel build` succeeds)
- [ ] Commits reference both #346 and #653

---

## Agent Instructions (all WOs)

**Repo:** `/home/veteze/.openclaw/workspace/imajin-ai`
**Branch:** Create `feat/346-identity-scopes` from `main`

Before starting:
1. Read `apps/kernel/src/db/schemas/auth.ts` and `apps/kernel/src/db/schemas/profile.ts` for current schema
2. Read `packages/auth/src/require-auth.ts` for identity return shape
3. `grep -rn 'identities.type\|\.type.*human\|group_identities\|groupIdentities\|displayType\|display_type' apps/kernel/ packages/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v .next` to find all references

Key rules:
- All migration DDL must be idempotent (`IF NOT EXISTS`, `IF EXISTS`)
- Do NOT edit code on the server
- Run `pnpm --filter @imajin/kernel build` to verify no TypeScript errors before committing
- Commit with descriptive messages referencing #346
- When done, append a summary to `memory/2026-04-12.md`
