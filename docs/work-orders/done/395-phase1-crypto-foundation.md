# Work Order: Phase 1 — Crypto Foundation

**Epic:** #395 (DFOS DID Bridge)  
**Issues:** #399, #396, #404  
**Scope:** Pure library code + tests. No database, no endpoints, no deploy.  
**Branch:** `feat/dfos-bridge-phase1`

---

## What You're Building

Three things:

1. **Key format conversion utilities** in `packages/auth/` — hex ↔ multikey encoding
2. **`@imajin/dfos` shared package** in `packages/dfos/` — DFOS identity chain creation from Imajin keypairs
3. **Verification test suite** — proves every bridge linkage is correct

When done: a coding agent in a fresh session can run `pnpm test` and see that Imajin keypairs produce valid DFOS identity chains that pass DFOS protocol's own verification.

---

## Step 0: Setup

```bash
cd ~/workspace/imajin-ai
git checkout -b feat/dfos-bridge-phase1
```

### Add workspace dependencies

```bash
# DFOS protocol package (MIT, ~1,700 lines)
pnpm add -w @metalabel/dfos-protocol

# Test framework
pnpm add -wD vitest
```

Add to root `package.json` scripts:
```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

Create `vitest.config.ts` at workspace root:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
  },
});
```

---

## Step 1: Key Format Utilities (#399)

**File:** `packages/auth/src/crypto.ts` (extend existing)

### What exists

The file already has: `generatePrivateKey()`, `getPublicKey()`, `generateKeypair()`, `sign()`, `verify()`, `hexToBytes()`, `bytesToHex()`, and key/signature validators. All using `@noble/ed25519` with hex encoding.

### What to add

```typescript
import bs58 from 'bs58';

// Multikey header: 0xed = Ed25519, 0x01 = public key
const MULTIKEY_ED25519_HEADER = new Uint8Array([0xed, 0x01]);

/**
 * Encode raw Ed25519 public key bytes as W3C Multikey (base58btc)
 * Format: 'z' + base58btc(0xed01 + 32 pubkey bytes)
 */
export function bytesToMultibase(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error('Ed25519 public key must be 32 bytes');
  }
  const prefixed = new Uint8Array(MULTIKEY_ED25519_HEADER.length + publicKey.length);
  prefixed.set(MULTIKEY_ED25519_HEADER);
  prefixed.set(publicKey, MULTIKEY_ED25519_HEADER.length);
  return 'z' + bs58.encode(prefixed);
}

/**
 * Decode W3C Multikey (base58btc) to raw Ed25519 public key bytes
 * Validates 'z' prefix and 0xed01 header
 */
export function multibaseToPubkey(multibase: string): Uint8Array {
  if (!multibase.startsWith('z')) {
    throw new Error('Multibase must start with z (base58btc)');
  }
  const decoded = bs58.decode(multibase.slice(1));
  if (decoded.length !== 34) {
    throw new Error(`Expected 34 bytes (2 header + 32 key), got ${decoded.length}`);
  }
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error('Invalid Multikey header (expected 0xed01 for Ed25519)');
  }
  return decoded.slice(2);
}

/**
 * Convert Imajin hex public key to Multikey multibase string
 */
export function hexToMultibase(publicKeyHex: string): string {
  return bytesToMultibase(hexToBytes(publicKeyHex));
}

/**
 * Convert Multikey multibase string to Imajin hex public key
 */
export function multibaseToHex(multibase: string): string {
  return bytesToHex(multibaseToPubkey(multibase));
}
```

### Dependencies

`bs58` is already used in `apps/auth/lib/crypto.ts` but NOT in `packages/auth/`. Add it:

```bash
pnpm add -F @imajin/auth bs58
```

### Export

Make sure all new functions are exported from `packages/auth/src/index.ts`.

---

## Step 2: `@imajin/dfos` Package (#396)

### Scaffold

```bash
mkdir -p packages/dfos/src packages/dfos/tests
```

**`packages/dfos/package.json`:**
```json
{
  "name": "@imajin/dfos",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "@metalabel/dfos-protocol": "workspace:*",
    "@imajin/auth": "workspace:*"
  }
}
```

Wait — `@metalabel/dfos-protocol` is an npm package, not a workspace package. Use the npm version:

```json
{
  "dependencies": {
    "@metalabel/dfos-protocol": "^0.x",
    "@imajin/auth": "workspace:*"
  }
}
```

Check the actual published version on npm first:
```bash
npm view @metalabel/dfos-protocol version
```

**`packages/dfos/tsconfig.json`:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

If no `tsconfig.base.json` exists at root, check existing packages for the pattern (e.g., `packages/auth/tsconfig.json`) and match it.

### Source Files

**`packages/dfos/src/signer.ts`:**

```typescript
import { hexToBytes } from '@imajin/auth';
import { ed25519 } from '@noble/curves/ed25519';
import type { Signer } from '@metalabel/dfos-protocol';

/**
 * Create a DFOS-compatible Signer from an Imajin hex private key.
 * 
 * DFOS Signer type: (message: Uint8Array) => Promise<Uint8Array>
 */
export function createSigner(privateKeyHex: string): Signer {
  const privateKey = hexToBytes(privateKeyHex);
  return async (message: Uint8Array): Promise<Uint8Array> => {
    return ed25519.sign(message, privateKey);
  };
}
```

**⚠️ Import check:** DFOS uses `@noble/curves/ed25519` (not `@noble/ed25519`). They're different packages. DFOS's `Signer` type expects the `@noble/curves` signature format. Verify that the signature output is byte-compatible (it should be — both are Ed25519, 64-byte signatures). If `@noble/curves` isn't available, it comes as a transitive dep of `@metalabel/dfos-protocol`.

**`packages/dfos/src/bridge.ts`:**

```typescript
import { hexToMultibase, hexToBytes } from '@imajin/auth';
import { signIdentityOperation, verifyIdentityChain } from '@metalabel/dfos-protocol';
import { createSigner } from './signer';

// Re-export for convenience
export type { VerifiedIdentity } from '@metalabel/dfos-protocol';

/**
 * Generate a unique key ID for DFOS Multikey objects.
 * Matches DFOS convention: key_<22chars>
 */
function generateKeyId(): string {
  // Use crypto.randomUUID and take first 22 chars, or match DFOS's generateId pattern
  const bytes = new Uint8Array(22);
  globalThis.crypto.getRandomValues(bytes);
  const alphabet = '2346789acdefhknrtvz';
  let id = '';
  for (let i = 0; i < 22; i++) {
    id += alphabet.charAt(bytes[i] % alphabet.length);
  }
  return `key_${id}`;
}

/**
 * Create a DFOS identity chain from an Imajin Ed25519 keypair.
 * 
 * The existing Imajin private key signs the DFOS genesis operation,
 * producing a deterministic did:dfos identity. Single keypair, two DIDs.
 * 
 * @returns The DFOS DID, JWS log (genesis), and operation CID.
 */
export async function createIdentityChain(input: {
  privateKeyHex: string;
  publicKeyHex: string;
}): Promise<{
  did: string;
  log: string[];
  operationCID: string;
}> {
  const multibase = hexToMultibase(input.publicKeyHex);
  const keyId = generateKeyId();

  const multikey = {
    id: keyId,
    type: 'Multikey' as const,
    publicKeyMultibase: multibase,
  };

  const operation = {
    version: 1 as const,
    type: 'create' as const,
    authKeys: [multikey],
    assertKeys: [multikey],
    controllerKeys: [multikey],
    createdAt: new Date().toISOString().replace(/Z$/, '') + 'Z',
    // DFOS requires ISO 8601 with millisecond precision
  };

  // ⚠️ Check DFOS's exact timestamp format requirement.
  // Their schema uses: z.iso.datetime({ offset: false, precision: 3 })
  // That means: "2026-03-20T22:00:00.000Z" — no offset, 3 decimal places
  // Adjust the timestamp formatting if needed:
  // new Date().toISOString() already produces this format.

  const signer = createSigner(input.privateKeyHex);

  const { jwsToken, operationCID } = await signIdentityOperation({
    operation,
    signer,
    keyId,
    // No identityDID for genesis — bare kid
  });

  // Verify our own chain to derive the DID
  const verified = await verifyIdentityChain({
    didPrefix: 'did:dfos',
    log: [jwsToken],
  });

  return {
    did: verified.did,
    log: [jwsToken],
    operationCID,
  };
}

/**
 * Verify a DFOS identity chain log.
 * 
 * Thin wrapper around dfos-protocol's verifyIdentityChain.
 * Returns the verified identity state (DID, keys, deletion status).
 */
export async function verifyChain(log: string[]) {
  return verifyIdentityChain({
    didPrefix: 'did:dfos',
    log,
  });
}
```

**⚠️ IMPORTANT NOTES FOR THE AGENT:**

1. **Timestamp precision:** DFOS's Zod schema requires `precision: 3` (milliseconds). `new Date().toISOString()` produces `"2026-03-20T22:00:00.000Z"` which should match. Verify against their test vectors.

2. **The `operation` object must pass DFOS's `IdentityOperation` Zod schema.** It uses `z.strictObject()` — no extra fields allowed. Match exactly: `version`, `type`, `authKeys`, `assertKeys`, `controllerKeys`, `createdAt`.

3. **`signIdentityOperation` import path:** Check the actual export from `@metalabel/dfos-protocol`. It may be a named export from the package root, or from a subpath. Read `node_modules/@metalabel/dfos-protocol/dist/index.js` or the package's `exports` field to confirm.

4. **Key ID must not exceed 64 chars** (DFOS schema limit: `MAX_KEY_ID = 64`). `key_` + 22 chars = 26, well under.

**`packages/dfos/src/index.ts`:**

```typescript
export { createSigner } from './signer';
export { createIdentityChain, verifyChain } from './bridge';
export type { VerifiedIdentity } from './bridge';
```

---

## Step 3: Verification Test Suite (#404)

**`packages/dfos/tests/bridge.test.ts`:**

Write tests in this order. Each section builds on the previous.

### Section 1: Key format round-trips

```typescript
import { describe, it, expect } from 'vitest';
import {
  generateKeypair,
  hexToMultibase,
  multibaseToHex,
  bytesToMultibase,
  multibaseToPubkey,
  hexToBytes,
} from '@imajin/auth';

describe('key format conversion', () => {
  it('hex → multibase → hex round-trip', () => {
    const { publicKey } = generateKeypair();
    const multibase = hexToMultibase(publicKey);
    const back = multibaseToHex(multibase);
    expect(back).toBe(publicKey);
  });

  it('bytes → multibase → bytes round-trip', () => {
    const { publicKey } = generateKeypair();
    const bytes = hexToBytes(publicKey);
    const multibase = bytesToMultibase(bytes);
    const back = multibaseToPubkey(multibase);
    expect(Buffer.from(back)).toEqual(Buffer.from(bytes));
  });

  it('produces z6Mk prefix (Ed25519 multikey convention)', () => {
    const { publicKey } = generateKeypair();
    const multibase = hexToMultibase(publicKey);
    expect(multibase).toMatch(/^z6Mk/);
  });

  it('rejects invalid hex (odd length)', () => {
    expect(() => hexToMultibase('abc')).toThrow();
  });

  it('rejects invalid multibase (wrong prefix)', () => {
    expect(() => multibaseToPubkey('x6MkInvalid')).toThrow();
  });

  it('rejects invalid multibase (wrong header)', () => {
    // Valid base58btc but wrong header bytes
    const fakeMultibase = 'z' + 'A'.repeat(44);
    expect(() => multibaseToPubkey(fakeMultibase)).toThrow();
  });
});
```

### Section 2: Chain creation

```typescript
import { describe, it, expect } from 'vitest';
import { generateKeypair } from '@imajin/auth';
import { createIdentityChain, verifyChain } from '@imajin/dfos';

describe('identity chain creation', () => {
  it('creates a chain that verifies', async () => {
    const keypair = generateKeypair();
    const result = await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });

    expect(result.did).toMatch(/^did:dfos:/);
    expect(result.log).toHaveLength(1);
    expect(result.operationCID).toBeTruthy();

    // Verify with DFOS protocol's own verifier
    const verified = await verifyChain(result.log);
    expect(verified.did).toBe(result.did);
    expect(verified.isDeleted).toBe(false);
    expect(verified.controllerKeys).toHaveLength(1);
  });

  it('different keypairs produce different DIDs', async () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();

    const chain1 = await createIdentityChain({
      privateKeyHex: kp1.privateKey,
      publicKeyHex: kp1.publicKey,
    });
    const chain2 = await createIdentityChain({
      privateKeyHex: kp2.privateKey,
      publicKeyHex: kp2.publicKey,
    });

    expect(chain1.did).not.toBe(chain2.did);
  });

  it('genesis has all three key roles populated', async () => {
    const keypair = generateKeypair();
    const { log } = await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });

    const verified = await verifyChain(log);
    expect(verified.authKeys).toHaveLength(1);
    expect(verified.assertKeys).toHaveLength(1);
    expect(verified.controllerKeys).toHaveLength(1);

    // All three roles use the same key material
    expect(verified.authKeys[0].publicKeyMultibase)
      .toBe(verified.controllerKeys[0].publicKeyMultibase);
  });

  it('DID format matches did:dfos spec (22-char custom alphabet)', async () => {
    const keypair = generateKeypair();
    const { did } = await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });

    const id = did.replace('did:dfos:', '');
    expect(id).toHaveLength(22);
    expect(id).toMatch(/^[2346789acdefhknrtvz]+$/);
  });
});
```

### Section 3: Signer adapter

```typescript
import { describe, it, expect } from 'vitest';
import { generateKeypair, hexToBytes } from '@imajin/auth';
import { createSigner } from '@imajin/dfos';
import { ed25519 } from '@noble/curves/ed25519';

describe('signer adapter', () => {
  it('produces valid Ed25519 signatures', async () => {
    const keypair = generateKeypair();
    const signer = createSigner(keypair.privateKey);
    const message = new TextEncoder().encode('test message');

    const signature = await signer(message);
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature).toHaveLength(64);

    // Verify with noble/curves directly
    const pubBytes = hexToBytes(keypair.publicKey);
    const valid = ed25519.verify(signature, message, pubBytes);
    expect(valid).toBe(true);
  });
});
```

### Section 4: Cross-protocol verification (the big one)

```typescript
import { describe, it, expect } from 'vitest';
import { generateKeypair, hexToMultibase, hexToBytes, signSync } from '@imajin/auth';
import { createIdentityChain, verifyChain } from '@imajin/dfos';
import { signContentOperation, verifyContentChain } from '@metalabel/dfos-protocol';
import { createSigner } from '@imajin/dfos';

describe('cross-protocol verification', () => {
  it('DFOS chain exports a key that verifies Imajin SignedMessage signatures', async () => {
    const keypair = generateKeypair();

    // Create DFOS chain with Imajin keypair
    const { log } = await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });

    // Extract public key from DFOS chain (as if we only have the chain)
    const verified = await verifyChain(log);
    const dfosMultibase = verified.controllerKeys[0].publicKeyMultibase;

    // Convert back to hex
    const recoveredHex = (await import('@imajin/auth')).multibaseToHex(dfosMultibase);

    // This recovered key should match the original
    expect(recoveredHex).toBe(keypair.publicKey);
  });

  it('Imajin signer creates valid DFOS content chain operations', async () => {
    const keypair = generateKeypair();
    const { did: dfosDid, log: identityLog } = await createIdentityChain({
      privateKeyHex: keypair.privateKey,
      publicKeyHex: keypair.publicKey,
    });

    const verified = await verifyChain(identityLog);
    const keyId = verified.authKeys[0].id;
    const kid = `${dfosDid}#${keyId}`;
    const signer = createSigner(keypair.privateKey);

    // Sign a content operation using Imajin's signer
    const contentOp = {
      version: 1 as const,
      type: 'create' as const,
      did: dfosDid,
      documentCID: 'bafyreihash1234567890abcdefghijklmnopqrstuvwxyz12345678',
      baseDocumentCID: null,
      createdAt: new Date().toISOString(),
      note: null,
    };

    const { jwsToken } = await signContentOperation({
      operation: contentOp,
      signer,
      kid,
    });

    // Verify with DFOS's own content chain verifier
    const multibase = verified.controllerKeys[0].publicKeyMultibase;
    const { keyBytes } = (await import('@metalabel/dfos-protocol')).decodeMultikey(multibase);

    const contentChain = await verifyContentChain({
      log: [jwsToken],
      resolveKey: async () => keyBytes,
    });

    expect(contentChain.contentId).toBeTruthy();
    expect(contentChain.isDeleted).toBe(false);
  });
});
```

**⚠️ IMPORT NOTES FOR THE AGENT:**

The exact imports from `@metalabel/dfos-protocol` may differ from what's shown above. Before writing tests:

1. Read `node_modules/@metalabel/dfos-protocol/dist/index.js` or `.d.ts` to see actual exports
2. The package might use named exports, default exports, or subpath exports
3. Key functions to find: `signIdentityOperation`, `verifyIdentityChain`, `signContentOperation`, `verifyContentChain`, `decodeMultikey`
4. `ed25519` may need to be imported from `@noble/curves/ed25519` (transitive dep)

---

## Step 4: Verify Everything

```bash
# Run the test suite
pnpm test

# Make sure existing packages still build
pnpm -r build

# Check for TypeScript errors
pnpm -r tsc --noEmit
```

### Expected output

All tests green. No build regressions. The key proof: `createIdentityChain()` with an Imajin keypair → `verifyIdentityChain()` from `@metalabel/dfos-protocol` passes. Our bridge produces artifacts their protocol accepts.

---

## Step 5: Commit + PR

```bash
git add -A
git commit -m "feat: @imajin/dfos bridge + key format utils + verification tests (#395, #396, #399, #404)"
git push origin feat/dfos-bridge-phase1
gh pr create --title "feat: DFOS DID bridge — Phase 1 crypto foundation" \
  --body "Phase 1 of #395. Pure library code + tests, no database or endpoints.

## What's new
- \`packages/auth/src/crypto.ts\` — hex ↔ multikey conversion (#399)
- \`packages/dfos/\` — \`@imajin/dfos\` shared package (#396)
- \`packages/dfos/tests/\` — verification test suite (#404)

## Key proof
Imajin Ed25519 keypairs → DFOS identity chains → verified by \`@metalabel/dfos-protocol\`'s own verification functions. The bridge is correct.

Closes #399, closes #396, closes #404."
```

---

## What NOT To Do

- **Don't touch the database.** No schema changes, no migrations. That's Phase 2.
- **Don't modify existing auth endpoints.** No route changes. That's Phase 3.
- **Don't add tests for DFOS internals.** Their 149 tests cover their code. Test the bridge only.
- **Don't fork `@metalabel/dfos-protocol`.** Use the published npm package.
- **Don't deploy anything.** This is library code — it ships when Phase 2 consumes it.
- **Don't modify `apps/` at all.** Everything is in `packages/`.

## Files to Read Before Starting

1. `packages/auth/src/crypto.ts` — current crypto primitives (extend this)
2. `packages/auth/src/index.ts` — exports (add new functions here)
3. `packages/auth/package.json` — check existing deps
4. `~/workspace/dfos/packages/dfos-protocol/src/chain/identity-chain.ts` — `signIdentityOperation`, `verifyIdentityChain`
5. `~/workspace/dfos/packages/dfos-protocol/src/chain/content-chain.ts` — `signContentOperation`, `verifyContentChain`
6. `~/workspace/dfos/packages/dfos-protocol/src/chain/schemas.ts` — Zod schemas (exact field requirements)
7. `~/workspace/dfos/packages/dfos-protocol/src/chain/multikey.ts` — `encodeMultikey`, `decodeMultikey`
8. `~/workspace/dfos/packages/dfos-protocol/src/crypto/ed25519.ts` — their key/sign/verify functions
9. `node_modules/@metalabel/dfos-protocol/` — actual published exports (may differ from source)

## Success Criteria

```
✓ pnpm test — all tests pass
✓ pnpm -r build — no regressions
✓ Key round-trip: hex → multibase → hex = identical
✓ Chain round-trip: createIdentityChain() → verifyIdentityChain() = valid
✓ Cross-protocol: Imajin signer → DFOS content chain → DFOS verifier = valid
✓ PR created against main
```
