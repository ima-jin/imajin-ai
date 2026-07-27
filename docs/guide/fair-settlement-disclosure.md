# .fair Settlement Disclosure Model

> Addresses #1440. The settlement read route for supply lots at
> `GET /media/api/lots/[correlationId]/fair` — a public record that is
> layered, composable, and operator-configurable without code changes.

A `.fair` settlement manifest contains fields with very different sensitivity.
Fee rates are checkable by anyone; absolute amounts may be commercially
sensitive; party names are PII. The disclosure model lets the same route serve
a radical-transparency co-op, a private supplier, and a carbon registry — by
composing different data, not different code.

---

## The three-layer model

```
Floor  ←  Community overlay  ←  Subject gates
 (1)            (2)                  (3)
```

**Layer 1 — Floor (always disclosed)**

A fixed set of fields that constitute the *public record* of a settlement.
These can never be gated, regardless of operator or subject preference.
Any consumer can verify the floor independently without trusting the operator.

Fields: `id`, `type`, `created`, `fair`, `version`, `integrity`,
`signature`, `platformSignature`.

> "A real, signed settlement of type X occurred at T, chained to lot Y —
> verify the sig."

**Layer 2 — Community overlay (operator-configurable)**

The deployment/community sets a default release class for every non-floor
field. The overlay is stored as JSON in `registry.node_config` under key
`fair.disclosure.overlay` and loaded at request time. No code change, no
redeploy — edit the config row and the behaviour changes immediately.

When the key is absent, the **AgriFortress defaults** apply (see below).

**Layer 3 — Subject gates (subject-authored)**

The subject (the party who authored the lot manifest) can override the
community overlay per-field by writing a `_disclosure` object directly
into the signed manifest. The override can tighten *or* loosen relative
to the community default. The `_disclosure` key is co-signed with the
rest of the manifest and is never emitted in the API response.

Floor fields are pinned regardless of what either layer says.

---

## Release classes

| Class | Meaning | Response |
|---|---|---|
| `silent` | Always disclosed — public pass-through | Field present as-is |
| `on-consent` | Disclosed only when the caller has an active consent grant | Field withheld; `_withheld` entry emitted |
| `never` | Structural drop — never appears in any response | Field absent from both `manifest` and `_withheld` |

These three classes mirror the `silent` / `on-consent` / `owner-only` /
`never` tiers in the #1196 consent 2×2 and the #1221 release-gated-projection
pattern. The implementation lives in
`apps/kernel/src/lib/media/fair-disclosure-policy.ts`.

---

## AgriFortress defaults

The reference deployment ships with these defaults:

| Field | Default class | Rationale |
|---|---|---|
| `fees[].rateBps` | `silent` | Rate model is checkable — rates ≠ amounts |
| `attribution[*].did`, `.share`, `.role` | `silent` | Pseudonymous anchors; who-got-what-share, no names |
| `amount` (any `Money.amount`) | `on-consent` | Public view shows "amount present: true" |
| `attribution[*].name`, `.note` | `on-consent` | PII; the DID suffices |
| `distribution`, `transfer` | `on-consent` | Contain price sub-fields |
| `training`, `commercial`, `fees` | `silent` | Policy booleans / rates, not sensitive |
| All floor fields | `silent` | Non-negotiable |

---

## Configuring the community overlay

Write JSON to `registry.node_config` with key `fair.disclosure.overlay`
via the admin config endpoint (`PUT /api/admin/config`):

```json
{
  "key": "fair.disclosure.overlay",
  "value": {
    "fees":                  { "release": "on-consent" },
    "amount":                { "release": "never"      },
    "attribution[*].name":   { "release": "silent"     }
  }
}
```

### Deployment profiles

**Private supplier** (maximum commercial confidentiality):
```json
{
  "fees":         { "release": "on-consent" },
  "amount":       { "release": "never"      },
  "distribution": { "release": "never"      },
  "transfer":     { "release": "never"      }
}
```

**Radical-transparency co-op** (everything public by default):
```json
{
  "amount":               { "release": "silent" },
  "distribution":         { "release": "silent" },
  "transfer":             { "release": "silent" },
  "attribution[*].name":  { "release": "silent" }
}
```

**Carbon registry** (fee transparency + anonymous amounts):
```json
{
  "fees":         { "release": "silent"     },
  "distribution": { "release": "silent"     },
  "amount":       { "release": "on-consent" }
}
```

You can add any key from the `FairFieldKey` type in
`apps/kernel/src/lib/media/fair-disclosure-policy.ts`. Unknown keys in the
overlay are ignored.

---

## Subject gates

A subject can override the community overlay per-field by including a
`_disclosure` object in the lot's `.fair` manifest. The key is co-signed
and is stripped from the API response — it is never visible to callers.

```json
{
  "id": "fair_lot_001",
  "type": "settlement",
  "_disclosure": {
    "amount":               { "release": "silent"     },
    "attribution[*].name":  { "release": "on-consent" }
  },
  "signature": { ... }
}
```

Subject gates can tighten (make more restrictive) or loosen (make more
public) relative to the community overlay. Floor fields are pinned
regardless.

---

## Consent grants — unlocking on-consent fields

A caller gains access to `on-consent` fields by having an active row in
`kernel.consent_grants` with:

```sql
purpose    = 'fair.settlement.read'
subject    = <owner_did_or_lot_originating_did>
granted_to = <caller_did>           -- or '*' for wildcard
status     = 'active'
expires_at  IS NULL OR expires_at > NOW()
```

The `allowed_fields` array in the grant row determines which fields are
unlocked. Multiple grants are unioned — a narrow grant (`["amount"]`) and
a broad grant (`["distribution", "transfer"]`) together unlock all three.

The owner creates grants via the standard grant API
(`PATCH /media/api/assets/[id]/grants`) using the same `purpose` value.

---

## The API

```
GET /media/api/lots/:correlationId/fair
```

**Auth:** Optional. The route is publicly accessible without credentials.
If an `Authorization` header is present it is resolved to a DID and
consent-grant-checked. Invalid credentials degrade gracefully to the
public (redacted) view — no 401.

**Headers in response:**

| Header | Value |
|---|---|
| `X-Fair-Disclosure` | `layered` |
| `Cache-Control` | `public, max-age=60, stale-while-revalidate=300` |

### Public view (no auth, no grants)

Only floor fields and `silent` fields are present. `on-consent` fields
appear in `_withheld` as presence attestations. `never` fields are absent
from both sections.

```json
{
  "id": "fair_lot_001",
  "type": "settlement",
  "created": "2026-01-01T00:00:00Z",
  "fair": "1.1",
  "version": "1.1",
  "integrity": { "hash": "abc123def...", "size": 1024 },
  "signature": { "signer": "did:imajin:node", "alg": "ed25519", "value": "...", "signedAt": "2026-01-01T00:00:00Z" },
  "fees": [{ "role": "platform", "rateBps": 250, "fixedCents": 0 }],
  "attribution": [
    { "did": "did:imajin:alice", "role": "creator", "share": 70 },
    { "did": "did:imajin:bob",   "role": "producer", "share": 30 }
  ],
  "_withheld": {
    "distribution":        { "present": true, "attestation": "covered-by-signature" },
    "transfer":            { "present": true, "attestation": "covered-by-signature" },
    "amount":              { "present": true, "attestation": "covered-by-signature" },
    "attribution[*].name": { "present": true, "attestation": "covered-by-signature" }
  }
}
```

### With a grant for `distribution` only

```json
{
  ...,
  "distribution": {
    "reproduction": { "mode": "license" }
  },
  "_withheld": {
    "transfer":            { "present": true, "attestation": "covered-by-signature" },
    "amount":              { "present": true, "attestation": "covered-by-signature" },
    "attribution[*].name": { "present": true, "attestation": "covered-by-signature" }
  }
}
```

Note: `distribution` is included because the grant covers it, but the
nested `price.amount` is still withheld because the `amount` grant is
separate. Only the caller that holds grants for both `distribution` and
`amount` sees the full price sub-field.

### With grants for all on-consent fields

No `_withheld` key is present. The full manifest is returned.

---

## Signature-verifiability of the redacted view

The `_withheld` map is an *attestation*, not a proof. It tells the caller:

> "This field had a non-null value in the manifest that was signed by
> `signature.signer`. The signature covers the entire manifest including
> this field — verify the sig to confirm."

A consumer can independently verify the floor fields + signature without
trusting the operator's redaction. To verify that the withheld fields
are *genuinely* present and covered (not fabricated attestations), verify
the full manifest signature against the floor-only response — if the
signature is valid over the floor, the same signature covers the withheld
fields too (the manifest is signed as a unit). Full zero-knowledge proof
hardening (Merkle inclusion witnesses per field) is deferred to #1226.

---

## Not in scope here

- **ZKP hardening** (#1226): Merkle inclusion proofs so a consumer can
  cryptographically verify that a specific withheld field is covered by
  the root signature without seeing its value.
- **Subject gate signing verification**: `_disclosure` is currently
  parsed without verifying it against a separate signature; it is covered
  by the manifest signature as a whole.
- **Write path / grant UI**: owners create grants via
  `PATCH /media/api/assets/[id]/grants`.

---

See also:
[Proof Model](./proof-model.md) ·
[.fair Legal Boundaries](./fair-legal-boundaries.md) ·
[Canonical Patterns](./canonical-patterns.md)
