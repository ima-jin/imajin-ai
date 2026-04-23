## STATUS: RESOLVED
**Resolved:** 2026-03-15
**Evidence:** Upstream main HEAD eacad35 — `packages/fair/src/types.ts` updated with `intent?: FairIntent`. Shipped alongside BUG-3 in same update per the .fair Hardening Roadmap Phase 0 plan. Issue #317 (.fair cryptographic signing).
**Outcome:** `intent?: FairIntent` added to `FairManifest` as optional field. The `FairIntent` type includes `purpose`, `directive`, `constraints`, and `pool` fields per RFC-05 spec. Phase 2–3 wiring (intent enforcement → `flag.yellow` on constraint violation, contribution pools) remains in the roadmap as Phase 3 scope.
**Implementation:** in code (field added; enforcement is Phase 3)
---

## BUG-5 — FairManifest Missing `intent` Field

**File:** `packages/fair/src/types.ts`
**Severity:** Missing field — RFC-05 extension not implemented
**Detected:** March 11, 2026 (surfaced by RFC-05 in `apps/www/articles/rfc-05-intent-bearing-transactions.md`)

### The Code (as of detection)

`FairManifest` in `packages/fair/src/types.ts` ended at line 41 with no `intent` field.

### The Problem

RFC-05 specified an `intent` extension to the `.fair` manifest schema that enables intent-bearing transactions and contribution pools. Without this field, RFC-05 Phase 1 could not ship.

### The Fix (as implemented)

Added to `packages/fair/src/types.ts`:

```typescript
export interface FairIntent {
  purpose: 'infrastructure' | 'living' | 'grant' | 'sponsorship' | 'charitable';
  directive?: string;     // human-readable statement of intended use
  constraints?: string[]; // machine-readable restrictions
  pool?: string;          // contribution pool ID if this manifest feeds a pool
}

// On FairManifest:
intent?: FairIntent;
```

Fixed in the same commit as BUG-3 — both fields shipped together per the recommendation that they be fixed in a single PR to avoid two migrations of the same type.

### Relationship to Proposal 17

The `intent` field being live means Proposal 17 (Intent-Bearing Transactions) has its core schema prerequisite satisfied. Phase 0 complete. Phases 1–3 (intent enforcement, contribution pools, mandatory redistribution) remain in the roadmap.

**Note on `purpose` vocabulary extension:** Proposal 17 identified that `"membership-investment"` should be added to the `purpose` enum for Fee Model Track 1 transactions (Proposal 20). This extension is not yet in the type — it's a Phase 3 item when contribution pools and the Fee Model are wired together.

### Status Update — 2026-03-13: Acknowledged, Implementation Planned

Ryan's .fair Hardening Roadmap (March 13, 2026) assigned BUG-5 to Phase 0 alongside BUG-3. Both shipped by March 15, 2026.
