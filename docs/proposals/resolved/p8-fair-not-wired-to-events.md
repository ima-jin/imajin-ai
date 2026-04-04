# P8 — .fair Attribution Not Wired to Events or Transactions — RESOLVED

**Resolved:** March 30, 2026
**Upstream HEAD:** a3260d1c

## Summary of Resolution

Settlement is now fully wired to events. `settleTicketPurchase()` in `apps/events/src/lib/settle.ts` calls `POST /api/settle` on the pay service after ticket creation. The events payment webhook (`apps/events/app/api/webhook/payment/route.ts`, lines 352–370) invokes settlement with the `.fair` manifest on every successful Stripe checkout. Platform fee is deducted at 3% (via `PLATFORM_FEE_PERCENT`) before applying the attribution chain. Settlement failure is non-fatal — it does not block ticket creation.

### What Shipped
- `apps/events/src/lib/settle.ts` — `settleTicketPurchase()` function
- `apps/events/app/api/webhook/payment/route.ts` — webhook calls settlement after ticket creation
- Three-party chain: attribution recipients + platform DID
- `.fair` manifest flows from events → pay service on every ticket purchase

### Original Problem
Issue #25 (April 1 demo) listed three explicit blockers:
1. `.fair` not attached to events or transactions
2. Settlement not called from events webhook
3. Platform fee not recorded

All three are now addressed in the events settlement wiring.

### Remaining
- P9 (.fair templates not used in upload paths) remains open — template system exists but is not called from upload routes
- Platform fee rate (3% in events code) differs from RFC-19's 1% — likely event-specific vs protocol-level distinction
