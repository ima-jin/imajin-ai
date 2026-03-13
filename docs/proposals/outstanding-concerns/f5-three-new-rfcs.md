### F5. Three New RFCs in Upstream Repo — Not Yet in Proposals (March 11 Review)

**Flagged:** March 11, 2026
**Source:** Committed in `e079b80` — `apps/www/articles/rfc-01-fair-attribution.md`, `rfc-02-distribution-contracts.md`, `rfc-05-intent-bearing-transactions.md`

Three new RFCs appeared in the upstream repo as articles since the March 10 review. All three extend the `.fair` protocol in directions not yet covered by our proposals:

- **RFC-01** (`.fair` attribution from commit history): Git-based attribution objects per merged PR; DID linking from GitHub handles; three-tier weight signals; destined to become `ADR-001`. Explicitly positioned as *"the template for .fair attribution for everything"* (`rfc-01-fair-attribution.md:13`).
- **RFC-02** (Programmable Distribution Contracts): Versioned, signed distribution contracts attached to every sovereign presence; WeR1 primitive generalized; micro-founder layer; auditable values layer; destined to become `ADR-002`.
- **RFC-05** (Intent-Bearing Transactions and Contribution Pools): `intent` field extension to `.fair` manifest; contribution pool mechanism with mandatory redistribution; Howey test analysis. **Authors: Ryan Veteze and Jin.** RFC-05 is the most complete spec; it has clear implementation phases and was co-authored by the project leads.

**Proposals filed (March 11):** Proposals 15, 16, and 17 in `current-proposals.md` address all three RFCs with analysis and Greg's positions on all open questions.

**Update (2026-03-13):** Proposals 15, 16, and 17 are now in upstream `docs/proposals/current-proposals/` alongside the RFCs (PR #282 merged March 12). The proposals are now part of the official repo record. Implementation of all three remains pending — P3 and P5 (the code-level gaps surfaced by this finding) are still open in `packages/fair/src/types.ts`.

**New problem detected:** P5 — `FairManifest` missing `intent` field (`packages/fair/src/types.ts`). Should be fixed in the same PR as P3 (missing `signature` field).

---

