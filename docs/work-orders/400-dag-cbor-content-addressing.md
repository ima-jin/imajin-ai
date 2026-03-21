# Work Order: #400 — dag-cbor Content Addressing

**Epic:** #395 (DFOS DID Bridge)  
**Issue:** #400  
**Scope:** Foundation layer — `@imajin/cid` shared package + CID column on `auth.attestations`.  
**Branch:** `feat/400-content-addressing`  
**Depends on:** PR #407 merged (brings `@metalabel/dfos-protocol` + `@ipld/dag-cbor` into workspace)

---

## What You're Building

Phase 1 only — the foundation for content addressing across all services:

1. `packages/cid/` — `@imajin/cid` shared package with `computeCid(object)` utility
2. CID column on `auth.attestations` table
3. Attestation creation computes + stores CID at write time
4. Verification utility: `verifyCid(object, expectedCid)` → boolean

This does NOT add CIDs to chat, events, media, etc. — those are future phases. This ships the shared package and proves the pattern on attestations.

---

## Step 0: Setup

```bash
cd ~/workspace/imajin-ai
git checkout main && git pull
git checkout -b feat/400-content-addressing
```

## Files to Read First

1. `node_modules/@metalabel/dfos-protocol/` — check if `@ipld/dag-cbor` and `multiformats` are already available as transitive deps
2. `packages/auth/src/crypto.ts` — existing `canonicalize()` function (JSON-based — we're NOT replacing this)
3. `apps/auth/src/db/schema.ts` — `attestations` table
4. `apps/auth/app/api/attestations/` — any existing attestation endpoints (or inline creation in other routes)
5. `packages/dfos/src/bridge.ts` — see how DFOS uses dag-cbor internally (via `signIdentityOperation`)

---

## Step 1: Create `packages/cid/`

### `packages/cid/package.json`

```json
{
  "name": "@imajin/cid",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@ipld/dag-cbor": "^9.0.0",
    "multiformats": "^13.0.0"
  }
}
```

**⚠️ Check existing versions:** `@ipld/dag-cbor` and `multiformats` may already be in the lockfile via `@metalabel/dfos-protocol`. Match their versions to avoid duplicates:

```bash
grep -A 1 "@ipld/dag-cbor" pnpm-lock.yaml | head -5
grep -A 1 "multiformats@" pnpm-lock.yaml | head -5
```

### `packages/cid/src/index.ts`

```typescript
import * as dagCbor from '@ipld/dag-cbor';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

/**
 * Compute a CIDv1 (dag-cbor + SHA-256) for any JSON-serializable object.
 *
 * The object is canonically encoded as dag-cbor, then SHA-256 hashed,
 * producing a deterministic CID string identical to what DFOS uses.
 *
 * @returns CID as base32lower string (bafyrei...)
 */
export async function computeCid(object: unknown): Promise<string> {
  const encoded = dagCbor.encode(object);
  const hash = await sha256.digest(encoded);
  const cid = CID.createV1(dagCbor.code, hash);
  return cid.toString(); // base32lower by default
}

/**
 * Verify that an object matches an expected CID.
 *
 * @returns true if the recomputed CID matches
 */
export async function verifyCid(object: unknown, expectedCid: string): Promise<boolean> {
  const actual = await computeCid(object);
  return actual === expectedCid;
}

/**
 * Parse a CID string back into a CID object.
 * Useful for inspecting codec, hash, version.
 */
export function parseCid(cidString: string): CID {
  return CID.parse(cidString);
}
```

### `packages/cid/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts"]
}
```

---

## Step 2: Tests

### `packages/cid/tests/cid.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { computeCid, verifyCid, parseCid } from '../src/index';

describe('computeCid', () => {
  it('produces a deterministic CID for the same object', async () => {
    const obj = { type: 'test', value: 42 };
    const cid1 = await computeCid(obj);
    const cid2 = await computeCid(obj);
    expect(cid1).toBe(cid2);
  });

  it('produces different CIDs for different objects', async () => {
    const cid1 = await computeCid({ a: 1 });
    const cid2 = await computeCid({ a: 2 });
    expect(cid1).not.toBe(cid2);
  });

  it('is key-order independent (dag-cbor canonical)', async () => {
    const cid1 = await computeCid({ b: 2, a: 1 });
    const cid2 = await computeCid({ a: 1, b: 2 });
    expect(cid1).toBe(cid2);
  });

  it('produces a CIDv1 string starting with b', async () => {
    const cid = await computeCid({ hello: 'world' });
    expect(cid).toMatch(/^b[a-z2-7]+$/); // base32lower
  });
});

describe('verifyCid', () => {
  it('returns true for matching object', async () => {
    const obj = { type: 'attestation', subject: 'did:imajin:test' };
    const cid = await computeCid(obj);
    expect(await verifyCid(obj, cid)).toBe(true);
  });

  it('returns false for tampered object', async () => {
    const obj = { type: 'attestation', subject: 'did:imajin:test' };
    const cid = await computeCid(obj);
    expect(await verifyCid({ ...obj, subject: 'did:imajin:tampered' }, cid)).toBe(false);
  });
});

describe('parseCid', () => {
  it('roundtrips through parse', async () => {
    const cid = await computeCid({ test: true });
    const parsed = parseCid(cid);
    expect(parsed.toString()).toBe(cid);
    expect(parsed.version).toBe(1);
  });
});
```

---

## Step 3: Schema Change — Add CID to Attestations

### Migration: `apps/auth/drizzle/0005_content_addressing.sql`

```sql
-- Add content address to attestations
ALTER TABLE auth.attestations
  ADD COLUMN IF NOT EXISTS cid TEXT;
```

### Update `apps/auth/src/db/schema.ts`

Add to the `attestations` table definition:

```typescript
cid: text('cid'),  // dag-cbor CID of the attestation payload
```

### Update journal

Add entry for `0005_content_addressing` in `apps/auth/drizzle/meta/_journal.json`.

---

## Step 4: Wire CID into Attestation Creation

Find where attestations are created. Search:

```bash
grep -r "db.insert(attestations)" apps/auth/ --include="*.ts" -l
grep -r "attestations.*insert\|insert.*attestations" apps/ --include="*.ts" -l
```

At each insert site, add:

```typescript
import { computeCid } from '@imajin/cid';

// Before inserting:
const attestationPayload = {
  subjectDid,
  type,
  contextId,
  contextType,
  payload,
  issuedAt: new Date().toISOString(),
};
const cid = await computeCid(attestationPayload);

// In the insert:
await db.insert(attestations).values({
  ...existingFields,
  cid,
});
```

**⚠️ Important:** The CID must be computed over a stable, canonical subset of the attestation data — NOT the full DB row (which includes auto-generated `id`, `createdAt`, etc.). Define clearly which fields go into the CID and document it. The fields in the CID are the "portable payload" — what survives export.

**⚠️ Also add `@imajin/cid` to auth's transpilePackages** in `next.config.js`.

---

## Step 5: Verification Utility on Attestation Read

Add a verify option to the attestation lookup endpoint:

```bash
# Check if this exists:
ls apps/auth/app/api/attestations/ 2>/dev/null
```

If there's a GET endpoint for attestations, add an optional `?verify=true` query param that recomputes the CID from the stored payload and checks it matches. This proves the attestation hasn't been tampered with in the DB.

---

## Step 6: Build + Test

```bash
# Run CID tests
pnpm test

# Build auth
cd apps/auth && npx next build
```

---

## Step 7: Commit + PR

```bash
git add -A
git commit -m "feat: @imajin/cid — dag-cbor content addressing (#400)

- packages/cid/ — computeCid(), verifyCid(), parseCid()
- CID column on auth.attestations
- Attestation creation computes CID at write time
- 6+ tests for determinism, verification, roundtrip

Closes #400"
git push origin feat/400-content-addressing
```

---

## What NOT To Do

- **Don't add CIDs to chat, events, media, learn, etc.** — that's future phases. This is attestations only.
- **Don't replace `canonicalize()` in `@imajin/auth`** — it's used for SignedMessage verification and must stay for backward compat.
- **Don't migrate existing attestations** — old ones get `cid: null`. New ones compute CID.
- **Don't change .fair integrity hashing** — .fair uses SHA-256 over file contents, not dag-cbor over metadata. Different purpose. CID integration for .fair is a separate issue.
- **Don't add `@ipld/dag-cbor` directly to auth** — it goes in `@imajin/cid`, which auth imports.

## Success Criteria

```
✓ @imajin/cid package exists with computeCid(), verifyCid(), parseCid()
✓ CID is deterministic — same object always produces same CID
✓ CID is key-order independent (dag-cbor canonical encoding)
✓ auth.attestations has cid column
✓ New attestations get CID computed at write time
✓ Old attestations (cid: null) still work
✓ Tests pass
✓ Build passes
✓ PR created against main
```
