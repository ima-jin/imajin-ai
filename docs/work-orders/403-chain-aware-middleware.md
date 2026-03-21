# Work Order: #403 — Chain-Aware Auth Middleware

**Epic:** #395 (DFOS DID Bridge)  
**Issue:** #403  
**Scope:** Extend auth middleware with optional chain verification + public verify endpoint.  
**Branch:** `feat/403-chain-middleware`  
**Depends on:** PR #407 merged + #398 (resolution endpoints)

---

## What You're Building

1. Extend `requireAuth` with optional `verifyChain` flag
2. Add `GET /api/identity/:did/verify` — public chain verification endpoint
3. Background consistency check function (chain key vs DB key)

Chain verification is **OFF by default**. Everything existing continues to work unchanged. This is opt-in hardening.

---

## Step 0: Setup

```bash
cd ~/workspace/imajin-ai
git checkout main && git pull
git checkout -b feat/403-chain-middleware
```

## Files to Read First

1. `apps/auth/lib/middleware.ts` — current `requireAuth` + `requireHardDID` (you're extending this)
2. `apps/auth/lib/jwt.ts` — `verifySessionToken`, `SessionPayload` type
3. `apps/auth/lib/dfos.ts` — `verifyClientChain`, `getChainByImajinDid`
4. `apps/auth/src/db.ts` — table exports
5. `packages/dfos/src/bridge.ts` — `verifyChain`
6. `packages/auth/src/crypto.ts` — `hexToMultibase`

---

## Step 1: Extend `requireAuth` in `apps/auth/lib/middleware.ts`

Add an optional `verifyChain` parameter. When true, after the normal session check, also verify the identity's DFOS chain and confirm the DB public key matches the chain's controller key.

```typescript
import { verifyChain } from '@imajin/dfos';
import { hexToMultibase } from '@imajin/auth';
import { db, identityChains, identities } from '@/src/db';
import { eq } from 'drizzle-orm';

interface AuthOptions {
  /** If true, verify identity against DFOS chain (not just DB) */
  verifyChain?: boolean;
}

export async function requireAuth(
  request: NextRequest,
  options?: AuthOptions
): Promise<SessionPayload | null> {
  // Existing logic — unchanged
  const cookieConfig = getSessionCookieOptions();
  const token = request.cookies.get(cookieConfig.name)?.value;
  if (!token) return null;

  const session = await verifySessionToken(token);
  if (!session) return null;

  // NEW: Optional chain verification
  if (options?.verifyChain) {
    const chainValid = await verifyIdentityChain(session.did);
    if (!chainValid) {
      console.error('[auth] Chain verification failed for', session.did);
      return null;
    }
  }

  return session;
}

/**
 * Verify an identity's DFOS chain and check key consistency with DB.
 * Returns true if chain is valid and keys match, or if no chain exists (non-fatal).
 */
async function verifyIdentityChain(did: string): Promise<boolean> {
  try {
    // Load chain
    const [chain] = await db
      .select()
      .from(identityChains)
      .where(eq(identityChains.did, did))
      .limit(1);

    // No chain = not bridged. Non-fatal — verification not applicable.
    if (!chain) return true;

    // Verify chain cryptographically
    const verified = await verifyChain(chain.log as string[]);

    if (verified.isDeleted) {
      console.error('[auth] Identity chain is deleted:', did);
      return false;
    }

    // Check key consistency: chain controller key should match DB public key
    const [identity] = await db
      .select({ publicKey: identities.publicKey })
      .from(identities)
      .where(eq(identities.id, did))
      .limit(1);

    if (!identity) return false;

    const dbMultibase = hexToMultibase(identity.publicKey);
    const chainMultibase = verified.controllerKeys[0]?.publicKeyMultibase;

    if (dbMultibase !== chainMultibase) {
      console.error('[auth] Key mismatch — DB vs chain for', did);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[auth] Chain verification error:', err);
    return false;
  }
}
```

**⚠️ CRITICAL:** The existing `requireAuth` signature changes from `(request)` to `(request, options?)`. This is backward compatible — no existing callers pass options. But **verify by searching all callers**:

```bash
grep -r "requireAuth(" apps/auth/app/ --include="*.ts" | head -20
```

Make sure none of them will break.

**⚠️ Also check:** Other services may import from `apps/auth/lib/middleware.ts` indirectly or have their own copy. Search the whole repo:

```bash
grep -r "requireAuth" apps/ packages/ --include="*.ts" -l
```

---

## Step 2: Verify Endpoint — `GET /api/identity/:did/verify`

**Create:** `apps/auth/app/api/identity/[did]/verify/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { db, identityChains, identities } from '@/src/db';
import { eq } from 'drizzle-orm';
import { verifyChain } from '@imajin/dfos';
import { hexToMultibase } from '@imajin/auth';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/identity/:did/verify
 * Public endpoint — verify a DID's DFOS chain and check DB consistency.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  try {
    const { did } = await params;
    const decodedDid = decodeURIComponent(did);

    // Load identity
    const [identity] = await db
      .select({ id: identities.id, publicKey: identities.publicKey, type: identities.type, tier: identities.tier })
      .from(identities)
      .where(eq(identities.id, decodedDid))
      .limit(1);

    if (!identity) {
      return NextResponse.json({ error: 'Identity not found' }, { status: 404, headers: cors });
    }

    // Load chain
    const [chain] = await db
      .select()
      .from(identityChains)
      .where(eq(identityChains.did, decodedDid))
      .limit(1);

    if (!chain) {
      return NextResponse.json({
        did: decodedDid,
        hasDfosChain: false,
        message: 'Identity exists but has no DFOS chain',
      }, { headers: cors });
    }

    // Verify chain
    let chainValid = false;
    let chainError: string | null = null;
    let verified: any = null;

    try {
      verified = await verifyChain(chain.log as string[]);
      chainValid = !verified.isDeleted;
    } catch (err: any) {
      chainError = err.message || 'Chain verification failed';
    }

    // Check DB consistency
    let dbConsistent = false;
    if (verified && identity.publicKey) {
      const dbMultibase = hexToMultibase(identity.publicKey);
      const chainMultibase = verified.controllerKeys?.[0]?.publicKeyMultibase;
      dbConsistent = dbMultibase === chainMultibase;
    }

    return NextResponse.json({
      did: decodedDid,
      dfosDid: chain.dfosDid,
      hasDfosChain: true,
      chainValid,
      chainError,
      chainLength: (chain.log as string[]).length,
      currentKeys: verified ? {
        auth: verified.authKeys?.length ?? 0,
        assert: verified.assertKeys?.length ?? 0,
        controller: verified.controllerKeys?.length ?? 0,
      } : null,
      dbConsistent,
      isDeleted: verified?.isDeleted ?? null,
    }, { headers: cors });
  } catch (err) {
    console.error('[verify] Error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500, headers: cors });
  }
}
```

---

## Step 3: Consistency Check Function

Add to `apps/auth/lib/dfos.ts` — a function that checks ALL identities for chain/DB key drift. This isn't an endpoint — it's a utility for the `scripts/check-dfos-chains.ts` script that already exists, and for future cron/admin use.

```typescript
/**
 * Check all identity chains for consistency with DB public keys.
 * Returns a list of mismatches.
 */
export async function checkAllChainConsistency(): Promise<Array<{
  did: string;
  dfosDid: string;
  issue: string;
}>> {
  const chains = await db.select().from(identityChains);
  const issues: Array<{ did: string; dfosDid: string; issue: string }> = [];

  for (const chain of chains) {
    try {
      const verified = await verifyChain(chain.log as string[]);

      if (verified.isDeleted) {
        issues.push({ did: chain.did, dfosDid: chain.dfosDid, issue: 'Chain is deleted' });
        continue;
      }

      const [identity] = await db
        .select({ publicKey: identities.publicKey })
        .from(identities)
        .where(eq(identities.id, chain.did))
        .limit(1);

      if (!identity) {
        issues.push({ did: chain.did, dfosDid: chain.dfosDid, issue: 'Identity missing from DB' });
        continue;
      }

      const dbMultibase = hexToMultibase(identity.publicKey);
      const chainMultibase = verified.controllerKeys[0]?.publicKeyMultibase;

      if (dbMultibase !== chainMultibase) {
        issues.push({ did: chain.did, dfosDid: chain.dfosDid, issue: `Key mismatch: DB=${dbMultibase.slice(0, 12)}... Chain=${chainMultibase?.slice(0, 12)}...` });
      }
    } catch (err: any) {
      issues.push({ did: chain.did, dfosDid: chain.dfosDid, issue: `Verification error: ${err.message}` });
    }
  }

  return issues;
}
```

---

## Step 4: Update API Spec

If `apps/auth/app/api/spec/route.ts` exists, add the new verify endpoint to it.

---

## Step 5: Build + Test

```bash
cd apps/auth && npx next build

# Manual testing against dev:
# curl https://dev-auth.imajin.ai/api/identity/did:imajin:xxx/verify
```

---

## Step 6: Commit + PR

```bash
git add -A
git commit -m "feat(auth): chain-aware middleware + verify endpoint (#403)

- requireAuth({ verifyChain: true }) — opt-in chain verification
- GET /api/identity/:did/verify — public chain + DB consistency check
- checkAllChainConsistency() utility for admin/scripts
- Chain verification OFF by default, backward compatible

Closes #403"
git push origin feat/403-chain-middleware
gh pr create --title "feat(auth): chain-aware auth middleware (#403)" \
  --body "Closes #403. Opt-in DFOS chain verification in auth middleware.

## Changes
- \`requireAuth(req, { verifyChain: true })\` — verify identity against DFOS chain
- \`GET /api/identity/:did/verify\` — public chain verification + DB consistency
- \`checkAllChainConsistency()\` — batch audit function

Chain verification is OFF by default. All existing auth flows unchanged."
```

---

## What NOT To Do

- **Don't turn verifyChain on by default.** It's opt-in. Flipping the default would add a DB query + crypto verification to every authenticated request.
- **Don't modify the session token format.** Key role awareness (`key_id`, `key_role` in tokens) is #401's scope.
- **Don't add `requireAssertKey` / `requireControllerKey` yet.** Those depend on #401 (key role separation in tokens). The issue spec mentions them but they can't work until tokens carry key role info.
- **Don't add federation header parsing** (`Authorization: DIDChain ...`). That's future work. Structure the code so it's easy to add later, but don't build it.
- **Don't add rate limiting** to the verify endpoint — it's read-only, public, no side effects.

## Success Criteria

```
✓ requireAuth(req) — unchanged behavior, no regressions
✓ requireAuth(req, { verifyChain: true }) — verifies chain, returns null on failure
✓ requireAuth with verifyChain + no chain — passes (non-fatal, identity just isn't bridged)
✓ GET /api/identity/:did/verify — returns chain status + DB consistency
✓ checkAllChainConsistency() — reports mismatches across all chains
✓ Build passes (npx next build)
✓ PR created against main
```
