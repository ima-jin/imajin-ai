# .fair v1.1 Foundation Audit

Repo: `packages/fair/src/`  
Branch: `feat/fair-v1.1-foundation`  
Date: 2026-05-10

---

## D1 — v1.1 schema + validator + canonical + upgradeToV1_1 (#890)

### Existing files audited

| File | What exists | Decision |
|------|-------------|----------|
| `types.ts` | `FairManifest` (v1.0), `FairEntry`, `FairFee`, `FairTransfer`, `FairAccess`, `FairIntegrity`, `FairIntent`, `FairSignature` | **Extend** — add `Money`, `DidShareList`, `FairDistributionRight`, `FairTraining`, `FairCommercial`, `Signature`, `SignedFairManifest`, `FairManifestV1_0`, `FairManifestV1_1`, union `FairManifest` |
| `canonical.ts` | Private `canonicalize()` (sorted keys, no whitespace) + public `canonicalizeForSigning()` (strips signatures) | **Extend** — export generic `canonicalize(value): string`. Existing logic is already JCS-equivalent. No replacement needed. |
| `validate.ts` | `validateManifest()` + `isValidManifest()` — v1.0 only. Share sum check only validates `≤ 1.0001`, not exact `1.0`. | **Extend** — add v1.1 validation path. Keep v1.0 path untouched. New return shape: `{ ok, errors[] }` (aligns with v1.1 convention while preserving old `{ valid, errors[] }` for v1.0). |
| `create.ts` | `createManifest()` — emits v1.0 manifest | **Leave** — not in scope for D1-D3. Could extend later. |
| `buildManifest.ts` | `buildFairManifest()` — fee-chain builder for settlements (v0.4.0) | **Leave** — separate concern from asset manifests. |
| `agent-pricing.ts` | Agent pricing manifest types + calculator | **Leave** — separate concern. |
| `constants.ts` | Fee constants | **Leave** — unchanged. |
| `templates.ts` | `TemplateConfig` + `templates` record — UI section visibility flags, NOT manifest generators | **Surprise**: This file is UI-oriented (`sections: { attribution: boolean, ... }`). It does NOT have a `getDefaultManifest(mimeType, ownerDid)` function. D3 will need to add one alongside or repurpose this module. |

### Key type decisions

- `FairEntry.did` made **optional** (was required) so platform entries (no DID, just `name`) work in both v1.0 display code and v1.1 manifests. `DidShareEntry` is structurally identical to `FairEntry` — TypeScript structural typing makes them interchangeable, which keeps `FairAccordion` and `FairEditor` compiling without major rewrites.
- `FairTransfer` and `FairTransferV1_1` both get each other's optional fields as **backward-compat padding** so the union's `.transfer` property doesn't break component code.
- `FairManifestV1_0` keeps all original fields including `distributions?: FairEntry[]` (event splits) and `chain?: FairEntry[]` (alias).
- `FairManifestV1_1` adds `distribution?: { reproduction?, streaming?, derivative?, syndication? }` (rights object) — note singular vs plural to avoid collision with v1.0 `distributions`.

---

## D2 — owner-signed manifest with ed25519 sign/verify (#891)

### Existing files audited

| File | What exists | Decision |
|------|-------------|----------|
| `sign.ts` | `signManifest(manifest, privateKeyHex, signerDid)`, `verifyManifest(manifest, resolvePublicKey)`, `platformSign()`, `verifyPlatformSignature()` — all use hex keys, hex signatures, old `FairSignature` shape (`algorithm`, `value`, `publicKeyRef`) | **Extend with overloads** — add new `signManifest(manifest, signer: { did, privateKey })` and `verifyManifest(signed, resolveKey)` that use new `Signature` shape (`signer`, `alg`, `value: base64url`, `signedAt`). Keep old functions intact. Use `@noble/ed25519` which is already a workspace dep. |

### Crypto decisions

- `@noble/ed25519` is already in `dependencies` (v2.3.0). No new deps needed.
- Old API: keys/signatures are hex strings. New API: keys are `Uint8Array`, signature value is base64url.
- Old `verifyManifest` returns `{ valid, error? }`. New returns `{ ok, reason? }`.
- Function overloads distinguish old vs new by argument shape (arg count + types).
- `canonicalizeForSigning()` from D1 used for both old and new signing paths.

---

## D3 — rewire media upload to use templates as source of truth (#892)

### Existing files audited

| File | What exists | Decision |
|------|-------------|----------|
| `templates.ts` | `TemplateConfig` with UI section flags + `templates` record. No `getDefaultManifest()`. | **Replace/extend** — repurpose `templates.ts` to also export `getDefaultManifest(mimeType: string, ownerDid: string): FairManifestV1_1`. The existing `TemplateConfig` and `templates` record stay for UI use. Add a new `defaultManifest.ts`-like behavior within `templates.ts` to keep exports centralized. |
| `apps/kernel/app/media/api/assets/route.ts:224` | Hand-rolls v1.0 manifest JSON inline | **Replace** — call `getDefaultManifest(mimeType, ownerDid)` from `@imajin/fair`. Remove inline JSON. |

### Default manifest decisions

- `attribution`: `[{ did: ownerDid, role: 'creator', share: 0.99 }, { role: 'platform', name: 'Imajin', share: 0.01 }]`
- `distribution`: all four rights (reproduction, streaming, derivative, syndication) with `mode: 'allowed'` or `'allow-with-attribution'` depending on type
- `transfer`: `{ allowed: true, requiresAttribution: true, price: { amount: 100000, currency: 'USD' } }`
- `training`: `{ allowed: false }` — headline primitive
- `commercial`: `{ allowed: false, contactRequired: true }`
- `fees`: same 2% cascade as today (protocol 1% + node 0.5% + buyer_credit 0.25% + scope 0.25%)
- `tipping`: `{ enabled: true }`
- Type-aware sub-defaults:
  - `text/*` → `distribution.reproduction.quote = { maxPercent: 25, maxWords: 200 }`
  - `image/*` → `distribution.derivative.mode = 'allow-with-attribution'`
  - `audio/*` → `distribution.derivative.sampling = { allowed: 'allow-with-share', share: 0.05 }`, `distribution.derivative.sync = { allowed: 'reserved' }`
  - `video/*` → `distribution.derivative.sync = { allowed: 'reserved' }`
- `resaleRoyaltyBps`: 500 everywhere

### Sanity check

After D3, will `grep -rn "attribution:" apps/ packages/ | grep -iE "creator.*share|fair"` to find every other inline manifest constructor. Each one should use `getDefaultManifest()` or be documented as bespoke.

---

## No schema changes expected

All `.fair` data lives in JSON columns (`assets.fairManifest`, `transactions.fairManifest`) or object storage (`.fair.json` sidecars). No drizzle schema migrations required.

Verification: `bash scripts/check-schema-migration-sync.sh origin/main` should pass.
