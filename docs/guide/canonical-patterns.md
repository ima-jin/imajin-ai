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
| **App/agent auth + scope** | `requireAppAuth(request, { scope })` | `packages/auth/src/require-app-auth.ts` | Read `x-app-did` / validate scopes inline. Use the dual-path: app-DID header → `requireAppAuth`; else `requireAuth`. Accepts both user-delegated (`app+jwt`) and session-less service (`app-service+jwt`) tokens — see the next row for the latter. |
| **Session-less service credential (machine-to-machine reads)** | `POST /auth/api/apps/token/service` to mint, `requireAppAuth(request, { scope })` to gate | `apps/kernel/app/auth/api/apps/token/service/route.ts`, [service-credentials.md](./service-credentials.md) | Borrow a human's attestation/session for a webhook, cron, or other automated caller. A registered app proves possession of its own keypair and gets a token attributed to its own DID (`userDid: ''`, `isServiceToken: true`) — never a borrowed human identity. |
| **Session auth** | `requireAuth(request)` / `optionalAuth(request)` | `@imajin/auth` | Parse the session cookie or call `/api/session` by hand. |
| **Checkout buyer identity** | `resolveCheckoutIdentity(request, body, log, opts)` | `apps/events/src/lib/checkout-common.ts` | Reinvent soft-DID minting / profile-email backfill in a checkout route. Pass `opts.createSoftDid` for free-RSVP-style eager DID creation. |
| **Ticket reconciliation after payment** | `confirmHeldTickets(...)` | `apps/events/src/lib/confirm-payment.ts` | Flip ticket status / increment sold / emit `ticket.purchased` / send bundle email inline. |
| **Settlement (fee split → ledger/balances)** | `settlePayment()`, called by `POST /api/settle` (and `settleReactor` via the bus) | `apps/kernel/src/lib/pay/settle-core.ts`, `apps/kernel/app/pay/api/settle/route.ts`, `packages/bus/src/reactors/settle.ts` | Write `feeLedger` / `balances` rows inline. **Known debt:** the Stripe webhook still credits `feeLedger`/`balanceRollups` inline (`pay/api/webhook/route.ts`) via a different manifest shape — it now shares `settlePayment()`'s signature-verification primitive (non-blocking), but not its crediting mechanics. See #1073 and "Known divergences" below. |
| **.fair manifest build** | `buildFairManifest(...)` | `packages/fair` | Hand-assemble fee/chain objects. |
| **.fair manifest validate / verify / sign** | `validateManifest`, `verifyManifest`, `signManifest` | `packages/fair` | Re-implement chain validation or signature checks. |
| **.fair settlement field disclosure** | `composeEffectivePolicy(communityOverlay, subjectGates)` + `applyDisclosureGates(manifest, policy, grantedFields)` | `apps/kernel/src/lib/media/fair-disclosure-policy.ts` | Hard-code which `.fair` fields to include/exclude in a route. Use the three-layer model (floor → community overlay → subject gates) and query `kernel.consent_grants` for `on-consent` fields. Overlay is data: set `fair.disclosure.overlay` in `nodeConfig`. See [fair-settlement-disclosure.md](./fair-settlement-disclosure.md). |
| **Contact-email resolution / backfill** | `getContactEmail`, `backfillContactEmail` (auth store) + `backfillProfileContactEmail` (profile store) | `apps/events/src/lib/contact-email.ts`, `checkout-common.ts` | Write `UPDATE ... contact_email` ad hoc. Note: notify resolution order is **profile → auth → www**; keep both stores aligned. |
| **Rate limiting** | `rateLimit(key, limit, windowMs)`, `getClientIP` | `@imajin/config` | Hand-roll a limiter. Key by IP *and* (for abuse-sensitive flows) by email/subject. |
| **Order + tickets creation** | `createOrderWithTickets(...)`, `validateCart(...)` | `apps/events/src/lib/checkout-common.ts` | Insert orders/tickets and sold-count logic inline. |

## Connector lifecycle and app-facing invocation

Apps witness and invoke; profiles own connector lifecycle. A vertical app must not implement connector selection, OAuth, token-paste, token storage, or credential refresh. The user connects a provider on their Imajin profile once, then apps call kernel app-auth routes with the user's consent.

Use `GET /connections/api/connectors/status` with the `connectors:read-status` app scope to render live connected-service state. The response is only `{ id, connected, scopes }[]`; it never includes token, config, or secret fields. For actions, call the connector/domain route with the existing connector scope, such as `quickbooks:write`; the route resolves app-auth `userDid`, unseals the user's profile-owned token server-side, and returns only action output.

## The rule of thumb

> If you find yourself writing logic that *feels* like it belongs to a primitive
> (money movement, identity, attribution, auth), stop and look here first. The cost
> of one more inline re-implementation isn't this function — it's the next three that
> copy it, and the day two of them disagree on a payout.

## Known divergences (tracked, not yet converged)

- **Settlement:** `POST /api/settle` delegates to the shared `settlePayment()` primitive (`apps/kernel/src/lib/pay/settle-core.ts`, #1073). `pay/api/webhook/route.ts` still settles Stripe payments inline via a structurally different `.fair` manifest shape (fractional shares of a checkout total, credited to `feeLedger`/`balanceRollups` — vs. canonical's absolute-dollar chain credited to `balances`/`transactions`), including processing-fee reconciliation that `/api/settle` lacks. That ledger/crediting split is intentional, not an oversight: `feeLedger`/`balanceRollups` are read by other systems (e.g. QuickBooks export, transaction history), so rerouting the webhook's money-crediting through the canonical dollar-chain primitive would be an uncontrolled behavior change, not a refactor.
  What #1073 DID converge: both paths now share `settlePayment()`'s manifest-signature-verification primitive (`verifySettlementSignature`). The webhook gates on it non-blockingly — an absent/invalid signature never stops settlement (Stripe already collected the money) but now emits a durable `settlement.manifest.unverified` attestation instead of the prior silent no-check-at-all behavior. Full monetary-mechanics unification remains explicit follow-up work, not done here.
