# BUG-20 — Missing `actingAs` in Ticket + Queue Routes ✅ RESOLVED 2026-04-21

**Resolved via:** PR #750 (scope-aware writes WO — 13 routes updated).
**Verified HEAD:** April 22, 2026 post-#750 merge.

## The Original Problem

Several event-service routes wrote records keyed on `identity.id` (the controller's personal DID) rather than `identity.actingAs || identity.id` (the group/forest DID the controller was operating on behalf of). When a user acting as a group DID purchased a ticket or joined a queue, the resulting row was attributed to the human controller, not the group.

**Original files flagged (April 7 audit):**
- `apps/events/app/api/events/[id]/my-ticket/route.ts`
- `apps/events/app/api/events/[id]/queue/route.ts`

## The Fix

PR #750 applied the canonical pattern to 13 routes across the events and kernel apps:

```ts
const did = identity.actingAs || identity.id;
```

**Verified in current upstream:**
- `apps/events/app/api/events/[id]/my-ticket/route.ts:26` — `const did = identity.actingAs || identity.id;`
- `apps/events/app/api/events/[id]/queue/route.ts:23,88,175` — same pattern applied at all three write sites.

## Why It Took This Long

`actingAs` only became a first-class session field after the April 7 forest-infrastructure sprint. Before that, the scope-aware contract didn't exist to apply. PR #750 was the cleanup pass once all 12 userspace services had been made scope-aware — it walked the kernel route tree and applied the pattern everywhere that had been missed.

## Related

- **BUG-24** (profile claim token never verified) — still open; now complicated by the RFC-27 peer-agent model. See new proposal P37.
- **C27** (actingAs cache coherence) — likely addressed in the @imajin/bus refactor (#759); validate once shipped.
