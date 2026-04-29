# Group Identity, Scope Switching & Forest Pages Audit
**Date:** 2026-04-20
**Auditor:** Claude (read-only, no source modifications)
**Scope:** Group identity creation, act-as/scope switching, forest config, stub management, delegated app sessions

---

## 1. Status Summary

Approximately **70–75% of flows are working end-to-end.** The core group identity lifecycle (create, act-as switch, forest config, member management) is solid. The primary gaps are: the delegated app session / OAuth consent flow described in RFC-19 is entirely unimplemented at the kernel level; several components referenced in the audit checklist do not exist; and the `GET /api/groups` endpoint only returns `owner`/`admin` roles, silently dropping `maintainer`-role members from the switcher list.

---

## 2. Working Flows

### Group Identity Creation
- `POST /auth/api/groups` creates a full group identity (business, community, family): generates Ed25519 keypair, stores encrypted private key, inserts into `identities`, creates owner membership in `identityMembers`, writes profile, emits `group.created` attestation. Location geocoding has a server-side Nominatim fallback if the client didn't resolve coordinates.
- `/auth/groups/new/page.tsx` is a well-built form with scope picker, subtype pills, category presets, debounced address autocomplete (Nominatim), device GPS, and handle normalization. Redirects to settings page on success.

### Act-As / Scope Switching
- `POST /auth/api/session/act-as` validates that the calling identity has `owner` or `admin` role in `identityMembers` (not just trusting the cookie), sets `x-acting-as` cookie via `response.cookies.set`, and returns `actingAs` in the response body.
- `IdentitySwitcher` in `@imajin/ui` reads the acting-as DID from `localStorage` (via `acting-as.ts`), makes the POST request, syncs both localStorage and the cookie client-side, and reloads. The switcher correctly treats `null` as "return to personal identity."
- `requireAuth` in `@imajin/auth` reads `x-acting-as` from the header, cookie, or raw `Cookie` header; validates it against the kernel's `/api/groups/{groupDid}/controllers/{callerDid}` endpoint using an internal API key; rejects if role is not `owner` or `admin`; attaches `actingAs` and `actingAsServices` to the identity object. **Server-side validation is correct — the cookie value is never trusted raw.**
- `getSession` (server components) does the same acting-as validation using the Next.js cookie store.
- `pay/page.tsx` correctly uses `session.actingAs || session.id` for the effective DID when loading balances/transactions.

### Forest Config (Group Pages)
- `forestConfig` table exists with correct schema: `groupDid`, `enabledServices` (text array), `landingService`, `theme`, `scopeFeeBps`.
- `GET/PATCH /profile/api/forest/[groupDid]/config` is implemented with proper RBAC: GET requires membership (any role), PATCH requires `admin` or `owner`. Service names are validated against the `SERVICES` constant from `@imajin/config`. Upsert via `onConflictDoUpdate` is correct.
- `GET /profile/api/forest/[groupDid]/config/public` is public (no auth), returns only `enabledServices` and `landingService`. The `useIdentities` hook fetches this for the active identity and exposes `activeConfig`.
- `/auth/groups/[groupDid]/settings/page.tsx` combines group details (from `/api/groups/{did}`) and forest config (from profile service) in a single page. Kernel services are shown as non-interactive; selectable services are toggled. Landing page dropdown is populated from enabled services only.

### Stub Management
- `POST /profile/api/stubs` creates a community-maintained place stub: generates keypair, inserts `business`-scope identity, creates profile with `claimStatus: 'unclaimed'`, adds creator as `maintainer` (not `owner`, intentionally preventing act-as). Rate-limited to 10 stubs per actor. Server-side geocode fallback present.
- `/auth/stubs/new/page.tsx` creates stubs. `/auth/stubs/[did]/page.tsx` is a full edit page supporting name, category, location, bio, handle, avatar/banner upload, and a 6-image gallery (uses `/media/api/assets` for upload, `/profile/api/stubs/[did]/images` for registration).
- `/auth/stubs/[did]/page.tsx` loads from `/profile/api/stubs/mine` (filters to creator-owned stubs) before allowing edit — correct access control pattern.

### Member Management (Settings Page)
- `/auth/groups/[groupDid]/settings/page.tsx` contains inline member management: add member (POST `/api/groups/{did}/controllers`), remove member (DELETE), role selector (`admin`, `maintainer`, `member`). Owner cannot be removed via UI.
- `identityMembers.role` hierarchy in `verifyController` uses correct ordered comparison: `['member', 'admin', 'owner']`.

### Auth Package
- `@imajin/auth` exports are clean: `requireAuth`, `getSession`, `optionalAuth`, `requireAdmin`, `requireHardDID`, `requireEstablishedDID`, `emitAttestation`, crypto utilities.
- `permissions.ts` provides tier-based `canDo()` and `hasTier()` — correctly handles `soft`, `preliminary`, `established` tiers and the optional `established+graph` check.

---

## 3. Broken / Incomplete Flows

### 3.1 Missing Components Referenced in Audit Checklist
- **`IdentitySettingsPanel.tsx`** — does not exist. The settings UI is inline in `/auth/groups/[groupDid]/settings/page.tsx`. Not a bug, just a naming discrepancy between the checklist and what shipped.
- **`IdentityMembersPanel.tsx`** — does not exist. Member management is also inline in the settings page.
- **`IdentityTabBar.tsx`** — does not exist anywhere in the codebase. The auth hub (`/auth/page.tsx`) has no tab bar; the settings page is a separate route at `/auth/groups/[groupDid]/settings/`.
- **`/auth/settings/page.tsx`** — the directory exists (`settings/security/page.tsx`) but a top-level `/auth/settings/page.tsx` does not. The settings redirect listed in the audit is actually at `/auth/groups/[groupDid]/settings`.
- **`/auth/members/page.tsx`** — does not exist. There is no standalone members page. Members are managed inline in the settings page. This is fine as a design choice but is a navigation gap if you expected a `/auth/members` route.
- **`/auth/layout.tsx`** — does not exist. Each auth sub-page renders standalone without a shared layout wrapper.
- **`MEMORY.md`** at the repo root — does not exist. Scope, forest, and group context is in `docs/rfcs/RFC-19-kernel-userspace-architecture.md`.

### 3.2 `GET /api/groups` Only Returns `owner`/`admin` — Excludes `maintainer` Members from Switcher
- `/auth/api/groups/route.ts` (GET handler, line 204): the query filters `inArray(identityMembers.role, ['owner', 'admin'])`.
- `IdentitySwitcher` calls `/api/groups` to populate the list of switchable identities.
- **Result:** users with `maintainer` role on a stub cannot switch into it in the switcher. This is intentional for stubs (maintainers cannot `act-as` a stub, per `POST /auth/api/session/act-as` which requires `owner`/`admin`), but the UI never shows them stubs they maintain. `PlacesMaintained.tsx` fills this gap for stubs, but the two models are inconsistent.

### 3.3 Delegated App Sessions (RFC-19 Section: The Handshake) — Not Implemented
- RFC-19 specifies an OAuth-like consent flow at `/auth/authorize`, delegated session tokens scoped per app, per-scope consent UI, a linked apps manager, and handshake attestations.
- **None of this exists.** There is no `/auth/authorize` route, no app manifest store, no `require-app-auth.ts`, no delegated session minting, no consent screen, no revocation flow, no linked apps manager.
- The `@imajin/auth` package has no `require-app-auth` export. The `/registry` routes cover node registration and build attestations, but there is no `registry/api/apps` route.
- This is Phase 2/3 of RFC-19 (Userspace Extraction / Compliance Suite) — not started.

### 3.4 `useIdentities` Hook: `activeIdentity` Race Condition
- `useIdentities` initializes `activeIdentity` from `localStorage` in a `useEffect`, meaning the initial render has `activeIdentity === null` even if the user is acting-as a group. Components that read `activeIdentity` on mount may see the wrong state for one render cycle.
- `IdentitySwitcher` uses `!activeIdentity` to determine if the "Personal" button is active — this flickers to "personal" on load before the effect fires.

### 3.5 Forest Config: `scopeFeeBps` Not Surfaced in UI
- `forestConfig` schema has `scopeFeeBps` (default 25 bps = 0.25%). This field is stored but never read or written by the settings page or the public config endpoint. Its semantics are unclear — is this an override on the 1% settlement fee described in RFC-19? There is no documentation for it.

### 3.6 `events` and `market` Apps Missing from Kernel
- `/apps/kernel/app/events/` and `/apps/kernel/app/market/` do not exist. Per RFC-19, these are "userspace apps" that should be extracted — but they appear to not be present in the kernel either. If they exist as standalone apps, there is no forest config integration showing them as selectable services yet.
- The forest config settings page uses `SELECTABLE_SERVICES` from `@imajin/config` — the content of that constant was not audited here, but if events/market are not in it, they won't appear as toggleable.

### 3.7 `require-app-auth.ts` Missing from `@imajin/auth`
- The audit checklist references this file at `packages/auth/src/require-app-auth.ts`. It does not exist. The `index.ts` exports do not include it. This is needed for the delegated app session flow.

### 3.8 Settings Page Loads Forest Config from `profileUrl` Using Cross-Origin Fetch
- `/auth/groups/[groupDid]/settings/page.tsx` is a client component that fetches forest config from `buildPublicUrl('profile')` — a potentially different origin than the auth service. This works in production but requires the profile service to have CORS set correctly for the auth service origin. No CORS error handling is present beyond a silent `catch`.

### 3.9 `maintainer` Role Inconsistency Across the Stack
- The `ADD_ROLES` constant in the settings page is `['admin', 'maintainer', 'member']` — `maintainer` is assignable.
- `identityMembers` stores `maintainer` role.
- `act-as` rejects `maintainer` (only `owner`/`admin` can switch).
- `verifyController` in the forest config route supports a hierarchy of `['member', 'admin', 'owner']` — `maintainer` is not in this list at all, so a `maintainer` attempting to read the forest config will get a 403 ("Not a controller of this group").
- **The `maintainer` role is half-defined:** it exists in the DB and the add form, but it has no functional privileges through either the act-as or forest config paths.

---

## 4. Questions for Ryan

1. **`maintainer` role semantics**: Is `maintainer` intended to be a tier between `member` and `admin`? Currently it has no functional privileges (can't act-as, can't read forest config, not returned by `GET /api/groups`). Should it be included in the `verifyController` hierarchy? Or is it stub-specific and should be renamed `stub_maintainer`?

2. **`scopeFeeBps` in `forestConfig`**: What is this field for? Is it a per-forest override of the 1% settlement fee split (RFC-19)? Or a different fee mechanism? Should the settings UI expose it?

3. **Forest config for personal identities**: The `forestConfig` table is keyed by `groupDid`. Can a personal actor DID have a forest config? If so, what's the creation path? The settings UI only lives under `/auth/groups/[groupDid]/settings`.

4. **`IdentityTabBar` / `/auth/settings`**: Were these originally planned UI components that didn't ship yet? Should there be a standalone `/auth/settings` page (for personal identity settings: handle, avatar, bio) separate from the group settings page?

5. **events / market presence in kernel**: Are events and market running as separate apps today (outside this monorepo), or are they still in-kernel but in a different apps/* directory? The SELECTABLE_SERVICES list in `@imajin/config` needs to match whatever is actually deployed.

6. **Delegated app sessions timeline**: Is the `/auth/authorize` consent flow + handshake + `require-app-auth` work planned for the next sprint, or is it Phase 3 (later)? Knowing this affects whether the registry should stub out app manifest routes now.

7. **`useIdentities` `activeIdentity` race**: Should `acting-as.ts` / `useIdentities` be refactored to initialize state synchronously (e.g., lazy initial state from localStorage) to avoid the flicker? Or is a hydration-safe pattern preferred?

---

## 5. Punch List (Smallest to Biggest)

### Small (< 1 hour each)

1. **Fix `maintainer` in `verifyController` hierarchy** (`/apps/kernel/app/profile/api/forest/[groupDid]/config/route.ts`): Either add `'maintainer'` to the `roleHierarchy` array between `member` and `admin`, or clarify in a comment that `maintainer` is intentionally excluded from forest config access. Effort: 10 min.

2. **Fix `useIdentities` flicker** (`/packages/ui/src/use-identities.ts`): Change `useState<string | null>(null)` to `useState<string | null>(() => getActingAs())` (lazy initializer) so `activeIdentity` is correct on the first render. Effort: 10 min.

3. **Document `scopeFeeBps`** (add a comment to `profile.ts` schema or a `TODO`): Clarify its intended use so it doesn't silently accumulate confusion. Effort: 15 min.

4. **Add `maintainer` to `GET /api/groups` filter OR keep consistent** (`/apps/kernel/app/auth/api/groups/route.ts`): If `maintainer` can't act-as, keep it excluded here and add a comment. If `maintainer` should be switchable, add it to both the GET filter and the act-as allowed roles. Effort: 15 min.

### Medium (1–4 hours each)

5. **Add `/auth/settings/page.tsx` for personal identity settings**: There's currently no UI to edit your own profile (handle, bio, avatar) from the auth hub. The stub edit page has all the patterns needed. Effort: 2–3 hours.

6. **Resolve `maintainer` role design**: Decide if `maintainer` = stub curator (no act-as) or a real group admin tier. Update `verifyController`, `act-as` route, `GET /api/groups`, and `ADD_ROLES` to be consistent. Write a brief comment or docstring in `identityMembers` schema. Effort: 2–3 hours.

7. **Add SELECTABLE_SERVICES audit**: Read `@imajin/config`'s `SERVICES` list, confirm that every service toggled in the forest config settings page actually exists as a routable app. If events/market are missing, add stubs or mark them as `coming_soon`. Effort: 2–3 hours.

8. **Fix forest config CORS / error handling**: In `settings/page.tsx`, add explicit error messaging if the profile service CORS call fails (currently silent). Alternatively, move the forest config fetch to a server-side API route on the kernel so it's same-origin. Effort: 1–2 hours.

### Large (half-day to multi-day)

9. **Implement `/auth/authorize` consent screen + delegated session minting** (RFC-19 Phase 2): Create the OAuth-like flow — consent page at `/auth/authorize?app_did=...&scopes=...`, token minting endpoint, session invalidation on revoke, and `require-app-auth.ts` in `@imajin/auth`. This is the foundation for any third-party app integration. Effort: 2–3 days.

10. **Add app manifest registry routes**: `GET/POST /registry/api/apps` (list, register app DID), `GET /registry/api/apps/[appDid]` (manifest), handshake endpoint. Required before the consent screen is useful. Effort: 1–2 days.

11. **Build linked apps manager page** (`/auth/apps`): List all apps the user has linked, per-app scope grants, revoke button, audit trail of last API call per scope. Effort: 1 day UI + requires #9 and #10.

---

*Files examined in this audit:*
- `/home/veteze/dev/imajin-ai/docs/rfcs/RFC-19-kernel-userspace-architecture.md`
- `/home/veteze/dev/imajin-ai/apps/kernel/app/auth/groups/new/page.tsx`
- `/home/veteze/dev/imajin-ai/apps/kernel/app/auth/groups/[groupDid]/settings/page.tsx`
- `/home/veteze/dev/imajin-ai/apps/kernel/app/auth/groups/page.tsx`
- `/home/veteze/dev/imajin-ai/apps/kernel/app/auth/components/IdentitySwitcher.tsx`
- `/home/veteze/dev/imajin-ai/apps/kernel/app/auth/components/IdentityDetail.tsx`
- `/home/veteze/dev/imajin-ai/apps/kernel/app/auth/page.tsx`
- `/home/veteze/dev/imajin-ai/apps/kernel/app/auth/stubs/new/page.tsx`
- `/home/veteze/dev/imajin-ai/apps/kernel/app/auth/stubs/[did]/page.tsx`
- `/home/veteze/dev/imajin-ai/apps/kernel/src/db/schemas/profile.ts`
- `/home/veteze/dev/imajin-ai/apps/kernel/app/profile/api/forest/[groupDid]/config/route.ts`
- `/home/veteze/dev/imajin-ai/apps/kernel/app/profile/api/forest/[groupDid]/config/public/route.ts`
- `/home/veteze/dev/imajin-ai/apps/kernel/app/profile/api/stubs/route.ts`
- `/home/veteze/dev/imajin-ai/apps/kernel/app/pay/page.tsx`
- `/home/veteze/dev/imajin-ai/apps/kernel/app/auth/api/session/act-as/route.ts`
- `/home/veteze/dev/imajin-ai/apps/kernel/app/auth/api/groups/route.ts`
- `/home/veteze/dev/imajin-ai/packages/auth/src/require-auth.ts`
- `/home/veteze/dev/imajin-ai/packages/auth/src/session.ts`
- `/home/veteze/dev/imajin-ai/packages/auth/src/permissions.ts`
- `/home/veteze/dev/imajin-ai/packages/auth/src/index.ts`
- `/home/veteze/dev/imajin-ai/packages/ui/src/use-identities.ts`
- `/home/veteze/dev/imajin-ai/packages/ui/src/acting-as.ts`
