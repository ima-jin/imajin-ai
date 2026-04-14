# Work Order: SWR Migration (#688)

**Goal:** Replace ad-hoc `useEffect` + `fetch` + manual caching patterns with SWR for consistent client-side data fetching, caching, and request deduplication.

**Branch:** `refactor/688-swr-migration` from `main`
**Depends on:** PRs #694, #696, #699, #700 merged (touches overlapping files)

---

## Setup

### 1. Add SWR dependency

```bash
pnpm --filter kernel add swr
pnpm --filter @imajin/chat add swr
```

~4KB gzipped. No backend requirements. MIT licensed.

### 2. Create shared fetcher

Create `apps/kernel/src/lib/swr/fetcher.ts`:

```ts
export async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const error = new Error('Fetch failed');
    (error as any).status = res.status;
    throw error;
  }
  return res.json();
}
```

### 3. Add SWRConfig provider

In `apps/kernel/app/layout.tsx` (or the appropriate client layout), wrap with:

```tsx
import { SWRConfig } from 'swr';
import { fetcher } from '@/src/lib/swr/fetcher';

<SWRConfig value={{
  fetcher,
  revalidateOnFocus: true,
  dedupingInterval: 5000,
  errorRetryCount: 2,
}}>
  {children}
</SWRConfig>
```

---

## Migration Targets (in order)

### Target 1: NewChatModal connections

**File:** `apps/kernel/app/chat/components/NewChatModal.tsx`
**Current:** Module-level `_connectionsCache`, `useEffect` + `fetch`, manual dedup
**After:**

```tsx
const { data, isLoading, error } = useSWR(
  identity?.did ? `${CONNECTIONS_URL}/api/connections` : null
);
const connections = data?.connections ?? [];
```

- Remove `_connectionsCache` variable entirely
- Remove the `useEffect` that loads connections
- Remove `setConnections` / `setLoading` / `setError` state
- SWR handles caching, dedup, and revalidation automatically
- The connection list survives modal open/close cycles (SWR cache persists)

### Target 2: useDidNames

**File:** `packages/chat/src/hooks/useDidNames.ts`
**Current:** `cacheRef` + `nicknameCacheRef` + `pendingRef` + manual batching
**After:**

This one is trickier because it batches multiple DID lookups into single requests. Two approaches:

**Option A (simple):** One SWR call per unique DID set:
```tsx
const didsKey = [...new Set(dids)].sort().join(',');
const { data } = useSWR(
  didsKey ? `/auth/api/lookup/batch?dids=${didsKey}` : null
);
```
This requires a batch lookup endpoint (may not exist yet — check first).

**Option B (keep batching, use SWR for individual lookups):**
```tsx
// Use useSWR for each DID with dedup
function useDidName(did: string) {
  const { data } = useSWR(`/auth/api/lookup/${did}`, fetcher);
  return data?.handle || data?.name || null;
}
```
SWR dedup means 10 components requesting the same DID = 1 fetch.

**Recommendation:** Option B is simpler and SWR dedup handles the N+1 naturally. The existing batch logic was solving a problem SWR solves for free.

But: check if the current code calls a batch endpoint or individual lookups. Match the existing API surface.

### Target 3: useIdentities

**File:** `packages/ui/src/hooks/` (find the identities hook)
**Current:** `useEffect` + `fetch` for group identity list
**After:**

```tsx
const { data, isLoading } = useSWR(
  did ? `${AUTH_URL}/api/identities?did=${did}` : null
);
```

### Target 4: Connection list page

**File:** `apps/kernel/app/connections/page.tsx`
**Current:** `useEffect` + `fetch` + local state
**After:** Same SWR pattern. Key: `connections:${effectiveDid}`

### Target 5: Invitation list

**File:** Find the invitations tab component
**Current:** `useEffect` + `fetch`
**After:** SWR with appropriate key

### Target 6: Profile lookups in chat

**File:** Various chat components that resolve DID → profile
**Current:** Individual fetch calls
**After:** SWR with DID-based keys — automatic dedup across components

---

## Validation

After each target migration:

1. Verify the component renders correctly
2. Open/close the component — data should persist (no flash of loading state)
3. Switch tabs and return — should show stale data immediately, revalidate in background
4. Open the same data in two sibling components — network tab should show only 1 request

After all migrations:

```bash
# No custom caches should remain
grep -rn "_connectionsCache\|cacheRef\|nicknameCacheRef" --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v .next
# Should return nothing

# Build should pass
pnpm --filter kernel build
pnpm --filter @imajin/chat build
```

---

## Rules

- **No backend changes.** This is purely client-side.
- **No new API endpoints** unless the existing batch lookup pattern requires it.
- **Migrate one target at a time.** Commit after each working migration.
- **Remove ALL custom caching code** for migrated components. No dual implementations.
- **Don't change API response shapes** — SWR wraps the existing fetches.
- **Keep error handling** — SWR's `error` state replaces manual error state, but the user-facing behavior should be identical.
- **Test modal/navigation cycles** — the main benefit is cache persistence across view changes.

---

## Not In Scope

- Server-side caching (Cache-Control headers)
- Optimistic mutations (nice-to-have, add later)
- Offline support
- Migration of the `@imajin/chat` package's `useChatMessages` hook (that's a WebSocket-driven flow, not a fetch pattern)
