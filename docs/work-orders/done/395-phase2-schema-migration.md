# Work Order: Phase 2 — Schema + Login-Time DFOS Bridge

**Epic:** #395 (DFOS DID Bridge)
**Issue:** #397
**Depends on:** Phase 1 (PR #407 — `@imajin/dfos` + key format utils)
**Scope:** New DB table + server accepts DFOS chains + client creates them at auth time
**Branch:** `feat/dfos-bridge-phase2`

---

## What You're Building

1. **New table** `auth.identity_chains` — stores DFOS chain logs
2. **Server changes** — `/api/register` accepts + verifies + stores DFOS chains
3. **Client changes** — registration and login pages create DFOS chains client-side
4. **Login-time bridging** — existing users who log in get chains created automatically

When done: every new registration creates a DFOS chain. Every existing user who logs in gets bridged. Both dev and prod.

---

## Architecture

```
CLIENT (has private key)                    SERVER (has public key)
─────────────────────────                   ──────────────────────
1. Generate/import keypair
2. Create DFOS identity chain
   (sign genesis with private key)
3. Send to server:                    →     4. Verify challenge signature (existing)
   { ...existing payload,                   5. Verify DFOS chain is valid
     dfosChain: {                           6. Verify chain's public key matches
       did, log, operationCID                  identity's public key
     }                                      7. Store chain in identity_chains
   }                                        8. Store dfos credential
```

The private key NEVER leaves the client. Server independently verifies:
- The auth signature (existing flow, unchanged)
- The DFOS chain (new — `verifyChain()` from `@imajin/dfos`)
- Key match (chain's public key === identity's public key)

---

## Step 0: Setup

```bash
cd /path/to/imajin-ai

# Ensure Phase 1 is available
git checkout main  # or feat/dfos-bridge-phase1 if not yet merged
git pull
git checkout -b feat/dfos-bridge-phase2
```

Verify `@imajin/dfos` and `@metalabel/dfos-protocol` are available:
```bash
ls packages/dfos/src/bridge.ts  # should exist from Phase 1
```

---

## Step 1: Schema — `auth.identity_chains` table

**File:** `apps/auth/src/db/schema.ts`

Add imports: `integer` and `boolean` from `drizzle-orm/pg-core` (may not be imported yet).

Add after the `credentials` table:

```typescript
/**
 * Identity Chains — DFOS proof chains for self-certifying identity
 *
 * Each identity with a real Ed25519 key gets a DFOS identity chain.
 * The chain is append-only: genesis (create), then updates (rotate, delete).
 * The log array contains JWS tokens verifiable by anyone with
 * @metalabel/dfos-protocol — no server needed.
 */
export const identityChains = authSchema.table('identity_chains', {
  did: text('did').primaryKey().references(() => identities.id),
  dfosDid: text('dfos_did').notNull().unique(),
  log: jsonb('log').notNull().$type<string[]>(),
  headCid: text('head_cid').notNull(),
  keyCount: integer('key_count').notNull().default(1),
  isDeleted: boolean('is_deleted').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  dfosDidIdx: uniqueIndex('idx_identity_chains_dfos_did').on(table.dfosDid),
}));

export type IdentityChain = typeof identityChains.$inferSelect;
export type NewIdentityChain = typeof identityChains.$inferInsert;
```

Also add `identityChains` to the db object export — check `apps/auth/src/db/index.ts` for the pattern. It likely does:
```typescript
import * as schema from './schema';
export const db = createDb(schema);
export * from './schema';
```

### Generate Drizzle migration

```bash
cd apps/auth
npx drizzle-kit generate
```

Verify the generated SQL in `apps/auth/drizzle/` creates the table correctly.

---

## Step 2: Server — Accept DFOS Chains

### 2a: Verification helper

**File:** `apps/auth/lib/dfos.ts` (new)

```typescript
import { verifyChain } from '@imajin/dfos';
import { hexToMultibase } from '@imajin/auth';

interface DfosChainPayload {
  did: string;
  log: string[];
  operationCID: string;
}

/**
 * Verify a client-submitted DFOS chain and ensure its key matches
 * the identity's public key.
 *
 * Returns the verified chain data or null if invalid.
 */
export async function verifyClientChain(
  chain: DfosChainPayload,
  expectedPublicKeyHex: string
): Promise<{ did: string; log: string[]; headCid: string } | null> {
  try {
    // 1. Verify the chain is cryptographically valid
    const verified = await verifyChain(chain.log);

    // 2. Verify the DID matches what the client claims
    if (verified.did !== chain.did) {
      console.error('[dfos] DID mismatch:', verified.did, '!==', chain.did);
      return null;
    }

    // 3. Verify the chain's public key matches the identity's public key
    //    The chain's controller key should be the same Ed25519 key
    const expectedMultibase = hexToMultibase(expectedPublicKeyHex);
    const chainKey = verified.controllerKeys[0]?.publicKeyMultibase;
    if (chainKey !== expectedMultibase) {
      console.error('[dfos] Key mismatch: chain key does not match identity public key');
      return null;
    }

    // 4. Verify chain is not deleted
    if (verified.isDeleted) {
      console.error('[dfos] Chain is deleted');
      return null;
    }

    return {
      did: verified.did,
      log: chain.log,
      headCid: chain.operationCID,
    };
  } catch (err) {
    console.error('[dfos] Chain verification failed:', err);
    return null;
  }
}
```

**⚠️ IMPORTANT:** Check that `@imajin/dfos` is in `apps/auth/package.json` dependencies. If not, add it:
```bash
pnpm add -F auth @imajin/dfos
```
Also ensure `@imajin/auth` is a dependency (it likely already is — check).

### 2b: Storage helper

**File:** `apps/auth/lib/dfos.ts` (add to same file)

```typescript
import { db, identityChains, credentials } from '@/src/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';

/**
 * Store a verified DFOS chain for an identity.
 * Idempotent — skips if chain already exists.
 */
export async function storeDfosChain(
  imajinDid: string,
  chain: { did: string; log: string[]; headCid: string }
): Promise<boolean> {
  // Check if already bridged
  const existing = await db
    .select()
    .from(identityChains)
    .where(eq(identityChains.did, imajinDid))
    .limit(1);

  if (existing.length > 0) {
    return false; // Already has a chain
  }

  const credId = `cred_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  // Store chain + credential
  await db.insert(identityChains).values({
    did: imajinDid,
    dfosDid: chain.did,
    log: chain.log,
    headCid: chain.headCid,
    keyCount: 1,
  });

  await db.insert(credentials).values({
    id: credId,
    did: imajinDid,
    type: 'dfos',
    value: chain.did,
    verifiedAt: new Date(),
  });

  return true;
}
```

### 2c: Update `/api/register` route

**File:** `apps/auth/app/api/register/route.ts`

After the identity is created (the `db.insert(identities)` call), add DFOS chain handling:

```typescript
// After identity creation, before profile creation:

// Store DFOS chain if provided
if (body.dfosChain) {
  try {
    const { verifyClientChain, storeDfosChain } = await import('@/lib/dfos');
    const verified = await verifyClientChain(body.dfosChain, publicKey);
    if (verified) {
      await storeDfosChain(identity.id, verified);
    } else {
      console.warn(`[register] DFOS chain verification failed for ${identity.id} — skipping`);
    }
  } catch (err) {
    console.error(`[register] DFOS chain storage failed for ${identity.id}:`, err);
    // Non-fatal — registration still succeeds
  }
}
```

**⚠️ PLACEMENT:** This goes AFTER the identity is inserted but BEFORE the profile creation fetch. The identity must exist (FK constraint) before the chain row.

**⚠️ ALSO:** The "already exists" path (where `existing.length > 0 && existing[0].publicKey === publicKey`) should ALSO check for and store the DFOS chain. This handles the login-via-register flow:

```typescript
// In the "same key - return existing identity" block:
if (body.dfosChain) {
  try {
    const { verifyClientChain, storeDfosChain } = await import('@/lib/dfos');
    const verified = await verifyClientChain(body.dfosChain, publicKey);
    if (verified) {
      await storeDfosChain(existing[0].id, verified);
    }
  } catch (err) {
    console.error(`[register] DFOS bridge failed for ${existing[0].id}:`, err);
  }
}
```

### 2d: Update `/api/login/verify` route

**File:** `apps/auth/app/api/login/verify/route.ts`

After signature verification succeeds, before creating the session token:

```typescript
// Store DFOS chain if provided (login-time bridging)
if (body.dfosChain) {
  try {
    const { verifyClientChain, storeDfosChain } = await import('@/lib/dfos');
    const verified = await verifyClientChain(body.dfosChain, identity.publicKey);
    if (verified) {
      await storeDfosChain(identity.id, verified);
    }
  } catch (err) {
    console.error(`[login] DFOS bridge failed for ${identity.id}:`, err);
  }
}
```

---

## Step 3: Client — Create DFOS Chains

### 3a: Verify `@imajin/dfos` works in browser

The package uses:
- `@metalabel/dfos-protocol` — which uses `@noble/curves` and `@ipld/dag-cbor`
- `@imajin/auth` — which uses `@noble/ed25519`
- `globalThis.crypto.getRandomValues()` — available in browsers

These should all work in browser environments. But verify:
```bash
# Check for any Node-only imports in the chain
grep -r "require('fs')\|require('path')\|require('crypto')" node_modules/@metalabel/dfos-protocol/ || echo "No Node-only deps found"
```

If `@metalabel/dfos-protocol` uses Node's `crypto` module, you may need to ensure the bundler polyfills it (Next.js webpack should handle this for client components).

**⚠️ If browser bundling is problematic:** Create a thin wrapper that imports only what's needed and mark it `'use client'`. But try the direct import first.

### 3b: Client helper function

**File:** `apps/auth/lib/dfos-client.ts` (new, client-side)

```typescript
'use client';

/**
 * Create a DFOS identity chain from a keypair.
 * Runs in the browser — private key never leaves.
 *
 * Returns the chain payload to send to the server, or null on failure.
 */
export async function createDfosChain(keypair: {
  privateKey: string;
  publicKey: string;
}): Promise<{
  did: string;
  log: string[];
  operationCID: string;
} | null> {
  try {
    const { createIdentityChain } = await import('@imajin/dfos');
    return await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });
  } catch (err) {
    console.error('[dfos] Client chain creation failed:', err);
    return null;
  }
}
```

**⚠️ Dynamic import** is intentional — `@imajin/dfos` may be heavy and shouldn't block initial page load. If the import fails (bundling issue), auth still works — the chain is optional.

### 3c: Update registration page

**File:** `apps/auth/app/register/page.tsx`

In the `handleSubmit` function, after generating the keypair and signature, before the fetch:

```typescript
// After: const signature = await sign(JSON.stringify(payload), keypair.privateKey);
// Before: const response = await fetch('/api/register', ...)

// Create DFOS identity chain (client-side, non-blocking)
let dfosChain = null;
try {
  const { createDfosChain } = await import('@/lib/dfos-client');
  dfosChain = await createDfosChain(keypair);
} catch (err) {
  console.warn('DFOS chain creation failed (non-fatal):', err);
}

// Then include in the fetch body:
const response = await fetch('/api/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    ...payload,
    signature,
    inviteCode: inviteCode || undefined,
    email: email.trim() || undefined,
    phone: phone.trim() || undefined,
    optInUpdates,
    dfosChain,  // ← ADD THIS (null if creation failed, server ignores null)
  }),
});
```

### 3d: Update login page

**File:** `apps/auth/app/login/page.tsx`

In the `importPrivateKey` function, after deriving the public key and before the fetch:

```typescript
// After: const signature = Array.from(signatureBytes)...
// Before: const authResponse = await fetch('/api/register', ...)

// Create DFOS identity chain for login-time bridging
let dfosChain = null;
try {
  const { createDfosChain } = await import('@/lib/dfos-client');
  dfosChain = await createDfosChain({
    privateKey: privateKeyHex,
    publicKey: publicKeyHex,
  });
} catch (err) {
  console.warn('DFOS chain creation failed (non-fatal):', err);
}

// Then include in the fetch body:
const authResponse = await fetch('/api/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    publicKey: publicKeyHex,
    type: 'human',
    signature,
    dfosChain,  // ← ADD THIS
  }),
});
```

---

## Step 4: Verification Script

**File:** `scripts/check-dfos-chains.ts`

```typescript
#!/usr/bin/env npx tsx
/**
 * Report DFOS chain bridging status.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/check-dfos-chains.ts
 */

import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is required');
  process.exit(1);
}

async function main() {
  const sql = postgres(DATABASE_URL!);

  try {
    const total = await sql`SELECT COUNT(*) AS count FROM auth.identities`;
    const withKeys = await sql`
      SELECT COUNT(*) AS count FROM auth.identities
      WHERE public_key ~ '^[0-9a-f]{64}$'
    `;
    const withChains = await sql`SELECT COUNT(*) AS count FROM auth.identity_chains`;
    const soft = await sql`
      SELECT COUNT(*) AS count FROM auth.identities
      WHERE public_key LIKE 'soft_%'
    `;

    // List bridged identities
    const bridged = await sql`
      SELECT ic.did, ic.dfos_did, i.handle, i.tier, i.type
      FROM auth.identity_chains ic
      JOIN auth.identities i ON i.id = ic.did
      ORDER BY ic.created_at
    `;

    // List unbridged identities with real keys
    const unbridged = await sql`
      SELECT i.id, i.handle, i.tier, i.type
      FROM auth.identities i
      WHERE i.public_key ~ '^[0-9a-f]{64}$'
        AND i.id NOT IN (SELECT did FROM auth.identity_chains)
      ORDER BY i.created_at
    `;

    console.log('DFOS Chain Status');
    console.log('═'.repeat(50));
    console.log(`Total identities:      ${total[0].count}`);
    console.log(`With real keys:        ${withKeys[0].count}`);
    console.log(`With DFOS chains:      ${withChains[0].count}`);
    console.log(`Soft (no key):         ${soft[0].count}`);
    console.log(`Pending bridge:        ${unbridged.length}`);
    console.log('');

    if (bridged.length > 0) {
      console.log('✅ Bridged:');
      for (const b of bridged) {
        console.log(`   ${b.handle || b.did} (${b.tier}/${b.type}) → ${b.dfos_did}`);
      }
      console.log('');
    }

    if (unbridged.length > 0) {
      console.log('⏳ Pending (will bridge on next login):');
      for (const u of unbridged) {
        console.log(`   ${u.handle || u.id} (${u.tier}/${u.type})`);
      }
    }
  } finally {
    await sql.end();
  }
}

main();
```

---

## Step 5: Tests

Add to `packages/dfos/tests/bridge.test.ts`:

```typescript
describe('identity chain storage format', () => {
  it('chain log survives JSON round-trip (simulates DB storage)', async () => {
    const keypair = generateKeypair();
    const chain = await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });

    const serialized = JSON.stringify(chain.log);
    const deserialized = JSON.parse(serialized);

    const verified = await verifyChain(deserialized);
    expect(verified.did).toBe(chain.did);
  });

  it('operationCID is a valid CID string', async () => {
    const keypair = generateKeypair();
    const chain = await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });

    expect(chain.operationCID).toMatch(/^[a-z2-7]+$/);
    expect(chain.operationCID.length).toBeGreaterThan(10);
  });

  it('chain key matches input public key (server verification test)', async () => {
    const keypair = generateKeypair();
    const chain = await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });

    const verified = await verifyChain(chain.log);
    const chainKeyMultibase = verified.controllerKeys[0].publicKeyMultibase;
    const expectedMultibase = hexToMultibase(keypair.publicKey);

    expect(chainKeyMultibase).toBe(expectedMultibase);
  });
});
```

---

## Step 6: Verify

```bash
# All tests pass
pnpm test

# TypeScript clean
cd apps/auth && npx tsc --noEmit

# Drizzle migration generated
ls apps/auth/drizzle/
```

---

## Step 7: Commit + PR

```bash
git add -A
git commit -m "feat: auth.identity_chains + login-time DFOS bridging (#397)

- Schema: auth.identity_chains table (Drizzle + migration)
- Server: /api/register + /api/login/verify accept + verify + store DFOS chains
- Client: registration + login create DFOS chains client-side
- Login-time bridging: existing users get chains on next auth
- scripts/check-dfos-chains.ts: bridging status report
- Private key never leaves the client

Closes #397."

git push origin feat/dfos-bridge-phase2
gh pr create --title "feat: DFOS login-time bridging + identity_chains schema (#397)" \
  --body "Phase 2 of #395.

## Architecture
Client creates DFOS chain with private key → sends to server → server verifies chain + key match → stores.
Private key never leaves the client. Server independently verifies everything.

## What's new
- \`auth.identity_chains\` table (schema + Drizzle migration)
- \`/api/register\` accepts \`dfosChain\` payload (new + returning users)
- \`/api/login/verify\` accepts \`dfosChain\` payload (challenge-response users)
- \`apps/auth/lib/dfos.ts\` — server verification + storage
- \`apps/auth/lib/dfos-client.ts\` — client chain creation
- Registration page creates chain at signup
- Login page creates chain at import
- \`scripts/check-dfos-chains.ts\` — status report

## Deploy notes
1. Apply Drizzle migration: \`cd apps/auth && DATABASE_URL=... npx drizzle-kit push\`
2. Rebuild auth
3. New registrations get chains automatically
4. Existing users get chains on next login
5. Run check-dfos-chains.ts to monitor progress

Depends on PR #407 (Phase 1). Closes #397."
```

---

## What NOT To Do

- **Don't fail auth if DFOS chain creation fails** — it's supplementary, wrap in try/catch
- **Don't store private keys anywhere** — server never sees them
- **Don't batch-migrate existing identities** — they'll bridge on next login
- **Don't block the registration UI** on chain creation — dynamic import, non-fatal
- **Don't apply schema to prod without Ryan's approval**
- **Don't modify existing auth behavior** — DFOS chain is purely additive

## Files to Read Before Starting

1. `packages/dfos/src/bridge.ts` — Phase 1's `createIdentityChain()` and `verifyChain()`
2. `packages/auth/src/crypto.ts` — `hexToMultibase()` (Phase 1)
3. `apps/auth/src/db/schema.ts` — current schema (extend with `identityChains`)
4. `apps/auth/src/db/index.ts` — how db + schema are exported
5. `apps/auth/app/api/register/route.ts` — registration flow (add chain handling)
6. `apps/auth/app/api/login/verify/route.ts` — challenge-response flow (add chain handling)
7. `apps/auth/app/register/page.tsx` — client registration UI (add chain creation)
8. `apps/auth/app/login/page.tsx` — client login UI (add chain creation)
9. `apps/auth/drizzle.config.ts` — Drizzle config

## Success Criteria

```
✓ pnpm test — all tests pass (including new storage format + key match tests)
✓ Drizzle migration generates clean SQL
✓ TypeScript compiles (apps/auth + packages/dfos)
✓ Registration page: generates keypair + DFOS chain, sends both to server
✓ Login page: imports key + creates DFOS chain, sends to server
✓ Server: verifies chain, matches key, stores in identity_chains
✓ Server: gracefully handles missing/invalid dfosChain (doesn't break auth)
✓ check-dfos-chains.ts reports correct counts
✓ PR created
```
