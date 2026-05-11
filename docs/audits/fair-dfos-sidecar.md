# Audit: .fair Sidecar Delivery + DFOS-Native Publication (#882)

## 1. What in `packages/dfos/` to Consume vs. Extend

### Consume (existing)
- `createSigner(privateKeyHex)` — produces a DFOS-compatible `Signer = (message: Uint8Array) => Promise<Uint8Array>`.
- `getPublicKeyBytes(privateKeyHex)` — derives raw Ed25519 public key bytes from a hex private key.
- `@metalabel/dfos-protocol`'s `signContentOperation` and `verifyContentChain` — used in existing tests for content-chain signing/verification.

### Extend (new code)
- **New file: `packages/dfos/src/content-publish.ts`**
  - `publishContentEvent({ topic, payload })` — publishes a signed content event to the DFOS relay.
  - `getContentEvent(eventId)` — fetches a published event by ID for verification.
  - Uses `createSigner` for signing the event payload.
  - Uses `process.env.DFOS_RELAY_URL` for the relay endpoint.
  - Event signing follows the same pattern as `signContentOperation` in tests: sign a canonical payload and POST to relay.

**Decision:** Create a new file `content-publish.ts` rather than extending `bridge.ts`, because:
- `bridge.ts` is focused on identity-chain operations (create/update/verify).
- Content publishing is a distinct concern — it operates on content events, not identity chains.
- Keeps the public API surface clean and separable.

## 2. Headers on Asset Response Route

Added to every byte response (full GET + Range responses) in `apps/kernel/app/media/api/assets/[id]/route.ts`:

| Header | Value | Condition |
|--------|-------|-----------|
| `Link` | `</media/api/assets/{id}/fair>; rel="fair"; type="application/fair+json"` | Always |
| `X-Fair-Digest` | `sha256:<hex>` | Always |
| `X-Fair-Dfos` | `dfos:event:<eventId>` | Only if `fair_dfos_event_id` is non-NULL |

**Digest encoding:** Hex (lowercase). SHA-256 of the canonical JSON of the signed manifest. This matches the existing `hash` column on assets (which is also hex). Using hex for consistency across the codebase.

**Existing headers preserved:** `X-Fair-Access`, `ETag`, `Cache-Control`, `Content-Type`, `Accept-Ranges`, `Content-Range`, `Content-Length`, `X-Variants`, `X-Transcoding`.

## 3. DFOS Event Topic + Payload Shape

**Topic:** `fair.manifest.published`

**Payload:**
```json
{
  "assetId": "asset_xxx",
  "ownerDid": "did:imajin:...",
  "manifestDigest": "sha256:abc123...",
  "manifestUrl": "https://dev-media.imajin.ai/media/api/assets/asset_xxx/fair",
  "fairVersion": "1.1",
  "signedAt": "2026-05-10T20:38:00.000Z"
}
```

**Return value from `publishContentEvent`:**
```ts
{
  eventId: string;      // DFOS-assigned event identifier
  anchoredAt: string;   // ISO timestamp from DFOS relay
}
```

**Fetch return value from `getContentEvent`:**
```ts
{
  topic: string;
  payload: unknown;
  anchoredAt: string;
  signature: string;    // JWS token or raw signature
} | null
```

## 4. Schema Column Decision

**Column name:** `fair_dfos_event_id` (confirmed)

**Type:** `TEXT` (nullable)

**Location:** `media.assets` table in `apps/kernel/src/db/schemas/media.ts`

**Migration:** `migrations/0022_assets_fair_dfos_event_id.sql`

**Rationale:**
- TEXT is appropriate because DFOS event IDs are alphanumeric strings (similar to CIDs or custom base32 identifiers).
- Nullable because not all assets will be anchored to DFOS (DFOS publish is best-effort, and legacy assets won't have it).
- No separate `manifestDigest` cache column: the digest is computed on-the-fly from `fairManifest` JSONB. The overhead of re-canonicalizing and hashing a small JSON object is negligible compared to I/O. Keeps the schema minimal.

## Out of Scope (this PR)
- UI surfacing of verification result on AssetDetail (→ #893 D4)
- Manual upgrade flow's DFOS re-publish (→ #894 D5, with TODO comment)
- Layer 3 in-band metadata (XMP/ID3/MP4 atoms)
- Layer 4 composite download container
