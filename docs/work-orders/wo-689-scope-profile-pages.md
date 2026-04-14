# Work Order: Scope-Specific Profile Pages (#689)

**Goal:** Split the monolithic `[handle]/page.tsx` (481 lines) into a thin resolver + scope-specific profile components, with shared helpers that all scopes use.

**Branch:** `feat/689-scope-profiles` from `main`
**Depends on:** PR #687 (identity scopes) — merged ✅

---

## Architecture

```
/profile/[handle]/page.tsx                    ← thin resolver (data loading + scope switch)
/profile/components/profiles/ActorProfile.tsx  ← current actor view (extracted + cleaned up)
/profile/components/profiles/BusinessProfile.tsx ← new
/profile/components/profiles/CommunityProfile.tsx ← new
/profile/components/profiles/FamilyProfile.tsx    ← new
/profile/lib/profile-data.ts                  ← shared data-fetching helpers
/profile/lib/profile-utils.ts                 ← shared display helpers (scope labels, badges, URL builders)
/profile/components/ScopeHeader.tsx            ← shared header (avatar, name, handle, scope badge, tier badges)
/profile/components/ProfileStats.tsx           ← followers/following/connections row
/profile/components/ContactCard.tsx            ← contact info card (email, phone)
/profile/components/ServiceLinks.tsx           ← links/coffee/dykil action buttons
/profile/components/MemberList.tsx             ← reusable member list (for business maintainers, community members, family)
/profile/components/GatedProfile.tsx           ← the "🔒 only visible to connections" view
```

## Shared Types

Create `/profile/lib/types.ts`:

```typescript
export interface ProfileData {
  did: string;
  handle?: string;
  displayName: string;
  bio?: string;
  avatar?: string;
  email?: string;
  phone?: string;
  contactEmail?: string;
  featureToggles?: FeatureToggles;
  createdAt: string;
  metadata?: Record<string, unknown>;
  claimStatus?: string | null;
}

export interface FeatureToggles {
  inference_enabled?: boolean;
  show_market_items?: boolean;
  show_events?: boolean;
  links?: string | null;
  coffee?: string | null;
  dykil?: string | null;
  learn?: string | null;
}

export interface IdentityInfo {
  scope: 'actor' | 'business' | 'community' | 'family';
  subtype: string | null;
  tier: string;
  chainVerified: boolean;
}

export interface ViewerContext {
  viewerDid: string | null;
  isSelf: boolean;
  isConnected: boolean;
  isFollowing: boolean;
}

export interface ProfileViewProps {
  profile: ProfileData;
  identity: IdentityInfo;
  viewer: ViewerContext;
  counts: ProfileCounts;
  links: LinkItem[];
}

export interface ProfileCounts {
  followers: number;
  following: number;
  connections: number;
}

export interface LinkItem {
  title: string;
  url: string;
  description?: string;
}
```

## Shared Data Helpers

Create `/profile/lib/profile-data.ts` — extract from current page.tsx:

```typescript
// Move these functions here (they're currently inline in page.tsx):
export async function getViewerDid(): Promise<string | null>
export async function getProfile(handle: string): Promise<ProfileData | null>
export async function getProfileCounts(profileDid: string): Promise<ProfileCounts>
export async function getFollowStatus(viewerDid: string, targetDid: string): Promise<boolean>
export async function isConnected(viewerDid: string, targetDid: string): Promise<boolean>
export async function getLinks(linksHandle: string): Promise<LinkItem[]>
export async function getIdentityInfo(did: string): Promise<IdentityInfo>
export async function getMaintainerInfo(identityDid: string, viewerDid: string | null): Promise<{ count: number; isMaintainer: boolean }>
export async function getMembersByRole(identityDid: string): Promise<Record<string, Member[]>>
```

## Shared Display Helpers

Create `/profile/lib/profile-utils.ts`:

```typescript
export function getScopeEmoji(scope: string, subtype: string | null): string
export function getScopeLabel(scope: string, subtype: string | null): string
export function buildServiceUrl(service: string): string  // consolidates the servicePrefix+domain pattern
export function formatMemberSince(createdAt: string): string
```

---

## WO1: Extract shared helpers + ActorProfile (migration, no behavior change)

**Estimated effort:** 1.5-2 hours (agent)
**Risk:** Low — pure refactor, no new features

### Steps

1. **Create `/profile/lib/types.ts`** with all shared types listed above.

2. **Create `/profile/lib/profile-data.ts`** — move all data-fetching functions out of page.tsx. Every function must work exactly as it does today. No behavior changes.

3. **Create `/profile/lib/profile-utils.ts`** — move `getScopeEmoji`, `getScopeLabel` out of page.tsx. Add `buildServiceUrl(service)` that consolidates the `process.env.NEXT_PUBLIC_${SERVICE}_URL || ...` pattern used in multiple places. Add `formatMemberSince(createdAt)`.

4. **Create shared components:**

   - **`ScopeHeader.tsx`** — avatar, display name, handle, scope badge, tier badges (soft DID, chain verified, community-maintained). Extracted from the current page's header section. All profile views will use this.
   - **`ProfileStats.tsx`** — the followers/following/connections row + FollowButton. Props: `counts`, `viewerDid`, `isSelf`, `targetDid`, `isFollowing`.
   - **`ContactCard.tsx`** — the contact info card (email + phone). Only renders if data exists.
   - **`ServiceLinks.tsx`** — the action buttons row (Ask, Links, Coffee). Props: profile + viewer context.
   - **`GatedProfile.tsx`** — the "🔒 only visible to connections" view. Currently inline in page.tsx, extract to standalone component.

5. **Create `/profile/components/profiles/ActorProfile.tsx`** — receives `ProfileViewProps`. Composes: `ScopeHeader` → `ProfileStats` → bio → soft DID notice → `ContactCard` → `ServiceLinks` → expanded links → `UpcomingEvents` → `MarketItems` → member since → DID. Same rendering as today, but using shared components.

6. **Rewrite `[handle]/page.tsx`** as thin resolver:
   ```typescript
   // Data loading (parallel where possible)
   const profile = await getProfile(handle);
   if (!profile) notFound();
   const viewerDid = await getViewerDid();
   // ... viewer context, identity info, counts, links
   
   // Gate check
   if (!viewer.isSelf && !viewer.isConnected) return <GatedProfile profile={profile} viewerDid={viewerDid} />;
   
   // Scope switch
   switch (identity.scope) {
     case 'actor': return <ActorProfile {...props} />;
     case 'business': return <ActorProfile {...props} />;  // temporary fallback
     case 'community': return <ActorProfile {...props} />;  // temporary fallback
     case 'family': return <ActorProfile {...props} />;  // temporary fallback
   }
   ```

7. **Keep `generateMetadata` in page.tsx** — it needs to stay in the page file for Next.js. It should import from `profile-data.ts` and `profile-utils.ts` instead of having its own copies.

### Validation
- Every profile that rendered before must render identically after.
- No new API calls, no new DB queries, no new packages.
- The stub maintainer info box should still render for unclaimed businesses (it's in the current page and goes into ActorProfile as temporary fallback).

### Drizzle migrations
None — no schema changes.

### Files changed
- **New:** `lib/types.ts`, `lib/profile-data.ts`, `lib/profile-utils.ts`
- **New:** `components/ScopeHeader.tsx`, `components/ProfileStats.tsx`, `components/ContactCard.tsx`, `components/ServiceLinks.tsx`, `components/GatedProfile.tsx`
- **New:** `components/profiles/ActorProfile.tsx`
- **Modified:** `[handle]/page.tsx` (gutted → thin resolver)

---

## WO2: BusinessProfile

**Estimated effort:** 2-3 hours (agent)
**Depends on:** WO1

### What's new vs ActorProfile

BusinessProfile has three viewing modes:
1. **Public (unclaimed):** community-maintained badge, maintainer list, "suggest an edit", "claim this business"
2. **Public (claimed):** owner badge, business-managed fields, standard contact
3. **Maintainer view:** direct edit access to scoped fields

### Layout

```
┌─────────────────────────────────┐
│ ScopeHeader                     │  ← shared component (avatar, name, handle, badges)
│ ────────────────────────────── │
│ About                           │  ← bio / description
│ ────────────────────────────── │
│ Details                         │  ← BusinessDetails component (new)
│ 📍 Location    123 Main St     │     reads from profile.metadata
│ 📞 Phone       555-1234       │
│ 🌐 Website     example.com    │
│ ────────────────────────────── │
│ MemberList (maintainers)        │  ← shared component, role='maintainer'
│ ────────────────────────────── │
│ [Suggest an edit]  [Claim this] │  ← StubActions component (new)
│ ────────────────────────────── │
│ Member since · DID              │
└─────────────────────────────────┘
```

### Steps

1. **Create `MemberList.tsx`** — shared component. Takes `identityDid` and optional `roleFilter`. Fetches members from `identity_members`, displays grouped by role. Used by BusinessProfile (maintainers) and later by CommunityProfile (all roles) and FamilyProfile.

   Data source: `identity_members` table joined with profiles for display names + avatars. Expose a server-side helper in `profile-data.ts`:
   ```typescript
   export async function getMembersByRole(identityDid: string): Promise<{ role: string; did: string; displayName: string; handle?: string; avatar?: string }[]>
   ```

2. **Create `BusinessDetails.tsx`** — renders structured metadata from `profile.metadata` JSONB. Fields: location, phone, website, category. Only renders fields that exist. Clean key-value layout.

3. **Create `StubActions.tsx`** — the unclaimed business CTA section. "Help maintain this place" join button (existing form action), "Claim this business" link (to `/profile/api/claim`), "Suggest an edit" (future — can be disabled button for now). Renders conditionally based on claim status + viewer role.

4. **Create `/profile/components/profiles/BusinessProfile.tsx`** — composes: `ScopeHeader` → about → `BusinessDetails` → `MemberList` (filtered to maintainers for unclaimed, owners/admins for claimed) → `StubActions` (if unclaimed) → `ServiceLinks` → member since → DID.

5. **Update resolver in `[handle]/page.tsx`:**
   ```typescript
   case 'business': return <BusinessProfile {...props} />;
   ```

6. **Move the stub-related data fetching** currently in page.tsx (`maintainerCount`, `isMaintainer` queries) into `profile-data.ts` as `getMaintainerInfo()`. BusinessProfile calls this; ActorProfile no longer needs it (the fallback code for business scope goes away).

### Validation
- Unclaimed business profiles show maintainer list, community-maintained badge, join button
- Claimed business profiles show owner info, business details
- Self-view as maintainer shows "You are a maintainer" status
- ActorProfile no longer has any business-specific conditionals

---

## WO3: CommunityProfile

**Estimated effort:** 1.5-2 hours (agent)
**Depends on:** WO1 + WO2 (needs MemberList)

### Layout

```
┌─────────────────────────────────┐
│ ScopeHeader                     │
│ ────────────────────────────── │
│ Purpose / About                 │  ← bio
│ ────────────────────────────── │
│ Members (47)                    │  ← MemberList (all roles, grouped)
│ 👑 Owners (2)                  │
│ 🛡️ Admins (5)                  │
│ 👥 Members (40)                │
│ ────────────────────────────── │
│ Enabled Services                │  ← ForestServices component (new)
│ 📅 Events  💬 Chat  📰 Learn  │     reads from forest_config
│ ────────────────────────────── │
│ [Join]                          │  ← JoinButton (new)
│ ────────────────────────────── │
│ Member since · DID              │
└─────────────────────────────────┘
```

### Steps

1. **Create `ForestServices.tsx`** — reads enabled services from `profile.forest_config`. Renders as a grid of service badges/links. Each links to `buildServiceUrl(service) + '/' + handle` (or however the forest routing works).

   Data source: add to `profile-data.ts`:
   ```typescript
   export async function getForestConfig(groupDid: string): Promise<{ enabledServices: string[]; landingService?: string } | null>
   ```
   Uses existing `profile.forest_config` table.

2. **Create `JoinButton.tsx`** — client component. Sends POST to join as `role: 'member'`. Shows current membership status if already a member. Disabled if not logged in.

3. **Create `/profile/components/profiles/CommunityProfile.tsx`** — composes: `ScopeHeader` → about/purpose → `MemberList` (grouped by role) → `ForestServices` → `JoinButton` → member since → DID.

4. **Update resolver:**
   ```typescript
   case 'community': return <CommunityProfile {...props} />;
   ```

### Validation
- Community profile shows member count, grouped member list
- Forest services render when config exists
- Join button works for logged-in non-members
- Already-members see their role

---

## WO4: FamilyProfile

**Estimated effort:** 1 hour (agent)
**Depends on:** WO1 + WO2 (needs MemberList)

### Layout

Simplest scope. Mostly private.

**Public view (non-member):**
```
┌─────────────────────────────────┐
│ ScopeHeader                     │
│ ────────────────────────────── │
│ 🔒 Private family group        │
│ Members: 4                      │
│ ────────────────────────────── │
│ Member since · DID              │
└─────────────────────────────────┘
```

**Member view:**
```
┌─────────────────────────────────┐
│ ScopeHeader                     │
│ ────────────────────────────── │
│ About                           │  ← bio (if set)
│ ────────────────────────────── │
│ Members (4)                     │  ← MemberList (flat, no role grouping)
│ ────────────────────────────── │
│ Member since · DID              │
└─────────────────────────────────┘
```

### Steps

1. **Create `/profile/components/profiles/FamilyProfile.tsx`** — composes: `ScopeHeader` → private gate (non-members see count only) → bio → `MemberList` (flat) → member since → DID.

   Membership check: query `identity_members` for viewer's DID. Non-members get the locked view (similar pattern to `GatedProfile` but lighter — shows member count).

2. **Update resolver:**
   ```typescript
   case 'family': return <FamilyProfile {...props} />;
   ```

### Validation
- Non-members see locked view with member count
- Members see full member list + bio
- Owners see member list (admin controls are a future feature)

---

## Execution Order

```
WO1 (extract + refactor) → WO2 (BusinessProfile) → WO3 (CommunityProfile) → WO4 (FamilyProfile)
```

WO1 is the foundation — no scope components build without the shared helpers and types. WO2 comes next because it's the highest-value scope (stubs, Mooi onboarding). WO3 and WO4 can run in parallel after WO2 since they both just need MemberList.

## Notes for agents

- **All paths are relative to `apps/kernel/app/profile/`.**
- **Do NOT create new API routes** — use existing ones. The profile API (`/profile/api/profile/[id]`), stubs API (`/profile/api/stubs/`), follow API, and forest config API already exist.
- **Do NOT add new npm packages.** Everything needed is already in the workspace.
- **`buildPublicUrl` from `@imajin/config`** is the canonical way to build service URLs. Don't invent new URL construction patterns.
- **Design system:** dark theme, `bg-[#0a0a0a]`, `border-gray-800`, amber accent `#F59E0B`. Match existing components exactly.
- **When your task is complete, append a summary of what you built/changed to `memory/2026-04-13.md`.** Create the file if it doesn't exist. Include: what was built, key files changed, decisions made, and current status.
