### 5. Gas Model Ceiling (Stream 2)

**From:** Historical Context §4.3, Concerns & Resolutions §3

**The concern:**
The three-tier gas model addresses graph distance well. But capital could achieve saturation of the opted-in pool through volume even without buying trust-graph position. If a well-funded business pays high gas to reach every opted-in user in a category repeatedly, volume becomes influence within a consent-based model — and the user experience degrades.

**What resolution requires:**
Either a per-recipient rate limit (not per-sender), or gas costs that scale with frequency to the same user — not just with graph distance. This keeps the consent model intact while preventing volume from functioning as a proxy for influence.

**Proposal filed (March 10):** Proposal 11 (Gas Model Ceiling — Stream 2) in `current-proposals.md` recommends frequency-scaled gas (Mechanism C) as the primary mechanism with a defined multiplier curve, plus a user-configurable sovereign rate limit overlay. Adds cluster-aware gas computation (depends on attestation layer) and .fair compliance as a gas gate.

---

