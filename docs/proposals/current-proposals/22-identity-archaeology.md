# Proposal 22 — Identity Archaeology
## Specifying the Read-Side View of the Attestation Layer

**Filed:** 2026-03-17 (sharpened 2026-04-22)
**Author:** Greg Mulholland (Tonalith)
**Series:** Proposal 10 of the Greg architectural review series
**Against upstream HEAD:** 39331e0 (original) / 5a31be1a (April 22 re-verification)
**Relates to:** Proposal 21 (Attentional Sovereignty), Proposal 01 (Progressive Trust Model), RFC-07 (Cultural DID), Proposal 05 (BaggageDID), RFC-27 (Multi-Agent Coordination), @imajin/bus epic #759, PR #244 (Delegated App Sessions), C24 (Bilateral Attestation — advanced)
**Ryan's directive:** Spec now, build when 100+ active users
**Upstream evidence:** Partial — bilateral attestation layer shipped; archaeology endpoint/UI/schema gaps all absent

---

### April 22, 2026 — Status Sharpening

**The live `auth.attestations` schema diverged from P22's baseline in a different direction than P22 anticipated. The 2-gap framing understates the reality — the gap list is now ~5, and one of them is architectural (encryption model), not additive.**

**What has shipped (`apps/kernel/src/db/schemas/auth.ts:89–110`):**

Live columns: `id`, `issuer_did`, `subject_did`, `type`, `context_id`, `context_type`, `payload` (plain `jsonb`), `signature`, **`cid`**, **`author_jws`**, **`witness_jws`**, **`attestation_status`** ('pending' | 'bilateral' | 'declined'), `issued_at`, `expires_at`, `revoked_at`.

Two new layers P22 didn't plan for:
- **Bilateral signing infrastructure** (`authorJws` / `witnessJws` / `attestationStatus`) — C24's bilateral attestation surface advanced significantly. Countersignature flow exists at `apps/kernel/app/auth/api/attestations/countersign/route.ts`.
- **dag-cbor CID addressing** (`cid` column) — #400's industrial-grade content addressing that Ryan confirmed as direction on March 20 has landed. The DFOS integration note's conditional on this is now unconditional.

**Where P22's schema assumptions don't hold (re-verified April 22):**

| P22 §2 assumed field | Live schema | Impact on spec |
|---|---|---|
| `node_context TEXT NOT NULL` | **Missing** | §3 queries (`WHERE node_context = $node_did`) don't execute. Node-scoped archaeology has no enforcement column. |
| `payload_hint JSONB` | **Missing** | §2.3 standing trajectory depends on this encrypted/aggregate split. Not present. |
| `issuer_type TEXT NOT NULL` | **Missing** | §5.2 human/agent/system resolver has no discriminator. Grows urgent under RFC-27 peer agents. |
| `payload` encrypted under subject key | Live is plain `jsonb('payload')` | Entire §2 "Critical: Client-Side Decryption" architecture assumes at-rest encryption that the shipped schema does not reflect. |

**The gap list is now (approximately) five, not two:**

- Gap 1 — `client_hint` (original — still missing)
- Gap 2 — `category` (original — still missing)
- **Gap 3 (new) — `node_context`** or functional equivalent for node-scoped archaeology
- **Gap 4 (new) — `payload_hint`** split for trajectory computation without decryption
- **Gap 5 (new, architectural) — encryption-model specification.** Is `payload` encrypted at rest? If not, what is the privacy story for archaeology? This is not additive; it is a decision P22 needs made before the rest of the spec can be ratified against the shipped schema.

**What has not shipped (re-verified April 22):**

Zero hits for `archaeology`, `client_hint`, `payload_hint` across upstream outside Greg's proposals. No `/api/archaeology/:did` endpoint. No migration for any of the five gaps. No archaeology UI. UI absence is expected (per Ryan's 100+ active-user threshold); schema absence is not (Ryan said *"spec now"*).

**What complicates P22 since writing:**

- **RFC-27 Multi-Agent Coordination (peer agents).** P22's five-domain view assumes human subjects and human/org/system issuers. Peer agent DIDs raise questions §5.2 doesn't answer: does an agent have its own archaeology? Does a principal's archaeology surface actions taken by their agents? Gap 5 (`issuer_type` discriminator) becomes actively blocking, not nice-to-have. Mirrors the P37/P24 conflict.
- **@imajin/bus migration (epic #759, 47 emit sites).** Attestation emissions are among the call sites being migrated (P40 safety plan). Spec'ing archaeology against the pre-bus emission path risks rewriting it after the bus lands. Anchor P22 to post-bus, like P18.
- **Bilateral attestation layer.** §5.2 individual attestation card should surface `attestationStatus` — *"pending counter-signature"* vs *"bilateral"* vs *"declined"* — and bilateral attestations need to show both `authorJws` and `witnessJws` issuers. New display concern not in original §5.2.

**Load-bearing open question for Ryan (new April 22):**

> **Is P22's encryption model (client-side subject-key decryption of `payload`, with `payload_hint` for server-side aggregates) still the target architecture — or has the shipped schema taken a different direction (transparent `payload` + bilateral JWS signing + CID content-addressing) that P22 should adapt to?**
>
> - **If P22's model is still the target:** the schema work is larger than originally scoped — at-rest encryption, `payload_hint` split, `node_context`, `issuer_type` — a real migration, not two additive columns.
> - **If the shipped schema is canonical:** P22 needs a rewrite grounded in the bilateral + CID model. "Privacy" is then provided by what's *not in* `payload` at write time, not by decryption. §2.3 trajectory re-specifies on shipped fields.
> - **If hybrid:** split P22 into (a) additive fields that can ship now (`client_hint`, `category`) and (b) architecture decision deferred.

**Scope reduction:** The schema-additive framing of the original proposal is no longer sufficient. The load-bearing question above must be answered before §2–§5 can be ratified against live code. Below this block, the proposal is preserved unchanged for lineage; the five-gap list and the architecture question are the live ask.

---

## DFOS Integration Note *(conditional — applies if Discussion #393 integration proceeds)*

The five archaeology domains in this spec draw entirely from `auth.attestations`. If Door 2 (DFOS web relay) lands, a person's DFOS content chain — posts, essays, collaborative documents, signed content operations — becomes part of their authored record and belongs naturally in the contributions domain.

The schema as specced accommodates this without changes: `context_type: 'dfos_content'`, `client_hint: { "label": "essay title", "type": "dfos_content", "icon": "dfos" }`, `category: 'contribution'`. The `client_hint` field (Gap 1 in this spec) is specifically designed to store human-readable labels for offline/cross-protocol contexts — a DFOS CID resolving to an essay title is exactly its use case.

On content addressing: Ryan has confirmed (March 20, 2026) that the current hex SHA-256 approach was expedient but not industrial-grade — *"Industry standard. Ours was made up. It worked. But wasn't industrial."* dag-cbor CIDs (issue #400) are now confirmed direction, not conditional. DFOS content entries in the archaeology view will reference CIDs. The `context_id` field is `TEXT` and holds either format without schema changes, but the attestation ingestion layer should populate CIDs for new entries once #400 lands.

---

## Executive Summary

The identity archaeology view is a user-facing interface allowing a person to query their own attestation history chronologically — to see, in legible form, the trust relationships and verified interactions that shaped their standing on the network. It is the read-side consumer of the attestation data layer.

**Schema verdict:** The current `auth.attestations` schema is 80% sufficient. Two additive gaps must be resolved before the identity archaeology view can be built as specified:
1. No `client_hint` field — human-readable context labels without requiring a live join
2. No `category` field — maps attestation types to the five archaeology domains

Both gaps are additive — no existing fields change. Ryan decides whether to add them now (cheap) or accept the join overhead later (expensive against live data).

**Why spec now:** If the schema does not support the required queries efficiently when the table has 10,000+ rows and 100+ active users, the options are slow queries or a schema migration against live data. Spec the consumer before finalizing the producer.

---

## 1. What Identity Archaeology Is and Is Not

### What It Is

A user-facing chronological record of the trust-relevant events that shaped a person's standing and relationship history on the network. Specifically: a timeline of attestations about the user, queryable by the user, decrypted client-side from the encrypted `payload` field, filtered into five human-legible domains:

1. **Relationships** — who has vouched for this person, and who they have vouched for
2. **Presence** — events attended, locations checked in, verified interactions
3. **Standing** — standing-level changes, governance participation, milestone completions
4. **Contributions** — .fair attribution records, collective work, community creative output
5. **Flags and resolutions** — negative attestations and their resolution records

The philosophical grounding (Proposal 21): autonomy requires being able to reflectively endorse the processes that shaped you. The identity archaeology view makes those processes legible to the person they concern.

### What It Is Not

- **Not a social graph exposé** — shows attestations about the querying user only; not other users' full histories
- **Not a node operator view** — operators can compute standing aggregates from `payload_hint` fields; they cannot read encrypted `payload` contents. The archaeology view gives users access to their own encrypted content — it does not elevate operator access
- **Not a cross-node view** — `node_context`-scoped; cross-node archaeology is the BaggageDID (Proposal 05)
- **Not a reputation score explainer** — shows raw attestation events; standing computation stays opaque to prevent gaming

---

## 2. Schema Analysis — The Existing `auth.attestations` Table

Current schema (from Proposal 01, partially live):

```sql
CREATE TABLE auth.attestations (
  id            TEXT PRIMARY KEY,           -- att_xxx
  issuer_did    TEXT NOT NULL,              -- who signed it
  subject_did   TEXT NOT NULL,              -- who it's about
  node_context  TEXT NOT NULL,              -- anchors to relationship root
  type          TEXT NOT NULL,              -- controlled vocabulary
  context_id    TEXT,                       -- event/org/interaction DID or ID
  context_type  TEXT,                       -- 'event'|'org'|'interaction'|'system'
  payload       JSONB DEFAULT '{}',         -- ENCRYPTED under subject_did key
  payload_hint  JSONB DEFAULT '{}',         -- unencrypted aggregate for computation
  signature     TEXT NOT NULL,              -- Ed25519 by issuer
  issued_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  issuer_type   TEXT NOT NULL DEFAULT 'human'
);
```

### Field Assessment Against Archaeology Queries

| Field | Sufficient? | Notes |
|---|---|---|
| `id` | ✅ | Primary key, cursor pagination |
| `issuer_did` | ✅ | Resolve to display name via trust graph |
| `subject_did` | ✅ | Filter: `WHERE subject_did = $user_did` |
| `node_context` | ✅ | Filter: `WHERE node_context = $node_did` |
| `type` | ✅ | Controlled vocabulary — drives domain grouping |
| `context_id` | ✅ | Links to event/org DID |
| `context_type` | ✅ | Event/org/interaction discriminator |
| `payload` | ✅ | Encrypted — client decrypts |
| `payload_hint` | ✅ | Trajectory computation — NOT returned in archaeology endpoint |
| `signature` | ✅ | Client-side verification badge |
| `issued_at` | ✅ | Timeline ordering + cursor |
| `expires_at` | ✅ | Flag status display |
| `revoked_at` | ✅ | Flag status display |
| `issuer_type` | ✅ | human/agent/system discriminator |
| `client_hint` | ❌ **MISSING** | See Gap 1 below |
| `category` | ❌ **MISSING** | See Gap 2 below |

### Gap 1: No `client_hint` Field

`context_id` stores a DID or system ID (e.g., `evt_abc123`). The archaeology view needs a human-readable label for that context without requiring a live network call to resolve the DID — especially if the originating node is offline or the user is viewing offline.

```sql
-- Proposed addition:
client_hint  JSONB DEFAULT '{}',
-- Example content:
-- { "label": "Imajin Launch Party", "type": "event", "icon": "event" }
-- { "label": "Toronto Music Collective", "type": "community", "icon": "community" }
-- { "label": "System", "type": "system", "icon": "system" }
```

Not a privacy concern — contains only what was already public at issuance time.

### Gap 2: No `category` Field

The `type` field holds the controlled vocabulary value (e.g., `event.attendance`, `vouch.given`, `flag.yellow`). The archaeology view groups these into five domains. This mapping can be computed at query time in application code, but adding `category` at write time makes queries cheaper at scale and makes the mapping explicit in the schema rather than implicit in application logic.

```sql
-- Proposed addition:
category  TEXT NOT NULL DEFAULT 'system',
-- Enum: 'relationship' | 'presence' | 'standing' | 'contribution' | 'flag' | 'system'
-- Populated at write time by the attestation ingestion layer
-- Indexed for efficient domain-filtered queries
CREATE INDEX idx_attestations_category ON auth.attestations (node_context, subject_did, category, issued_at DESC);
```

### Critical: Client-Side Decryption Architecture

The `payload` field is encrypted under the subject DID's public key at write time. This means:

- The node operator cannot read `payload` contents — they see only aggregate `payload_hint` data
- The server cannot decrypt on behalf of the user — decryption requires the user's private key, which never leaves the client
- **The identity archaeology view must be a client-side application** — it fetches encrypted attestation records and decrypts them locally using the user's keypair
- The API endpoint returns encrypted payloads — the server authenticates the requester as the `subject_did`, returns their records, and the client decrypts

This requires the user's keypair to be available in the browser session (already handled by the embedded wallet architecture, Proposal 04).

```typescript
// Identity archaeology fetch + decrypt flow:
// 1. Authenticate as subject_did (DID auth, session token)
// 2. GET /api/archaeology/:did?category=all&limit=50&before=cursor
// 3. Server: WHERE subject_did = $did AND node_context = $node
// 4. Server returns: { attestations: [{ ...fields, payload: '<encrypted>' }] }
// 5. Client: for each attestation, decrypt payload with user private key
// 6. Client renders decrypted content — payload never decrypted server-side
```

---

## 3. The Five Archaeology Domains

### Domain Mapping (canonical — hardcode in attestation ingestion layer)

| Domain | `category` value | `type` values included |
|---|---|---|
| Relationships | `relationship` | `vouch.given`, `vouch.received`, `connection.established`, `connection.severed` |
| Presence | `presence` | `event.attendance`, `checkin.verified`, `interaction.verified`, `transaction.verified` |
| Standing | `standing` | `standing.visitor`, `standing.resident`, `standing.host`, `milestone.completed`, `governance.vote`, `org.anchor` |
| Contributions | `contribution` | `fair.attribution`, `fair.payment`, `contribution.collective`, `contribution.governance` |
| Flags | `flag` | `flag.yellow`, `flag.amber`, `flag.red`, `flag.resolved`, `flag.expired`, `flag.revoked` |

### Domain 1: Relationships

The vouch graph. Vouch accountability is visible in both directions — who the user sponsored, and whether those vouches later generated standing effects.

```sql
SELECT a.*, a.client_hint
FROM auth.attestations a
WHERE a.node_context = $node_did
  AND a.subject_did  = $user_did
  AND a.category     = 'relationship'
  AND a.revoked_at   IS NULL
ORDER BY a.issued_at DESC
LIMIT $page_size OFFSET $cursor;
```

### Domain 2: Presence

The physical and verified-interaction record. Events attended, businesses checked in at, verified exchanges. Primary input to behavior-seeded declarations (event attendance tags → interest categories).

### Domain 3: Standing

The trajectory of trust standing over time. Level changes, governance participation, milestone completions, org anchor records.

**Standing trajectory query** (computes cumulative standing curve):

```sql
-- Returns ordered attestation events; application layer computes cumulative standing
SELECT a.id, a.type, a.category, a.issued_at,
       a.issuer_did, a.issuer_type, a.client_hint,
       a.payload_hint  -- aggregate only; not decrypted here
FROM auth.attestations a
WHERE a.subject_did  = $user_did
  AND a.node_context = $node_did
  AND a.category     IN ('standing', 'relationship', 'presence')
ORDER BY a.issued_at ASC;  -- ASC: build trajectory forward
```

Note: trajectory query uses `payload_hint` (unencrypted aggregates) for computation; `payload` (client-decrypted) for display details. Separation is intentional.

### Domain 4: Contributions

The creative and attribution record. .fair manifest entries, collective work, community creative output. Primary input to cross-node standing when presenting a BaggageDID — a receiving node sees a rich contributions history independent of the originating node's standing computation.

### Domain 5: Flags and Resolutions

The most sensitive domain. Specific display requirements:

- **Flags are never hidden from the user they concern**
- An expired flag (`expires_at < NOW()`) is shown as expired, not removed
- A revoked flag (`revoked_at IS NOT NULL`) is shown as revoked, with timestamp
- The user's full flag history is visible to them even if standing computation has decayed the flag's weight to zero

```sql
SELECT a.*, a.client_hint
FROM auth.attestations a
WHERE a.subject_did  = $user_did
  AND a.node_context = $node_did
  AND a.category     = 'flag'
ORDER BY a.issued_at DESC;
-- Note: no filter on revoked_at or expires_at — all flag states shown
```

This is recognition-over-endorsement at the data layer (see Proposal 23): the user sees their flag history completely, not filtered for a more flattering picture. Clarity about negative history is what makes genuine self-knowledge possible.

---

## 4. API Endpoint Specification

### Primary: `GET /api/archaeology/:did`

```
Authentication: DID session token — requester MUST be :did
  Node operators cannot call this endpoint for a user's archaeology
  even with admin credentials.

Query parameters:
  category  : 'all' | 'relationship' | 'presence' | 'standing'
              | 'contribution' | 'flag'  (default: 'all')
  limit     : integer, max 100  (default: 50)
  before    : ISO timestamp cursor for pagination
  after     : ISO timestamp cursor for date-range filtering
  include   : 'active' | 'expired' | 'revoked' | 'all'  (default: 'active')

Response:
{
  attestations: [
    {
      id:           string,
      type:         string,
      category:     string,
      issuer_did:   string,
      issuer_type:  string,
      node_context: string,
      context_id:   string | null,
      context_type: string | null,
      client_hint:  object | null,
      payload:      string,          // ENCRYPTED — client decrypts
      payload_hint: null,            // NEVER returned in archaeology endpoint
      signature:    string,
      issued_at:    string,
      expires_at:   string | null,
      revoked_at:   string | null,
    }
  ],
  cursor:     string | null,
  total:      integer,
}
```

**Security note:** `payload_hint` is explicitly `null` in the archaeology endpoint response. It contains unencrypted aggregate data used for standing computation by the node operator. Returning it here would blur the architectural distinction between the user's private record (`payload`, decrypted) and the node operator's computation inputs (`payload_hint`). These are different concerns and must not be mixed in the same endpoint.

### Secondary: `GET /api/archaeology/:did/trajectory`

```
Authentication: DID session token — requester MUST be :did

Returns ordered attestation events with payload_hint only.
Used to render the standing trajectory chart.
Does NOT return encrypted payload — only payload_hint.
Application layer computes cumulative standing from payload_hints.

Response:
{
  events: [
    {
      id:           string,
      type:         string,
      category:     string,
      issued_at:    string,
      payload_hint: object,    // unencrypted aggregate only
      client_hint:  object,
    }
  ],
  computed_standing: {
    current:   number,         // 0.0 – 1.0
    level:     string,         // 'visitor' | 'resident' | 'host'
    at:        string,
  }
}
```

The user does not need their private key to view their standing trajectory — only to read the details of individual attestations in the primary endpoint.

---

## 5. UI Specification (Deferred — Build When 100+ Active Users)

### 5.1 The Five Domain Views

| Domain | Icon | Default sort | Empty state |
|---|---|---|---|
| Relationships | 🤝 | Most recent | 'No vouches yet — your first vouch will appear here' |
| Presence | 📍 | Most recent | 'No verified presence yet — attend an event or check in' |
| Standing | ⬆️ | Chronological (oldest first — tells a story) | 'Your standing journey starts here' |
| Contributions | 🎨 | Most recent | 'No attributed contributions yet' |
| Flags | 🚩 | Most recent | 'No flags on record' |

### 5.2 Individual Attestation Card

Each attestation renders as a card with:
- **Header:** `client_hint` label or type label if no `client_hint`
- **Date:** `issued_at`, human-readable
- **Issuer:** resolved to display name if in trust graph; otherwise 'System' or abbreviated DID
- **Status:** Active / Expired / Revoked — colour-coded
- **Signature verification:** verified badge if client has validated Ed25519 signature
- **Payload content:** decrypted narrative content — visible only after client-side decryption succeeds
- **Expand/collapse:** cards collapsed by default; payload revealed on expand

Specific interaction: expand a `vouch.given` card and see, inline, any subsequent negative attestations received by the vouched person — making the vouch-accountability chain visible without a separate query.

### 5.3 The 100+ User Threshold

**Active** is defined as: a user with at least 5 attestations of at least 3 different types in the past 90 days.

Below this threshold: the endpoint exists and is queryable via API, but no UI is built. Rationale: a user with 2 attestations has no meaningful archaeology; the UI investment is justified when there is enough data to make the view genuinely informative.

When the threshold is reached, this spec is implementation-ready — no additional design work required.

---

## 6. Decisions Required from Ryan

| # | Decision | Greg's position | Status |
|---|---|---|---|
| 1 | Add `client_hint JSONB DEFAULT '{}'` to `auth.attestations` migration now? | Yes — cheap now, expensive later | Open |
| 2 | Add `category TEXT NOT NULL DEFAULT 'system'` with index now? | Yes | Open |
| 3 | Populate `client_hint` and `category` in attestation ingestion layer at write time? | Yes | Open |
| 4 | Archaeology API endpoint spec added to codebase now (even without UI)? | Yes — Ryan confirmed "spec now" | Open |
| 5 | `payload_hint: null` enforced in archaeology endpoint — confirmed in integration tests? | Yes | Open |
| 6 | Client-side payload encryption tested: write + read decryptable only with subject's private key, not server-side? | Yes | Open |

**Resolution signals in the repository:**
- `client_hint JSONB DEFAULT '{}'` column in `auth.attestations` migration
- `category TEXT NOT NULL DEFAULT 'system'` column with index in migration
- Attestation ingestion endpoint populates both at write time
- `/api/archaeology/:did` endpoint spec in codebase
- `/api/archaeology/:did/trajectory` endpoint spec in codebase
- Archaeology endpoint returns `payload_hint: null` explicitly — confirmed in integration tests

---

*The record belongs to the person it concerns.*
*— Greg, March 17, 2026*
