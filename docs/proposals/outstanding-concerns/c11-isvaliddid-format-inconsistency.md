# C11 — isValidDID Format Inconsistency

**Flagged:** March 23, 2026 (first identified in P19, March 13, 2026)
**Source:** `packages/auth/src/providers/keypair.ts:223` and `:49`
**Priority:** MEDIUM — latent bug, limited blast radius currently, will widen as platform grows
**Related:** P19 (Solana/Imajin Overlap), P27 (Unified Identity Substrate), #371 (stable DID migration)

---

## The Concern

Two persistent format inconsistencies in `packages/auth/src/providers/keypair.ts` have survived every sprint since they were first identified on March 13, 2026.

### Bug 1 — `isValidDID()` rejects valid DIDs (line 223)

```typescript
export function isValidDID(did: string): boolean {
  if (typeof did !== 'string') return false;
  if (!did.startsWith('did:imajin:')) return false;

  const suffix = did.slice('did:imajin:'.length);
  if (suffix.length !== 16) return false;        // ← WRONG
  if (!/^[0-9a-fA-F]+$/.test(suffix)) return false;

  return true;
}
```

The function validates only 16-character hex suffixes. This rejects:
- **Soft DIDs** — format `did:imajin:{nanoid(44)}` since the stable DID migration (#371, March 15). 44-character nanoid, not 16-character hex.
- **Preliminary/hard DIDs** — server generates `did:imajin:{base58(pubkey)}` which is ~44 characters, not 16.

Any code path calling `isValidDID()` on a soft DID or server-generated preliminary DID will return `false` even for a completely valid identity.

### Bug 2 — `createDID()` generates non-standard format (line 49)

```typescript
return `did:imajin:${publicKey.slice(0, 16)}`;  // ← truncates to 16 hex chars
```

The shared package generates `did:imajin:{16-char hex prefix}` but the server generates `did:imajin:{full base58 pubkey}`. These produce different DID strings for the same keypair. Any client using the package's `createDID()` will generate a DID that doesn't match the server's DID for the same key.

## Current Blast Radius

Limited but growing. The codebase has largely replaced DID-string parsing with tier-based gating (`requireEstablishedDID()`, `requireAuth()`) and chain resolution (`verifyChainLog()`). These bypass `isValidDID()` entirely. However:

- **`getPublicKeyPrefixFromDID()` at line 238** calls `isValidDID()` as a guard — will return `null` for any soft or server-generated DID
- **Any consumer of `@imajin/auth` that calls `isValidDID()`** will silently reject valid identities
- **As DFOS adoption spreads** (P26 all-services chain-aware), more code paths will compare or validate DIDs. A broken validator in the shared package becomes a wider surface.

## Why It Hasn't Been Fixed

The bugs have been noted in every session since March 13 but never addressed. Likely reasons:
- The blast radius has been small due to chain-based identity resolution replacing string validation
- PRs in the DFOS sprint were focused on new chain infrastructure, not fixing legacy format code
- `createDID()` is in a `/* @deprecated — server should generate DIDs */` category in practice

## What Resolution Requires

**`isValidDID()`:** Accept all three valid DID formats:
```typescript
export function isValidDID(did: string): boolean {
  if (typeof did !== 'string') return false;
  if (!did.startsWith('did:imajin:')) return false;
  const suffix = did.slice('did:imajin:'.length);
  // Soft DID: did:imajin:{nanoid(44)} — URL-safe base64, 44 chars
  // Preliminary/hard DID: did:imajin:{base58(pubkey)} — ~43-44 chars
  // Legacy: did:imajin:{16 hex chars} — accept but deprecated
  return suffix.length >= 16 && suffix.length <= 50 && /^[a-zA-Z0-9_-]+$/.test(suffix);
}
```

**`createDID()`:** Either deprecate the function entirely (server should generate DIDs) or match the server format (full base58 pubkey, not truncated prefix). The safest option is removing client-side DID generation from the shared package entirely — the server is the only correct DID mint point.

## Resolution Signal

- `isValidDID()` returns `true` for soft DIDs (44-char nanoid), preliminary DIDs (base58), and legacy DIDs (16-char hex)
- `createDID()` either removed from `packages/auth` or updated to match server format
- All three format types covered in `packages/auth` tests

---

**Status:** Open — persists since March 13, 2026; pre-existing bug, not blocking but widening surface with DFOS adoption
