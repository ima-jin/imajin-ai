# Intro-Funnel Attestation Schema (#1885)

A shared, signed attestation vocabulary for matchmaking-style intro funnels so any agent's funnel is comparable, evidence-graded, and recomputable by any party holding the chain. Settled in the #1885 Day-1 review (Ryan + Jin); this doc is the pinned reference for the build-time decisions made on top of that review.

## The five types

Ordered funnel, all in `packages/auth/src/types/attestation.ts` `ATTESTATION_TYPES` and platform-seeded into `auth.attestation_type_registry`:

- `intro_proposed` — signed by the agent, references both parties. Genesis event.
- `consent_given` / `consent_declined` — signed by each human independently. Declines are first-class: acceptance-rate queries are meaningless without the denominator.
- `intro_made` — signed by the agent after both consents.
- `conversation_happened` — signed by either party, optional, evidence-graded.

`packages/auth/src/intro-funnel.ts` is the single source of truth for this vocabulary and its mechanics (`INTRO_FUNNEL_ATTESTATION_TYPES`, `expectedPrevEventType`, `verifyFunnelChain`, etc.) — client-safe and dependency-free.

## Attestation-type registry: additive, not a replacement

`auth.attestation_type_registry` (migration `0099_attestation_type_registry.sql`) is registry-as-data: platform-seeded rows for the five funnel types, plus third-party rows namespaced under a registrant's own handle (`acme/referral_made`), registered via `POST /auth/api/attestations/types` and gated on `requireEstablishedDID`.

This is deliberately **additive**: the compile-time `ATTESTATION_TYPES` array is untouched, and both attestation-creation routes validate `type` as `ATTESTATION_TYPES.includes(type) || isRegisteredAttestationType(type)`. The ~59 pre-existing hardcoded types keep zero-DB-hit validation; the registry is the extension surface for types that don't ship in a release. Registering a type does not grant any special write access — issuing an attestation of that type still goes through the normal signature-verification path.

## Envelope fields: signed payload, mirrored to columns

The full envelope is `{ subject, actor, delegator?, timestamp, disclosure_scope, prev_event_ref }`. `subject`/`actor`/`timestamp` already exist as `subjectDid`/`issuerDid`/`issuedAt` on `auth.attestations` — no change needed there.

The three new fields (`delegator_did`, `disclosure_scope`, `prev_event_ref`) are accepted as keys inside the existing `payload` object on `POST /auth/api/attestations` and `.../internal`, **not** as new inputs to `canonicalize()`. This was a deliberate choice: `payload` is already part of the Ed25519-signed canonical form (`canonicalize({ subject_did, type, context_id, context_type, payload, issued_at })`), so putting the envelope fields there means they are cryptographically covered with **zero change to the signing/verification wire format** used by every existing caller across ~10 services. Adding them as new top-level canonicalize() inputs would have changed the signed byte sequence for every attestation type, breaking any client that pre-computed a signature against the old shape.

At insert time, both routes extract and validate `payload.delegator_did` / `payload.disclosure_scope` / `payload.prev_event_ref` (see `resolveEnvelopeFields` in `attestation-helpers.ts`) and mirror them into dedicated indexed columns on `auth.attestations` (migration `0100_attestation_funnel_envelope.sql`) so they're queryable and chain-walkable without scanning JSON.

## `prev_event_ref`: chain shape

`prev_event_ref` stores the **id** of the immediate predecessor attestation, not its `cid` — `cid` computation is best-effort and nullable (`cid: string | null`, "old-style attestation still works without CID"), while `id` is a guaranteed non-null primary key. A funnel is a small tree rooted at `intro_proposed`, not a strict linked list, because `intro_made` depends on *two* independent consents:

- `intro_proposed` → `prev_event_ref: null` (genesis)
- `consent_given` / `consent_declined` → `prev_event_ref: <intro_proposed.id>`
- `intro_made` → `prev_event_ref: <intro_proposed.id>` (its dependency on both consents is expressed via the correlation below, not a second parent pointer)
- `conversation_happened` → `prev_event_ref: <intro_made.id>`

`packages/auth/src/intro-funnel.ts`'s `expectedPrevEventType()` encodes this mapping, and `verifyFunnelChain()` walks a set of held events and reports the first broken link (missing predecessor, wrong predecessor type, etc.) — this is how any party can verify their own funnel chain without a trusted server round-trip.

The database also enforces this at the schema level: `prev_event_ref` has a `REFERENCES auth.attestations(id)` FK constraint, and both creation routes reject a `prev_event_ref` that doesn't resolve to an existing attestation with a 400.

## Consent correlation: `context_id`, not a new FK

Two independent `consent_given` / `consent_declined` records correlate to one `intro_proposed` via the **existing** `context_id` / `context_type` columns — `context_id = intro_proposed.id`, `context_type = 'intro_funnel'` (see `funnelCorrelationContext()`). This was chosen over a dedicated FK column because `context_id` already serves exactly this "this attestation is about X" role for every other context-bearing attestation type (event attendance, tickets, etc.); adding a funnel-specific correlation column would have been a parallel mechanism for the same idea. The trade-off is the usual one for a correlation ID versus a FK: no DB-level referential integrity between the two consent rows and the proposal (only `prev_event_ref` is FK-constrained), which is acceptable here because the two consents are independent, human-authored records that must be able to exist without blocking on each other.

## Evidence grades: a projection of existing countersign/decline state

`conversation_happened` reuses the **existing** bilateral countersign/decline mechanics on `auth.attestations.attestation_status` — no parallel dispute flow:

- `attestation_status = 'pending'` → **unilateral** (an honest single-signer claim)
- `attestation_status = 'bilateral'` (via `POST /auth/api/attestations/countersign`) → **corroborated**
- `attestation_status = 'declined'` (via `POST /auth/api/attestations/decline`) → **disputed** — decline *is* the dispute mechanism, the same first-class precedent as `consent_declined`; there is no separate dispute window.

`evidenceGradeForAttestationStatus()` in `packages/auth/src/intro-funnel.ts` is the single mapping function; `GET /auth/api/attestations` annotates every returned row with a computed `evidenceGrade` so downstream consumers (e.g. #1886's value-attribution) can gate on `evidenceGrade === 'corroborated'` instead of re-deriving it from the raw status string. **Unilateral records must never be treated as corroborated** — this is the invariant #1886 depends on.

## `disclosure_scope`: closed four-value enum

`parties` (default — subjects + actor only) · `connections` (trust-graph neighbors) · `network` (any authenticated principal) · `public`. This is a closed enum by design (DB `CHECK` constraint); extending it is deliberately a schema change, not a config value.

Enforcement in `GET /auth/api/attestations` is scoped to attestation types **present in `attestation_type_registry`** — i.e. the new envelope-aware vocabulary (platform-seeded funnel types and any third-party registered type). The ~59 pre-existing hardcoded types are not in the registry and keep today's unrestricted query behavior; this avoids an unreviewed access-control change to unrelated existing features that already rely on this route being broadly queryable (e.g. public profile badges like `event.attendance`).

`connections` resolves against `@imajin/trust-graph`'s `trustRadius(db, viewerDid, 1)`, computed once per request (not per row) to avoid an N+1 query pattern; a viewer is "connected" if the funnel's subject or actor is in their radius-1 trust-graph neighborhood, or if the viewer is a party outright. See `apps/kernel/src/lib/auth/disclosure-access.ts` for the pure access-control function.

## Custody

These attestations are facts about the humans in them. Humans hold the records (`subjectDid`/`issuerDid`-keyed, exactly like every other attestation type); agents get scoped read/write access through the existing app-token model (`resolveEffectiveDid`, `attestations:read`/`attestations:write` scopes) — no new custody mechanism was needed. Funnel metrics (e.g. acceptance rate, declines included in the denominator) are recomputable by any party by querying their own attestation chain via `GET /auth/api/attestations` and walking `prev_event_ref`/`context_id`.
