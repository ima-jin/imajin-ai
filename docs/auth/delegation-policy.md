# Delegation policy for owner-mutation routes (#2360)

One rule, one helper, applied to every owner-mutation route. Ruled blanket (not per-route) on 2026-09-24; the 3-class table below is ratified (ruling b), with the listed exception for media rename described under [Listed exceptions](#listed-exceptions).

## The rule

A *delegate* is a registered agent acting under `X-Acting-For` (`Identity.actingFor`). The *owner* is the DID it acts for. `actingFor` is only ever set after the grants-first delegation check (`resolveAgentDelegationAuthority`), so "an active grant" is already established when a route sees it.

- **reversible** — metadata the owner can undo (folder move, versioned content overwrite, classify, article projection) and *payment initiation* (see below). A delegate **may execute** these, except the [listed exceptions](#listed-exceptions).
- **irreversible** — destroys or discloses something that cannot be taken back (delete, `.fair` upgrade, widening access/grants, history disclosure).
- **value-moving** — moves money, ownership or attribution (transfer, settle, pay-out, refund, `.fair` split edits, balance moves).

`irreversible` and `value-moving` require the **owner's own countersign**: a delegate may *propose*, never *execute*. The refusal is `403` with `code: "AGENT_APPROVAL_REQUIRED"` and enough for the owner to re-issue the call from their own session:

```json
{ "error": "...", "code": "AGENT_APPROVAL_REQUIRED", "action": "transfer",
  "class": "value-moving", "resourceId": "asset_...", "ownerDid": "did:imajin:owner",
  "delegateDid": "did:imajin:agent" }
```

**Payment initiation is a proposal, not an execution.** A route that only creates a hosted checkout session / SetupIntent / pending e-Transfer instruction does not move value: the payer must still authorise it with their own card or bank. The checkout link *is* the agent's proposal, so those routes are `reversible` (still registered, so the classification is explicit and tested). A route that itself debits, credits, reassigns or releases value is `value-moving`.

Not governed here (separate authority models, left untouched): group impersonation (`actingAs`), scoped app-tokens (`media:write`, `wallet:write` — the token `sub` *is* the owner), and the delegation-grants system itself.

## How it is applied

- `packages/auth/src/delegation-policy.ts` — `enforceRoutePolicy(source, key, { resourceId, headers })` returns a ready `403` `Response` or `null`. `source` is an `Identity`, or a `resolveEffectiveDid` result (delegate = `composedBy` set), or `null` (app-token path). Standalone subpath export `@imajin/auth/delegation-policy`, so tests that mock the `@imajin/auth` root are unaffected.
- `packages/auth/src/delegation-routes.ts` — `DELEGATION_ROUTES`, the registry: key → class, action, method, path, rationale. This is the inventory in code.
- `apps/kernel/src/lib/media/require-media-auth.ts` — `mediaDelegationGate`, the media-route adapter (keeps the historical `assetId` field in the body).
- `packages/auth/tests/delegation-policy-coverage.test.ts` — fails if a registered route stops calling the helper, a call names an unregistered key, or two handlers share a key.

To put a route under the policy: add a line to `DELEGATION_ROUTES` and one `enforceRoutePolicy(...)` call right after the route resolves the caller's identity. `reversible` routes are registered (so the classification is explicit and a later flip is a one-line change) but make no call — there is nothing to enforce; the coverage test makes the call mandatory the moment a route is flipped to `irreversible` / `value-moving`. The one exception is `PATCH /media/api/assets/[id]` (rename), a [listed exception](#listed-exceptions): its registry entry carries `gatedUntil`, so it keeps its adapter call and a delegate is refused.

## Listed exceptions

A route can be classified `reversible` yet stay gated for delegates. Its registry entry carries `gatedUntil` (the condition that lifts the gate); `enforceRoutePolicy` then refuses a delegate with the same `403 AGENT_APPROVAL_REQUIRED`, the body keeps `class: "reversible"` and adds `gatedUntil`, and the coverage test requires the route to call the helper. The reversible class still applies, unchanged, to every other route in it.

- **`PATCH /media/api/assets/[id]` (rename, `media.asset.rename`)** — ruled (b): classified `reversible` (since #2682 it only updates the `filename` display-name column), but it **stays gated — a delegate gets 403 — until the rename route records `composedBy`** (attribution of who made the change). Lifting it is: record `composedBy` in the route, delete `gatedUntil` from the registry entry, update the tests.

## Accepted interim

Ruling a: `POST /pay/api/balance/withdraw` and `POST /pay/api/payment-requests/[id]/settle` stay owner-only (403 for delegates). This supersedes the earlier #2190 / #2665 delegate paths and is the accepted interim state; no change is planned here.

## Inventory

Every owner-mutation route reviewed across `apps/kernel` and the userspace services (`events`; `learn`, `coffee`, `market` and `dykil` were reviewed too, until they left this repo in #2503, #2500, #2512 and #2523 — their `learn.course.delete`, `learn.module.delete`, `learn.lesson.delete`, `coffee.page.delete`, `coffee.tip`, `market.listing.purchase`, `market.listing.delete`, `market.seller.settings` and `dykil.survey.delete` entries went with them, since this registry only lists routes whose handlers live here). "Prior gate" is what existed before this change.

| Route | Irreversible? | Money / attribution? | Prior gate | Class | Key — why |
| --- | --- | --- | --- | --- | --- |
| `POST /api/campaign/[eventId]/settle` (events) | yes | yes | none | **value-moving** | `events.campaign.settle` — settles a funded campaign |
| `POST /api/checkout/balance` (events) | yes | yes | none | **value-moving** | `events.checkout.balance` — pays for tickets from balance |
| `POST /api/events/[id]/cohosts` (events) | yes | yes | none | **value-moving** | `events.event.cohost-add` — adds a co-host (attribution share) |
| `PATCH /api/events/[id]/fair` (events) | yes | yes | none | **value-moving** | `events.event.fair-update` — rewrites event .fair splits |
| `POST /api/orders/[id]/confirm-payment` (events) | yes | yes | none | **value-moving** | `events.order.confirm-payment` — confirms an e-Transfer order |
| `POST /api/orders/[id]/refund` (events) | yes | yes | none | **value-moving** | `events.order.refund` — refunds an order |
| `POST /api/tickets/[id]/confirm-payment` (events) | yes | yes | none | **value-moving** | `events.ticket.confirm-payment` — confirms an e-Transfer, issues ticket |
| `POST /api/events/[id]/tickets/[ticketId]/mark-refund-sent` (events) | yes | yes | none | **value-moving** | `events.ticket.mark-refund-sent` — records an off-platform refund |
| `POST /api/events/[id]/tickets/[ticketId]/refund` (events) | yes | yes | none | **value-moving** | `events.ticket.refund` — refunds a ticket |
| `PUT /media/api/assets/[id]/fair` (kernel) | yes | yes | none | **value-moving** | `media.asset.fair-update` — rewrites .fair attribution and splits |
| `POST /media/api/assets/[id]/settle` (kernel) | yes | yes | none | **value-moving** | `media.asset.settle` — buyer initiates a priced settlement |
| `POST /media/api/assets/[id]/settle/confirm` (kernel) | yes | yes | none | **value-moving** | `media.asset.settle-confirm` — confirms payment receipt, signs receipt |
| `POST /media/api/assets/[id]/transfer` (kernel) | yes | yes | none | **value-moving** | `media.asset.transfer` — reassigns owner + .fair seller role |
| `POST /pay/api/balance/event-topup` (kernel) | yes | yes | none | **value-moving** | `pay.balance.event-topup` — moves money into an event balance |
| `POST /pay/api/balance/gift` (kernel) | yes | yes | none | **value-moving** | `pay.balance.gift` — gifts balance to another DID |
| `POST /pay/api/balance/transfer` (kernel) | yes | yes | none | **value-moving** | `pay.balance.transfer` — moves balance between DIDs |
| `POST /pay/api/balance/withdraw` (kernel) | yes | yes | none | **value-moving** | `pay.balance.withdraw` — pays out balance |
| `POST /pay/api/balance/withdraw/request` (kernel) | yes | yes | none | **value-moving** | `pay.balance.withdraw-request` — queues a payout |
| `POST /pay/api/charge` (kernel) | yes | yes | none | **value-moving** | `pay.charge` — charges the owner's balance |
| `POST /pay/api/escrow` (kernel) | yes | yes | none | **value-moving** | `pay.escrow.create` — locks funds in escrow |
| `PUT /pay/api/escrow` (kernel) | yes | yes | none | **value-moving** | `pay.escrow.update` — releases or refunds escrowed funds |
| `POST /pay/api/payment-requests/[id]/settle` (kernel) | yes | yes | none | **value-moving** | `pay.payment-request.settle` — marks a payment request settled |
| `POST /api/campaign/[eventId]/cancel` (events) | yes | no | none | **irreversible** | `events.campaign.cancel` — cancels a funding campaign |
| `POST /api/events/[id]/tickets/[ticketId]/cancel` (events) | yes | no | none | **irreversible** | `events.ticket.cancel` — cancels an issued ticket |
| `DELETE /calendar/api/entries/[id]` (kernel) | yes | no | none | **irreversible** | `kernel.calendar.entry.delete` — deletes a calendar entry |
| `DELETE /chat/api/conversations/[id]` (kernel) | yes | no | none | **irreversible** | `kernel.chat.conversation.delete` — deletes a conversation |
| `DELETE /chat/api/d/[did]/messages/[msgId]` (kernel) | yes | no | none | **irreversible** | `kernel.chat.message.delete` — deletes a message |
| `DELETE /connections/api/connections/[did]` (kernel) | yes | no | none | **irreversible** | `kernel.connections.connection.delete` — severs a connection |
| `DELETE /connections/api/pods/[id]` (kernel) | yes | no | none | **irreversible** | `kernel.connections.pod.delete` — deletes a pod |
| `DELETE /auth/corpus/api/source` (kernel) | yes | no | none | **irreversible** | `kernel.corpus.source.delete` — removes a corpus source |
| `DELETE /profile/api/profile/[id]` (kernel) | yes | no | none | **irreversible** | `kernel.profile.delete` — deletes a profile |
| `DELETE /api/registry/apps/[appId]` (kernel) | yes | no | none | **irreversible** | `kernel.registry-app.delete` — deletes a registered app |
| `PATCH /media/api/assets/[id]/access` (kernel) | yes | no | none | **irreversible** | `media.asset.access` — changing access can disclose content permanently |
| `DELETE /media/api/assets/[id]` (kernel) | yes | no | `AGENT_APPROVAL_REQUIRED` | **irreversible** | `media.asset.delete` — soft-deletes asset + unlinks files |
| `PATCH /media/api/assets/[id]/grants` (kernel) | yes | no | none | **irreversible** | `media.asset.grants` — adding grantees discloses content to new DIDs |
| `POST /media/api/assets/[id]/upgrade-fair` (kernel) | yes | no | none | **irreversible** | `media.asset.upgrade-fair` — one-way .fair v1.0 to v1.1 upgrade, re-signed |
| `DELETE /media/api/folders/[id]` (kernel) | yes | no | none | **irreversible** | `media.folder.delete` — deletes a folder |
| `POST /media/api/workspace/history-grant` (kernel) | yes | no | none | **irreversible** | `media.workspace.history-grant` — discloses workspace history, no revoke path yet |
| `POST /pay/api/payment-requests/[id]/void` (kernel) | yes | no | none | **irreversible** | `pay.payment-request.void` — voids a payment request |
| `POST /api/campaign/pledge` (events) | no | initiates only | none | **reversible** | `events.campaign.pledge` — creates a Stripe SetupIntent; the owner still authorises the card (proposal artifact) |
| `POST /api/campaign/pledge/confirm` (events) | no | initiates only | none | **reversible** | `events.campaign.pledge-confirm` — verifies a SetupIntent the owner already authorised in Stripe.js |
| `PATCH /media/api/assets/[id]/article` (kernel) | no | no | none | **reversible** | `media.asset.article` — article projection metadata |
| `POST /media/api/assets/[id]/classify` (kernel) | no | no | none | **reversible** | `media.asset.classify` — classification metadata |
| `PUT /media/api/assets/[id]/content` (kernel) | no | no | none | **reversible** | `media.asset.content-write` — versioned content overwrite |
| `PUT /media/api/assets/[id]/folders` (kernel) | no | no | none | **reversible** | `media.asset.folders` — folder membership |
| `PATCH /media/api/assets/[id]` (kernel) | no | no | `AGENT_APPROVAL_REQUIRED` | **reversible** (listed exception: gated until `composedBy` is recorded) | `media.asset.rename` — filename metadata, version-preserving |
| `PATCH /media/api/folders/[id]` (kernel) | no | no | none | **reversible** | `media.folder.update` — folder rename/move |
| `POST /media/api/workspace/rollback` (kernel) | no | no | none | **reversible** | `media.workspace.rollback` — moves a branch pointer, snapshots immutable |
| `POST /pay/api/topup/emt` (kernel) | no | initiates only | none | **reversible** | `pay.balance.topup-emt` — initiates a pending e-Transfer top-up; money only moves when the owner sends it (proposal artifact) |
| `POST /pay/api/topup/stripe` (kernel) | no | initiates only | none | **reversible** | `pay.balance.topup-stripe` — creates a hosted Stripe Checkout session; the owner still pays with their own card (proposal artifact) |
| `POST /pay/api/payment-requests/[id]/checkout` (kernel) | no | initiates only | none | **reversible** | `pay.payment-request.checkout` — creates a hosted Stripe Checkout session; the payer still pays with their own card (proposal artifact) |

### Reviewed, deliberately not registered

- **Already self-only** (refuse `actingFor` outright): `POST /auth/api/grants`, `POST /auth/api/agents/provision`, `/auth/api/identity/[did]/agents`, `/auth/api/apps`, the `/jin` operator-approval and vault-proposal rails (`isUnderActAs`).
- **Creation / communication on the owner's behalf** — the intended agent use: `POST` create routes (assets, folders, pages, surveys, events, courses, listings), chat/message send and edit, reactions, calendar entry create/update, availability, connections invites, notifications read, usage/receipts emit.
- **Machine-to-machine, no owner delegate**: webhooks (`quickbooks`, `google`, `events/webhook/payment`), `infer/*`, `usage/*` emitters, `registry/api/bump/*`, admin routes (own `requireAdmin`).
- **Authority-shrinking**: `POST /api/auth/revoke`, `DELETE /api/broker/consent/[id]`, grant `ack` — a delegate withdrawing access cannot hurt the owner and the owner can re-grant.
- **Config pointers**, re-settable: `PUT/DELETE /warp/api/environment`, `/local/api/settings`, notification preferences, profile contact-visibility.
- **Considered, left for a follow-up ruling**: `PATCH /events/[id]` / `PUT` (event metadata incl. status), `events/.../tiers`, `.../invites`, `.../message` (outbound email), `DELETE` group/member routes under `connections/api/groups` (session-cookie auth, no actingFor path today), `checkout/free`, `checkout/etransfer`, and learn's enroll route (now in ima-jin/learn, #2503).

## DECISION cards

- `DECISION · rename delegate-executable · PATCH /media/api/assets/[id] was gated for agents (#1543); the proposed rule makes reversible PATCH delegate-executable · options a) follow the rule, b) keep rename gated as an exception · rec: a`. **Ruled (b):** the 3-class table is ratified, but rename stays gated (delegate gets 403) as a listed exception until the rename route records `composedBy`. `AssetFilename.tsx` copy ("agents cannot rename") is accurate for that code path.
- `DECISION · access/grants PATCH class · changing `access` or asset grants can disclose content that can never be un-disclosed · options a) irreversible (gated) b) reversible metadata · rec: a — disclosure is the irreversible part`. Implemented as (a).
- `DECISION · .fair PUT class · PUT /media/api/assets/[id]/fair rewrites attribution and splits that drive later settlements · options a) value-moving (gated) b) reversible metadata · rec: a — it is attribution-affecting even though the manifest can be rewritten`. Implemented as (a).
- `DECISION · payment initiation · hosted-checkout / SetupIntent / pending-EMT routes (topup, payment-request checkout, pledge, tip, market purchase) · options a) reversible: the checkout link is the proposal, payer authorises downstream b) value-moving: delegate may not even start a payment · rec: a — gating (b) would stop an agent from handing the owner a pay link, which is the proposal flow`. Implemented as (a).
- `DECISION · supersedes #2190 / #2665 delegate paths · POST /pay/api/balance/withdraw (destination pinned to the principal's own connected account, #2190) and POST /pay/api/payment-requests/[id]/settle (#2665) previously executed for an actingFor delegate · options a) value-moving: owner must countersign b) exempt: destination/issuer check is enough · rec: a — the ruling is blanket and "settle"/pay-out are named value-moving`. Implemented as (a); the two tests that encoded the delegate path now assert the refusal. Ruled: the 403s are the accepted interim (see above).
- `DECISION · actingAs and app-tokens · group impersonation (actingAs) and scoped app-tokens are not governed by this rule · options a) leave (separate authority models) b) extend the gate to actingAs · rec: a — a group controller is a human principal, and app-tokens are explicit owner-granted scopes`. Implemented as (a).
