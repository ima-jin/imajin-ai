### F7. Architecture Doc Explicitly Contradicts P2 (March 11 Review)

**Flagged:** March 11, 2026
**Source:** `apps/www/articles/grounding-03-ARCHITECTURE.md:378`
**Informational — strengthens P2 case**

The architecture document's Schema Principles section states:

> *"No cross-service joins — services communicate via API, not shared tables."*

The `SELECT identity_tier FROM profile.profiles WHERE did = ${session.sub}` query in `apps/auth/app/api/session/route.ts:52–54` is a direct violation of this documented principle. P2 is no longer just an architectural concern raised by Greg — it is a documented violation of the project's own stated schema principles. This should be cited when raising P2 with Ryan.

---

## Resolved — For Reference

The following concerns were raised and are considered addressed. Details in `historical-context.md`.

| Concern | Resolution |
|---------|-----------|
| Presence ≠ Accountability (Unit) | Unit reframed as attention function; structural accountability lives in the stack |
| Personal AI as participation requirement | Stream 5 is additive; base economy requires no AI |
| Advertising as revenue (Stream 2) | Structural contradiction resolved by changing data model to Declared-Intent Marketplace |
| Businesses as nodes (same trust dynamics) | Org DID proposed as structurally distinct primitive with reduced privilege and mandatory transparency |
| BBS analogy at scale | Partially resolved; trust graph and portability provide structural accountability at scale |
