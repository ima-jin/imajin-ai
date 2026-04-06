# Work Order: Scope-Aware Services (#602)

**Priority:** High — blocks Mooi MVP, blocks scope switching UX
**Epic:** #602
**Estimated effort:** 1-2 days (11 services, same pattern, agent-friendly)
**Depends on:** Forest switcher ✅, requireAuth actingAs ✅, forest config ✅

---

## Problem

The forest switcher sets `X-Acting-As` and `requireAuth()` validates it, but zero services use `identity.actingAs` to filter queries. Switching scope changes nothing — you still see your own data everywhere.

---

## The Pattern

Every data-fetching route that filters by the caller's DID needs:

```typescript
const did = identity.actingAs || identity.id;
```

Write operations need an additional check: is the caller a controller of the acting-as scope with sufficient role?

```typescript
// Read: use acting-as DID if present
const did = identity.actingAs || identity.id;
const events = await db.select().from(events).where(eq(events.organizerDid, did));

// Write: verify controller role
if (identity.actingAs) {
  const controller = await db.select().from(groupControllers)
    .where(and(
      eq(groupControllers.groupDid, identity.actingAs),
      eq(groupControllers.controllerDid, identity.id),
      isNull(groupControllers.removedAt)
    )).limit(1);
  if (!controller.length) throw new Error('Not a controller of this scope');
}
```

### Helper

Consider adding to `@imajin/auth`:

```typescript
export function effectiveDid(identity: Identity): string {
  return identity.actingAs || identity.id;
}
```

---

## Execution Order

Run in priority order. Each service is an independent agent task.

### Wave 1 — Mooi Critical (run in parallel)

| # | Issue | Service | Key routes | Notes |
|---|-------|---------|------------|-------|
| 1 | #603 | events | list, create, dashboard, tickets, revenue | Organizer DID filter. Admin dashboard scoped. |
| 2 | #604 | connections | list, connect, disconnect, nicknames | DID-based queries already (#577). Swap DID. |
| 3 | #605 | pay | settlement list, ledger, revenue summary | Scope admin sees scope's money. |
| 4 | #606 | media | asset list, upload, manage | Owner DID filter. Upload as scope. |

### Wave 2 — Complete Coverage (run in parallel)

| # | Issue | Service | Key routes | Notes |
|---|-------|---------|------------|-------|
| 5 | #607 | chat | conversation list, send, members | Group DID support exists. Map acting-as. |
| 6 | #608 | market | listings, create, manage | Seller DID filter. |
| 7 | #609 | coffee | supporters, tips, page | Profile DID filter. |
| 8 | #610 | learn | courses, create, manage, enroll | Creator DID filter. |
| 9 | #611 | links | link tree, manage | Owner DID filter. |
| 10 | #612 | notify | notification list, preferences, bell | Recipient DID filter + scope preferences. |
| 11 | #613 | registry | registered apps | Owner DID filter. |

---

## Agent Prompt Template

For each service, the agent task is:

```
Issue #{number}: Make {service} scope-aware by reading identity.actingAs.

Context:
- `requireAuth()` already parses `X-Acting-As` header and attaches `identity.actingAs` to the identity object
- When `identity.actingAs` is set, all read queries should filter by it instead of `identity.id`
- Write operations should verify the caller is a controller of the acting-as scope (check `auth.group_controllers` table via auth service, or accept if actingAs is already validated by requireAuth)
- Import pattern: `const did = identity.actingAs || identity.id;`

Steps:
1. Find all API routes in apps/{service}/ that use `identity.id` for data filtering
2. Replace with `identity.actingAs || identity.id` for read operations
3. For write operations (POST/PUT/DELETE), the actingAs is already validated by requireAuth — use the effective DID
4. Test: verify that with X-Acting-As header set, the service returns scope-specific data
5. Append summary to memory/YYYY-MM-DD.md
```

---

## Verification

After each service is done:

1. Set `X-Acting-As` header to a group DID
2. Verify list endpoints return scope-specific data (not personal data)
3. Verify create endpoints set the owner/organizer to the acting-as DID
4. Verify unauthorized scopes are rejected

---

## Done When

Switching scope in the forest switcher changes what you see in every service. Ryan sees Ryan's world. Mooi sees Mooi's world. Same apps, same UI, different universe.
