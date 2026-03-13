## P5 — FairManifest Missing `intent` Field

**File:** `packages/fair/src/types.ts`
**Severity:** Missing field — RFC-05 extension not implemented
**Detected:** March 11, 2026 (surfaced by RFC-05 in `apps/www/articles/rfc-05-intent-bearing-transactions.md`)

### The Code

`FairManifest` in `packages/fair/src/types.ts` ends at line 41. No `intent` field exists.

### The Problem

RFC-05 (`rfc-05-intent-bearing-transactions.md:28–41`) specifies an `intent` extension to the `.fair` manifest schema:

```typescript
intent?: {
  purpose: 'infrastructure' | 'living' | 'grant' | 'sponsorship' | 'charitable';
  directive?: string;
  constraints?: string[];
  pool?: string;
}
```

Without this field, intent-bearing transactions and contribution pools (RFC-05) cannot be implemented. The field is optional (`?`) so its absence does not break existing manifests — but it must be added before Phase 1 of RFC-05 (intent declarations) can ship.

### Relationship to P3

P3 (missing `signature` field) and P5 (missing `intent` field) are both gaps on the same type in the same file. They should be fixed in a single PR to avoid two separate migrations of `FairManifest`. The combined fix adds:

```typescript
// To FairManifest in packages/fair/src/types.ts:
signature?: {
  algorithm: 'ed25519';
  value: string;
  publicKeyRef: string;
}
intent?: {
  purpose: 'infrastructure' | 'living' | 'grant' | 'sponsorship' | 'charitable';
  directive?: string;
  constraints?: string[];
  pool?: string;
}
```

### How to Detect Resolution in the Repo

- `packages/fair/src/types.ts` gains an `intent` field on `FairManifest`
- Ideally in the same commit as P3 (`signature` field)

### Status Update — 2026-03-13: Acknowledged, Implementation Planned

Ryan's .fair Hardening Roadmap (March 13, 2026) assigns P5 to Phase 0: `intent?` field added to `FairManifest` as optional, alongside `signature?`. Tracked under issue **#317** (.fair cryptographic signing). Phase 2-3 wires `intent` to enforcement: intent declarations logged in Phase 1, attestation-triggered in Phase 2.

Our recommendation to fix P3 + P5 in a single PR is reflected in the roadmap — both fields are Phase 0, same issue (#317). P5 is not yet resolved in code. Detection criteria above still apply.

---

## Notes on Scope

**What belongs here:** Specific, actionable code-level bugs — wrong defaults, missing fields, misplaced data, incorrect error handling. Items with a file, a line, and a fix.

**What belongs in `outstanding-concerns.md`:** Architectural questions, design decisions, unspecified features, calibration choices.

**What belongs in `current-threads/`:** Full context and proposals for resolving the architectural concerns.

Some problems here (P2, P3) have corresponding architectural threads (`identity-tier-storage.md`, `fair-attribution-automated-nodes.md`). The thread contains the full design context; this document tracks the specific code fix and its detection.
