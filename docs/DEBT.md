# Technical Debt Register

Deliberately deferred work. Each entry explains *why* it was deferred and *when* it becomes relevant.

Filter GitHub issues: `gh issue list --label tech-debt`

---

## Identity / DFOS Bridge (Phase 3)

Deferred: March 21, 2026. Phase 1+2 shipped (PR #407). Phase 3 is hardening — not needed until federation or significant user scale.

| Issue | What | Why Deferred | Revisit When |
|-------|------|-------------|--------------|
| #400 | dag-cbor content addressing | .fair already uses SHA-256 hashes. CIDs are a nicer format but don't unlock new capability yet. | When content needs to be portable across protocols (DFOS relay, IPFS) |
| ~~#401~~ | ~~Key rotation + multifactor roles~~ | Promoted — blocks multi-device auth, which is a real onboarding friction problem | N/A |
| #402 | Countersignature attestations | No attestation system is wired up yet. Can't build coexistence for something that doesn't exist. | When attestations ship as a feature |

---

*Update this file when deferring work. Delete entries when the debt is paid.*
