# Canonical Patterns

> **Read this before writing code in a seam between primitives** (auth, settlement,
> attribution, identity, checkout). Each row is a primitive that already exists and is
> the *one* correct way to do that thing. **Do not re-implement these inline.** If the
> canonical primitive doesn't cover your case, *extend it with an option* — don't fork it.
>
> Why this file exists: the system stays coherent when every change routes through the
> canonical pattern. Inline re-implementations drift, diverge on money/identity, and show
> up as cognitive-complexity hotspots. This index is the map of foundations to copy from.

## How to use this (humans and coding agents)

1. Before writing logic at a primitive boundary, check this table for an existing primitive.
2. Import and call it. Do not paste an equivalent inline.
3. If it doesn't fit, add a parameter/option to the canonical function and document it here.
4. New canonical primitive? Add a row.

## The primitives

| Concern | Canonical primitive | Location | Do NOT |
|---------|--------------------|----------|--------|
| **App/agent auth + scope** | `requireAppAuth(request, { scope })` | `packages/auth/src/require-app-auth.ts` | Read `x-app-did` / validate scopes inline. Use the dual-path: app-DID header → `requireAppAuth`; else `requireAuth`. |
| **Session auth** | `requireAuth(request)` / `optionalAuth(request)` | `@imajin/auth` | Parse the session cookie or call `/api/session` by hand. |
| **Checkout buyer identity** | `resolveCheckoutIdentity(request, body, log, opts)` | `apps/events/src/lib/checkout-common.ts` | Reinvent soft-DID minting / profile-email backfill in a checkout route. Pass `opts.createSoftDid` for free-RSVP-style eager DID creation. |
| **Ticket reconciliation after payment** | `confirmHeldTickets(...)` | `apps/events/src/lib/confirm-payment.ts` | Flip ticket status / increment sold / emit `ticket.purchased` / send bundle email inline. |
| **Settlement (fee split → ledger/balances)** | `POST /api/settle` (and `settleReactor` via the bus) | `apps/kernel/app/pay/api/settle/route.ts`, `packages/bus/src/reactors/settle.ts` | Write `feeLedger` / `balances` rows inline. **Known debt:** the Stripe webhook still does this inline (`pay/api/webhook/route.ts`) — that is the old path, not the pattern. See #1073. |
| **.fair manifest build** | `buildFairManifest(...)` | `packages/fair` | Hand-assemble fee/chain objects. |
| **.fair manifest validate / verify / sign** | `validateManifest`, `verifyManifest`, `signManifest` | `packages/fair` | Re-implement chain validation or signature checks. |
| **Contact-email resolution / backfill** | `getContactEmail`, `backfillContactEmail` (auth store) + `backfillProfileContactEmail` (profile store) | `apps/events/src/lib/contact-email.ts`, `checkout-common.ts` | Write `UPDATE ... contact_email` ad hoc. Note: notify resolution order is **profile → auth → www**; keep both stores aligned. |
| **Rate limiting** | `rateLimit(key, limit, windowMs)`, `getClientIP` | `@imajin/config` | Hand-roll a limiter. Key by IP *and* (for abuse-sensitive flows) by email/subject. |
| **Order + tickets creation** | `createOrderWithTickets(...)`, `validateCart(...)` | `apps/events/src/lib/checkout-common.ts` | Insert orders/tickets and sold-count logic inline. |

## The rule of thumb

> If you find yourself writing logic that *feels* like it belongs to a primitive
> (money movement, identity, attribution, auth), stop and look here first. The cost
> of one more inline re-implementation isn't this function — it's the next three that
> copy it, and the day two of them disagree on a payout.

## Known divergences (tracked, not yet converged)

- **Settlement:** `POST /api/settle` is canonical, but `pay/api/webhook/route.ts` still settles Stripe payments inline (with processing-fee reconciliation that `/api/settle` lacks). Converging these is a money-path change — tracked in #1073, do not "fix" casually.
