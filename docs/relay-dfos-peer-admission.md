# Relay writes: DFOS proofs for attested peers (#2132)

## Background

`apps/kernel/src/lib/registry/relay/auth.ts` gates every relay write
(`POST`/`PUT`/`PATCH`/`DELETE` on `/registry/relay/*`) behind `@imajin/auth`'s
`requireAuth` — a verified Imajin session cookie or `Authorization: Bearer
<imajin-token>`. That left the DFOS protocol's own signed-request scheme,
`Authorization: DFOS <proof>`, unrecognized: any non-Imajin DFOS peer got a
401 before the relay ever saw the request (#454, tracked and deferred; the
gap surfaced concretely as 79/80 DFOS relay-conformance failures, #2132).

## Ruling (2026-09-26)

Relay writes accept `Authorization: DFOS <proof>`, verified per protocol
0.2.0, **for attested peers only**. The admission gate is expressed as an
attestation, not a config file or allow-list table — dark-forest default: a
cryptographically valid proof alone does not admit a peer. Imajin
Bearer/session stays as an additional accepted scheme, unchanged. Open
admission of any valid DFOS DID (no attestation gate) is explicitly
deferred.

## Design

- **Scheme detection** (`apps/kernel/src/lib/registry/relay/auth.ts`):
  `authorizeRelayWrite` inspects `Authorization` first. A `DFOS <proof>`
  value is authoritative — it is verified on its own terms and never falls
  through to `requireAuth`. Any other scheme (or none) is unaffected;
  `requireAuth`'s semantics are untouched (`packages/auth/src/require-auth.ts`
  is not modified by this change).
- **Proof verification**
  (`apps/kernel/src/lib/registry/relay/dfos-write-auth.ts`): `<proof>` is a
  DFOS auth-token JWT — the same self-certifying primitive
  `@metalabel/dfos-web-relay` verifies for its own (Bearer-scheme) relay
  AuthN. The JWS `kid` header (`did:dfos:xxx#key_yyy`) names the signer; the
  signer's current auth key is resolved from this relay's own `RelayStore`
  (`getIdentityChain`) and passed to `@metalabel/dfos-protocol`'s
  `verifyAuthToken` along with this relay's own DFOS DID as the expected
  audience. Any failure — malformed token, unknown signer, bad signature,
  wrong audience, expired — is a 401 `invalid_proof`, independent of
  attestation status.
- **Admission gate** (`apps/kernel/src/lib/registry/relay/peer-attestations.ts`):
  a verified proof's peer DID must additionally hold a live (unrevoked,
  unexpired) `relay.peer` attestation issued by this node's own identity
  (`packages/auth/src/types/attestation.ts`). No attestation → 403
  `peer_not_attested`. Lookups are cached in-process for 30s
  (`RELAY_PEER_ATTESTATION_CACHE_TTL_MS`) so an admitted peer's steady-state
  writes don't each cost a DB round trip; a revoke is visible to new checks
  immediately and to cached ones within that window.
- **Admit / revoke path**: no UI, no config file — an operator runs
  `npx tsx scripts/relay-peer-admit.ts <peerDid>` /
  `npx tsx scripts/relay-peer-revoke.ts <peerDid>` against the target
  kernel's database. These call `admitRelayPeer` / `revokeRelayPeer`
  directly (mint/revoke the `relay.peer` attestation), the same functions
  the relay's own admission check reads.
- **Read paths are unchanged.** This is a write-path change only.

## Operator runbook

```bash
# Admit a peer (mints a relay.peer attestation for its DFOS DID)
DATABASE_URL=... AUTH_PRIVATE_KEY=... \
  npx tsx scripts/relay-peer-admit.ts did:dfos:cnnnft9f8a2rn938d6nkz38r847v2kr

# Revoke a peer (marks every live relay.peer attestation for that DID revoked)
DATABASE_URL=... \
  npx tsx scripts/relay-peer-revoke.ts did:dfos:cnnnft9f8a2rn938d6nkz38r847v2kr
```

A revoked peer's next write is denied within
`RELAY_PEER_ATTESTATION_CACHE_TTL_MS` (30s) of the revoke landing.

## API surface

`apps/kernel/api-spec/registry.yaml`'s `/relay/{path}` `POST`/`PUT`
operations list a new `dfosAuth` security scheme (an `apiKey`-style header
scheme documenting the `Authorization: DFOS <proof>` format — OpenAPI has no
native "custom scheme name" construct) alongside the pre-existing
`cookieAuth`/`bearerAuth`, and document the new `peer_not_attested` 403
case.

## Conformance suite

`.github/workflows/relay-conformance.yml` runs the upstream
`github.com/metalabel/dfos` `packages/relay-conformance` Go suite against a
live dev relay. That suite's `createIdentity()` / `createContent()` helpers
submit unsigned-request identity/content-chain operations (no `Authorization`
header at all — self-certifying by the operation's own JWS signature, per
the upstream protocol's actual write contract) and only use `Authorization:
Bearer <auth-token>` for the blob endpoints. **This change does not, by
itself, flip that suite green**: the identity/content-chain creation calls
it exercises never carry a `DFOS`-scheme header for this admission gate to
recognize, so they still fall through to the unchanged `requireAuth` path
and still 401. What this change unblocks is exactly what the ruling scoped:
a **DFOS peer holding a signed auth-token proof and admitted via
`relay.peer`** can now write through this gate — real federation traffic
from an attested peer, not the specific unauthenticated-by-design identity/
content-op calls the upstream conformance suite happens to make. Reconciling
the conformance suite's expectations with this admission model (or annotating
`relay-conformance.yml`) is tracked separately — see the #2132 PR body for
the open question.
