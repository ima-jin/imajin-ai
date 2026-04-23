# BUG-25 — Group Creation UI Sends pre-WO1 `scope: 'org'` ✅ RESOLVED 2026-04-21

**Filed:** 2026-04-13 (as `proposals/fixproposal.md`)
**Resolved:** commit `96cdc20f` — *"fix(auth): use scope='business' in create-group UI (post-WO1)"* — applied upstream verbatim from the suggested diff below. Verified at `apps/kernel/app/auth/groups/new/page.tsx:9` (`{ value: 'business', ... }`).
**Moved to `problems/resolved/` as BUG-25:** 2026-04-22 (renumbered into the BUG-N series; was an unnumbered one-off fix proposal).

---

**Date:** 2026-04-13
**Severity:** Blocker — users cannot create business/organization identities
**Scope:** `apps/kernel` (UI only; server and schema are correct)
**Introduced by:** PR #687 (WO1 migration `0017_identity_scopes.sql`, #346)
**One-line fix + two cosmetic follow-ups**

---

## Symptom

Users reporting "can't add/join to groups." Reproducer:

1. Navigate to `/auth/groups/new`
2. Click **Organization 🏢**
3. Enter a name → click **Create Identity**
4. UI shows *"Something went wrong"*

Server response is `400 { error: "scope required: business, community, family" }`.

Community and Family group creation still work. Stub business creation (`/profile/api/stubs`) also works because it hard-codes `scope: 'business'`.

## Why "add/join" is blocked

- **Add controller** (`POST /auth/api/groups/[groupDid]/controllers`) requires an existing group row. If Organization creation 400s, no groupDid ever exists to add controllers to.
- **Join as maintainer** (`POST /profile/api/stubs/[did]/join`) works against stubs, so the bug looks intermittent — users can sometimes join a stub someone else created, but cannot create the business identity themselves.

## Root cause

Migration `apps/kernel/drizzle/0017_identity_scopes.sql:11` renamed the identity type:

```sql
UPDATE auth.identities SET scope = 'business' WHERE type = 'org';
```

The server in `apps/kernel/app/auth/api/groups/route.ts:12` was updated accordingly:

```ts
const VALID_SCOPES = ['business', 'community', 'family'] as const;
```

But the create-group UI in `apps/kernel/app/auth/groups/new/page.tsx:5–9` still sends the pre-WO1 literal:

```ts
const SCOPES = [
  { value: 'community', label: 'Community',   icon: '🏛️', desc: 'A public or semi-public group' },
  { value: 'org',       label: 'Organization', icon: '🏢', desc: 'A business or project' },  // ← sends 'org'
  { value: 'family',    label: 'Family',       icon: '👨‍👩‍👦', desc: 'A private family group' },
] as const;
```

The POST body therefore carries `scope: 'org'`, the server rejects it via `VALID_SCOPES.includes(...)` at `route.ts:44`, and the UI surfaces the 400 as generic *"Something went wrong."*

## The fix (blocker)

**File:** `apps/kernel/app/auth/groups/new/page.tsx:7`

```diff
-  { value: 'org', label: 'Organization', icon: '🏢', desc: 'A business or project' },
+  { value: 'business', label: 'Organization', icon: '🏢', desc: 'A business or project' },
```

One-line change. No server, schema, or migration change required.

## Related cosmetic bugs (same migration, not blockers)

Same `scope === 'org'` check exists in two icon lookups that silently never match post-0017, so business groups render the default fallback icon everywhere:

**File:** `apps/kernel/app/auth/groups/[groupDid]/settings/page.tsx:32`

```diff
-  if (scope === 'org') return '🏢';
+  if (scope === 'business') return '🏢';
```

**File:** `apps/kernel/app/auth/onboard/page.tsx:166`

```diff
-  {scopeProfile?.scope === 'org' ? '🏢' : scopeProfile?.scope === 'family' ? '👨‍👩‍👦' : '🏛️'}
+  {scopeProfile?.scope === 'business' ? '🏢' : scopeProfile?.scope === 'family' ? '👨‍👩‍👦' : '🏛️'}
```

## What I ruled out

- **Server routes are clean.** `POST /auth/api/groups` (create), `POST /auth/api/groups/[groupDid]/controllers` (add), and `POST /profile/api/stubs/[did]/join` (join-as-maintainer) all use the renamed `identityMembers` table with `identityDid`/`memberDid` columns correctly.
- **Schema and migrations align.** `identity_members` rename is in `0019_rename_group_controllers_to_identity_members.sql`; `0017_identity_scopes.sql` backfills `scope='business'` for legacy `type='org'` rows; `0018_drop_display_type_and_group_identities.sql` drops the old `group_identities` table.
- **DB barrel is correct.** `apps/kernel/src/db/index.ts:31` re-exports `identityMembers` via `export * from './schemas/auth'`.
- **act-as gate is intentional.** `apps/kernel/app/auth/api/session/act-as/route.ts:12` restricts acting-as to `['owner', 'admin']`, intentionally excluding `'maintainer'` (the role stub creators receive). This is design, not a regression.

## Verification after fix

1. `/auth/groups/new` → pick **Organization** → creates, redirects to `/auth/groups/{did}/settings`. New row in `auth.identities` has `scope='business'`.
2. `POST /auth/api/groups/{did}/controllers` with a member DID → `201`, row appears in `auth.identity_members`.
3. Visiting the settings page for a business identity shows the 🏢 icon (cosmetic fix).
4. Onboarding flow for a business scope shows the 🏢 icon (cosmetic fix).

## Suggested commit

```
fix(auth): use scope='business' in create-group UI (post-WO1)

The create-group UI at /auth/groups/new was still sending the
pre-0017_identity_scopes scope literal 'org', which the server
rejects with 400. Migration 0017 renamed that scope to 'business'
and the server was updated; the UI was missed.

Also fixes two icon-lookup sites that silently never matched
after the rename, so business groups render the 🏢 icon again.

Fixes: create Organization identity → 400 "scope required"
Refs: #346 #687
```
