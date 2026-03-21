# Work Order: #398 — DFOS Chain Resolution Endpoints

**Epic:** #395 (DFOS DID Bridge)  
**Issue:** #398  
**Scope:** Three new API routes in `apps/auth`. Read-only, no auth required.  
**Branch:** `feat/398-resolution-endpoints`  
**Depends on:** PR #407 must be merged to main first (contains `identity_chains` table + `@imajin/dfos` package)

---

## What You're Building

Three public endpoints that let anyone resolve and verify DFOS identity chains:

1. `GET /api/identity/:did/chain` — serve the DFOS chain log for a DID
2. `GET /api/resolve/dfos/:dfosDid` — resolve a `did:dfos` to its `did:imajin`
3. Extend existing `GET /api/identity/:did` — add `dfosDid` field when chain exists

Plus shared lookup functions in `apps/auth/lib/dfos.ts`.

---

## Step 0: Setup

```bash
cd ~/workspace/imajin-ai
git checkout main && git pull
git checkout -b feat/398-resolution-endpoints
```

## Files to Read First

1. `apps/auth/app/api/identity/[did]/route.ts` — existing identity endpoint (you're extending this)
2. `apps/auth/lib/dfos.ts` — existing DFOS helpers (`verifyClientChain`, `storeDfosChain`)
3. `apps/auth/src/db.ts` — database setup, table exports (check for `identityChains`)
4. `apps/auth/drizzle/0003_brave_avengers.sql` — the `identity_chains` table schema
5. `packages/dfos/src/bridge.ts` — `verifyChain` function
6. `@imajin/config` — `corsHeaders` helper (used by all auth endpoints)

---

## Step 1: Add Lookup Functions to `apps/auth/lib/dfos.ts`

Extend the existing file. Add these below the existing functions:

```typescript
/**
 * Look up a DFOS chain by Imajin DID.
 * Returns the full chain record or null.
 */
export async function getChainByImajinDid(imajinDid: string) {
  const [chain] = await db
    .select()
    .from(identityChains)
    .where(eq(identityChains.did, imajinDid))
    .limit(1);
  return chain ?? null;
}

/**
 * Look up an Imajin identity by its DFOS DID.
 * Returns { imajinDid, dfosDid, handle, name, type, tier } or null.
 */
export async function getIdentityByDfosDid(dfosDid: string) {
  const [chain] = await db
    .select()
    .from(identityChains)
    .where(eq(identityChains.dfosDid, dfosDid))
    .limit(1);

  if (!chain) return null;

  const [identity] = await db
    .select({
      id: identities.id,
      type: identities.type,
      tier: identities.tier,
    })
    .from(identities)
    .where(eq(identities.id, chain.did))
    .limit(1);

  if (!identity) return null;

  // Try to get profile handle + name (cross-service)
  // Profile is a separate service — use the profile API or return null for handle/name
  // For now: return what auth knows directly
  return {
    imajinDid: identity.id,
    dfosDid: chain.dfosDid,
    type: identity.type,
    tier: identity.tier,
  };
}
```

**⚠️ Import check:** Make sure `identities` and `identityChains` are both exported from `@/src/db`. The `identityChains` table was added in PR #407's migration. Check the Drizzle schema file to confirm the export name — it might be `identity_chains` (snake_case) in the schema but `identityChains` (camelCase) in the Drizzle export.

**⚠️ Profile data:** The issue spec shows `handle` and `name` in the response. Profile is a separate service. Two options:
- Option A: Make an HTTP call to profile service (adds latency + dependency)
- Option B: Return only what auth knows (did, type, tier) — simpler, no cross-service coupling

**Go with Option B.** The endpoint is about identity resolution, not profile display. Consumers can call profile separately if they need handle/name.

---

## Step 2: Chain Endpoint — `GET /api/identity/:did/chain`

**Create:** `apps/auth/app/api/identity/[did]/chain/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { getChainByImajinDid } from '@/lib/dfos';
import { verifyChain } from '@imajin/dfos';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/identity/:did/chain
 * Public endpoint — serve the DFOS identity chain for a DID.
 * The log is a portable, self-verifying artifact.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  try {
    const { did } = await params;
    const decodedDid = decodeURIComponent(did);

    const chain = await getChainByImajinDid(decodedDid);
    if (!chain) {
      return NextResponse.json(
        { error: 'No DFOS chain found for this identity' },
        { status: 404, headers: cors }
      );
    }

    // Verify chain integrity before serving
    const verified = await verifyChain(chain.log as string[]);

    return NextResponse.json({
      did: decodedDid,
      dfosDid: chain.dfosDid,
      log: chain.log,
      headCid: chain.headCid,
      keyCount: chain.keyCount,
      isDeleted: verified.isDeleted,
    }, { headers: cors });
  } catch (err) {
    console.error('[chain] Error serving chain:', err);
    return NextResponse.json(
      { error: 'Internal error' },
      { status: 500, headers: cors }
    );
  }
}
```

---

## Step 3: DFOS Resolution Endpoint — `GET /api/resolve/dfos/:dfosDid`

**Create directory + route:** `apps/auth/app/api/resolve/dfos/[dfosDid]/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { getIdentityByDfosDid } from '@/lib/dfos';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/resolve/dfos/:dfosDid
 * Public endpoint — resolve a did:dfos to its linked did:imajin identity.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ dfosDid: string }> }
) {
  const cors = corsHeaders(request);
  try {
    const { dfosDid } = await params;
    const decodedDid = decodeURIComponent(dfosDid);

    const identity = await getIdentityByDfosDid(decodedDid);
    if (!identity) {
      return NextResponse.json(
        { error: 'No Imajin identity linked to this DFOS DID' },
        { status: 404, headers: cors }
      );
    }

    return NextResponse.json(identity, { headers: cors });
  } catch (err) {
    console.error('[resolve] Error resolving DFOS DID:', err);
    return NextResponse.json(
      { error: 'Internal error' },
      { status: 500, headers: cors }
    );
  }
}
```

---

## Step 4: Extend Existing Identity Endpoint

**Edit:** `apps/auth/app/api/identity/[did]/route.ts`

Add `dfosDid` to the response when a chain exists. Import `getChainByImajinDid` and add a lookup after the identity query:

```typescript
// After the identity lookup succeeds:
import { getChainByImajinDid } from '@/lib/dfos';

// ... inside the GET handler, after finding the identity:
const chain = await getChainByImajinDid(decodedDid);

return NextResponse.json({
  did: identity.id,
  publicKey: identity.publicKey,
  type: identity.type,
  tier: identity.tier,
  ...(chain ? { dfosDid: chain.dfosDid } : {}),
}, { headers: cors });
```

**⚠️ Read the full existing route first.** Match the exact response shape and error handling pattern. Don't restructure what's there — just add the `dfosDid` field.

---

## Step 5: Add to API Spec

Check if there's an API spec file at `apps/auth/app/api/spec/route.ts` or similar. If it exists, add the new endpoints to it. Match the existing format.

---

## Step 6: Test

```bash
# Build auth to check for type errors
cd apps/auth && npx next build

# If the dev server is running, test manually:
# curl https://dev-auth.imajin.ai/api/identity/did:imajin:xxx/chain
# curl https://dev-auth.imajin.ai/api/resolve/dfos/did:dfos:yyy
# curl https://dev-auth.imajin.ai/api/identity/did:imajin:xxx
```

---

## Step 7: Commit + PR

```bash
git add -A
git commit -m "feat(auth): DFOS chain resolution endpoints (#398)

- GET /api/identity/:did/chain — serve chain log
- GET /api/resolve/dfos/:dfosDid — resolve DFOS→Imajin
- Extend GET /api/identity/:did with dfosDid field
- Shared lookup functions in lib/dfos.ts

Closes #398"
git push origin feat/398-resolution-endpoints
gh pr create --title "feat(auth): DFOS chain resolution endpoints (#398)" \
  --body "Closes #398. Three public read-only endpoints for DFOS chain resolution.

## New endpoints
- \`GET /api/identity/:did/chain\` — portable chain log
- \`GET /api/resolve/dfos/:dfosDid\` — DFOS→Imajin lookup
- \`GET /api/identity/:did\` — now includes \`dfosDid\` when available

All public, no auth required. Self-verifying chains — consumers verify with \`@metalabel/dfos-protocol\` directly."
```

---

## What NOT To Do

- **Don't add authentication** to these endpoints. They're public by design — self-certifying identity is discoverable.
- **Don't call profile service** for handle/name. Return auth-owned data only.
- **Don't modify the identity_chains schema.** Read-only consumption.
- **Don't add rate limiting yet** — it's a future concern. These are read endpoints with no side effects.
- **Don't touch registration or login flows** — those are already wired in PR #407.

## Success Criteria

```
✓ GET /api/identity/:did/chain — returns chain log for bridged identities, 404 for unbridged
✓ GET /api/resolve/dfos/:dfosDid — resolves to Imajin identity, 404 for unknown
✓ GET /api/identity/:did — includes dfosDid when chain exists, unchanged when not
✓ All endpoints return proper CORS headers
✓ No auth required on any endpoint
✓ Build passes (npx next build)
✓ PR created against main
```
