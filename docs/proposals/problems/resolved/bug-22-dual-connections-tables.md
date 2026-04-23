## BUG-22 — Dual Connections Tables — Active Data Split ✅ RESOLVED 2026-04-08

**Resolved:** The legacy `profile.connections` table is gone. Only `connections.connections` exists in the kernel schema (`apps/kernel/src/db/schemas/connections.ts:110`), with the supporting `nicknames` table at line 121. The kernel `profile` schema (`apps/kernel/src/db/schemas/profile.ts`) contains no `connections` table — verified via grep returning zero matches. The post-kernel-merge migration consolidated all reads/writes onto the `connections.connections` table from PR #577. Only `scripts/migrate-stable-dids.ts` references the legacy schema, as a one-time migration helper.

**File:** `apps/kernel/src/db/schemas/connections.ts` (canonical), `apps/kernel/src/db/schemas/profile.ts` (legacy table removed)
**Severity:** HIGH — data integrity risk
**Detected:** April 7, 2026
**Resolved:** April 8, 2026 (confirmed in audit)

### The Problem

Two separate `connections` tables existed:
- `connections.connections` — first-class table from #577 refactor (O(1) DID pair lookup)
- `profile.connections` — legacy table still actively queried

Both tables were written and read. There was no single source of truth.

### How it was Resolved

The kernel merge (RFC-19) consolidated database schemas under `apps/kernel/src/db/schemas/`. During consolidation, the legacy `profile.connections` table was removed; all connection logic now flows through `connections.connections`. Nicknames moved with it.

### Detection Confirmed

- `apps/kernel/src/db/schemas/profile.ts` has no `connections` table
- `apps/kernel/src/db/schemas/connections.ts` is the sole authoritative table
- Only `scripts/migrate-stable-dids.ts` references the legacy schema, as a backfill helper
