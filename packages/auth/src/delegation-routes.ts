/**
 * Delegation-policy route registry (#2360) — the inventory, in code.
 *
 * Every owner-mutation route that goes through `enforceRoutePolicy` is listed
 * here with its class. `packages/auth/tests/delegation-policy-coverage.test.ts`
 * fails if a registered route stops calling the helper, or a route calls it
 * with a key that is not registered here. Adding a route to the policy is one
 * line here plus one `enforceRoutePolicy(...)` call in the handler.
 *
 * Keep in sync with the inventory table in docs/auth/delegation-policy.md.
 */

export type MutationClass = "reversible" | "irreversible" | "value-moving";

export interface DelegationRouteEntry {
  class: MutationClass;
  /** Action label echoed in the 403 body (`action`). */
  action: string;
  /** Owning app, e.g. "kernel". */
  app: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** Route path as served, with Next.js `[param]` segments. */
  path: string;
  /** Why it is in this class. */
  why: string;
  /**
   * Listed exception to the class rule: while set, a delegate is refused with
   * the owner-countersign 403 even though `class` would let it execute. The
   * value says when the exception can be lifted. Removing it is a one-line
   * change; the coverage test requires a call site for every entry that has it.
   */
  gatedUntil?: string;
}

export const DELEGATION_ROUTES = {
  "media.asset.delete": {
    class: "irreversible", action: "delete", app: "kernel", method: "DELETE",
    path: "/media/api/assets/[id]",
    why: "soft-deletes asset + unlinks files",
  },
  // LISTED EXCEPTION (#2360 ruling b): rename is classified `reversible` (a
  // display-name-only update since #2682), but it stays gated — a delegate gets
  // 403 AGENT_APPROVAL_REQUIRED — until the rename route records `composedBy`
  // (who actually made the change). Drop `gatedUntil` once it does.
  "media.asset.rename": {
    class: "reversible", action: "rename", app: "kernel", method: "PATCH",
    path: "/media/api/assets/[id]",
    why: "filename metadata, version-preserving",
    gatedUntil: "the rename route records composedBy",
  },
  "media.asset.transfer": {
    class: "value-moving", action: "transfer", app: "kernel", method: "POST",
    path: "/media/api/assets/[id]/transfer",
    why: "reassigns owner + .fair seller role",
  },
  "media.asset.upgrade-fair": {
    class: "irreversible", action: "upgrade-fair", app: "kernel", method: "POST",
    path: "/media/api/assets/[id]/upgrade-fair",
    why: "one-way .fair v1.0 to v1.1 upgrade, re-signed",
  },
  "media.asset.settle": {
    class: "value-moving", action: "settle", app: "kernel", method: "POST",
    path: "/media/api/assets/[id]/settle",
    why: "buyer initiates a priced settlement",
  },
  "media.asset.settle-confirm": {
    class: "value-moving", action: "settle-confirm", app: "kernel", method: "POST",
    path: "/media/api/assets/[id]/settle/confirm",
    why: "confirms payment receipt, signs receipt",
  },
  "media.asset.fair-update": {
    class: "value-moving", action: "fair-update", app: "kernel", method: "PUT",
    path: "/media/api/assets/[id]/fair",
    why: "rewrites .fair attribution and splits",
  },
  "media.asset.content-write": {
    class: "reversible", action: "content-write", app: "kernel", method: "PUT",
    path: "/media/api/assets/[id]/content",
    why: "versioned content overwrite",
  },
  "media.asset.classify": {
    class: "reversible", action: "classify", app: "kernel", method: "POST",
    path: "/media/api/assets/[id]/classify",
    why: "classification metadata",
  },
  "media.asset.folders": {
    class: "reversible", action: "folders", app: "kernel", method: "PUT",
    path: "/media/api/assets/[id]/folders",
    why: "folder membership",
  },
  "media.folder.delete": {
    class: "irreversible", action: "delete", app: "kernel", method: "DELETE",
    path: "/media/api/folders/[id]",
    why: "deletes a folder",
  },
  "media.folder.update": {
    class: "reversible", action: "update", app: "kernel", method: "PATCH",
    path: "/media/api/folders/[id]",
    why: "folder rename/move",
  },
  "media.workspace.history-grant": {
    class: "irreversible", action: "history-grant", app: "kernel", method: "POST",
    path: "/media/api/workspace/history-grant",
    why: "discloses workspace history, no revoke path yet",
  },
  "media.workspace.rollback": {
    class: "reversible", action: "rollback", app: "kernel", method: "POST",
    path: "/media/api/workspace/rollback",
    why: "moves a branch pointer, snapshots immutable",
  },
  "pay.balance.withdraw": {
    class: "value-moving", action: "withdraw", app: "kernel", method: "POST",
    path: "/pay/api/balance/withdraw",
    why: "pays out balance",
  },
  "pay.balance.withdraw-request": {
    class: "value-moving", action: "withdraw-request", app: "kernel", method: "POST",
    path: "/pay/api/balance/withdraw/request",
    why: "queues a payout",
  },
  "pay.balance.event-topup": {
    class: "value-moving", action: "event-topup", app: "kernel", method: "POST",
    path: "/pay/api/balance/event-topup",
    why: "moves money into an event balance",
  },
  "pay.balance.topup-emt": {
    class: "reversible", action: "topup-emt", app: "kernel", method: "POST",
    path: "/pay/api/topup/emt",
    why: "initiates a pending e-Transfer top-up; money only moves when the owner sends it (proposal artifact)",
  },
  "pay.balance.topup-stripe": {
    class: "reversible", action: "topup-stripe", app: "kernel", method: "POST",
    path: "/pay/api/topup/stripe",
    why: "creates a hosted Stripe Checkout session; the owner still pays with their own card (proposal artifact)",
  },
  "pay.payment-request.settle": {
    class: "value-moving", action: "settle", app: "kernel", method: "POST",
    path: "/pay/api/payment-requests/[id]/settle",
    why: "marks a payment request settled",
  },
  "pay.payment-request.void": {
    class: "irreversible", action: "void", app: "kernel", method: "POST",
    path: "/pay/api/payment-requests/[id]/void",
    why: "voids a payment request",
  },
  "pay.payment-request.checkout": {
    class: "reversible", action: "checkout", app: "kernel", method: "POST",
    path: "/pay/api/payment-requests/[id]/checkout",
    why: "creates a hosted Stripe Checkout session; the payer still pays with their own card (proposal artifact)",
  },
  "events.campaign.cancel": {
    class: "irreversible", action: "cancel", app: "events", method: "POST",
    path: "/api/campaign/[eventId]/cancel",
    why: "cancels a funding campaign",
  },
  "events.campaign.settle": {
    class: "value-moving", action: "settle", app: "events", method: "POST",
    path: "/api/campaign/[eventId]/settle",
    why: "settles a funded campaign",
  },
  "events.campaign.pledge": {
    class: "reversible", action: "pledge", app: "events", method: "POST",
    path: "/api/campaign/pledge",
    why: "creates a Stripe SetupIntent; the owner still authorises the card (proposal artifact)",
  },
  "events.campaign.pledge-confirm": {
    class: "reversible", action: "pledge-confirm", app: "events", method: "POST",
    path: "/api/campaign/pledge/confirm",
    why: "verifies a SetupIntent the owner already authorised in Stripe.js",
  },
  "events.checkout.balance": {
    class: "value-moving", action: "balance", app: "events", method: "POST",
    path: "/api/checkout/balance",
    why: "pays for tickets from balance",
  },
  "events.event.fair-update": {
    class: "value-moving", action: "fair-update", app: "events", method: "PATCH",
    path: "/api/events/[id]/fair",
    why: "rewrites event .fair splits",
  },
  "events.event.cohost-add": {
    class: "value-moving", action: "cohost-add", app: "events", method: "POST",
    path: "/api/events/[id]/cohosts",
    why: "adds a co-host (attribution share)",
  },
  "events.ticket.cancel": {
    class: "irreversible", action: "cancel", app: "events", method: "POST",
    path: "/api/events/[id]/tickets/[ticketId]/cancel",
    why: "cancels an issued ticket",
  },
  "events.ticket.refund": {
    class: "value-moving", action: "refund", app: "events", method: "POST",
    path: "/api/events/[id]/tickets/[ticketId]/refund",
    why: "refunds a ticket",
  },
  "events.ticket.mark-refund-sent": {
    class: "value-moving", action: "mark-refund-sent", app: "events", method: "POST",
    path: "/api/events/[id]/tickets/[ticketId]/mark-refund-sent",
    why: "records an off-platform refund",
  },
  "events.ticket.confirm-payment": {
    class: "value-moving", action: "confirm-payment", app: "events", method: "POST",
    path: "/api/tickets/[id]/confirm-payment",
    why: "confirms an e-Transfer, issues ticket",
  },
  "events.order.confirm-payment": {
    class: "value-moving", action: "confirm-payment", app: "events", method: "POST",
    path: "/api/orders/[id]/confirm-payment",
    why: "confirms an e-Transfer order",
  },
  "events.order.refund": {
    class: "value-moving", action: "refund", app: "events", method: "POST",
    path: "/api/orders/[id]/refund",
    why: "refunds an order",
  },
  "market.listing.purchase": {
    class: "reversible", action: "purchase", app: "market", method: "POST",
    path: "/api/listings/[id]/purchase",
    why: "starts a hosted checkout session via pay; the buyer still authorises it (proposal artifact)",
  },
  "market.listing.delete": {
    class: "irreversible", action: "delete", app: "market", method: "DELETE",
    path: "/api/listings/[id]",
    why: "deletes a listing",
  },
  "market.seller.settings": {
    class: "reversible", action: "settings", app: "market", method: "PATCH",
    path: "/api/seller/settings",
    why: "market-items visibility toggle",
  },
  "coffee.tip": {
    class: "reversible", action: "tip", app: "coffee", method: "POST",
    path: "/api/tip",
    why: "starts a hosted Stripe/Solana checkout; the payer still authorises it (proposal artifact)",
  },
  "coffee.page.delete": {
    class: "irreversible", action: "delete", app: "coffee", method: "DELETE",
    path: "/api/pages/[handle]",
    why: "deletes a page",
  },
  "dykil.survey.delete": {
    class: "irreversible", action: "delete", app: "dykil", method: "DELETE",
    path: "/api/surveys/[id]",
    why: "deletes a survey and responses",
  },
  "learn.course.delete": {
    class: "irreversible", action: "delete", app: "learn", method: "DELETE",
    path: "/api/courses/[slug]",
    why: "deletes a course",
  },
  "learn.module.delete": {
    class: "irreversible", action: "delete", app: "learn", method: "DELETE",
    path: "/api/courses/[slug]/modules/[moduleId]",
    why: "deletes a module",
  },
  "learn.lesson.delete": {
    class: "irreversible", action: "delete", app: "learn", method: "DELETE",
    path: "/api/courses/[slug]/modules/[moduleId]/lessons/[lessonId]",
    why: "deletes a lesson",
  },
  "kernel.profile.delete": {
    class: "irreversible", action: "delete", app: "kernel", method: "DELETE",
    path: "/profile/api/profile/[id]",
    why: "deletes a profile",
  },
  "kernel.registry-app.delete": {
    class: "irreversible", action: "delete", app: "kernel", method: "DELETE",
    path: "/api/registry/apps/[appId]",
    why: "deletes a registered app",
  },
  "kernel.chat.conversation.delete": {
    class: "irreversible", action: "delete", app: "kernel", method: "DELETE",
    path: "/chat/api/conversations/[id]",
    why: "deletes a conversation",
  },
  "kernel.chat.message.delete": {
    class: "irreversible", action: "delete", app: "kernel", method: "DELETE",
    path: "/chat/api/d/[did]/messages/[msgId]",
    why: "deletes a message",
  },
  "kernel.connections.connection.delete": {
    class: "irreversible", action: "delete", app: "kernel", method: "DELETE",
    path: "/connections/api/connections/[did]",
    why: "severs a connection",
  },
  "kernel.connections.pod.delete": {
    class: "irreversible", action: "delete", app: "kernel", method: "DELETE",
    path: "/connections/api/pods/[id]",
    why: "deletes a pod",
  },
  "kernel.calendar.entry.delete": {
    class: "irreversible", action: "delete", app: "kernel", method: "DELETE",
    path: "/calendar/api/entries/[id]",
    why: "deletes a calendar entry",
  },
  "kernel.corpus.source.delete": {
    class: "irreversible", action: "delete", app: "kernel", method: "DELETE",
    path: "/auth/corpus/api/source",
    why: "removes a corpus source",
  },
  "media.asset.access": {
    class: "irreversible", action: "access", app: "kernel", method: "PATCH",
    path: "/media/api/assets/[id]/access",
    why: "changing access can disclose content permanently",
  },
  "media.asset.grants": {
    class: "irreversible", action: "grants", app: "kernel", method: "PATCH",
    path: "/media/api/assets/[id]/grants",
    why: "adding grantees discloses content to new DIDs",
  },
  "media.asset.article": {
    class: "reversible", action: "article", app: "kernel", method: "PATCH",
    path: "/media/api/assets/[id]/article",
    why: "article projection metadata",
  },
  "pay.balance.transfer": {
    class: "value-moving", action: "transfer", app: "kernel", method: "POST",
    path: "/pay/api/balance/transfer",
    why: "moves balance between DIDs",
  },
  "pay.balance.gift": {
    class: "value-moving", action: "gift", app: "kernel", method: "POST",
    path: "/pay/api/balance/gift",
    why: "gifts balance to another DID",
  },
  "pay.charge": {
    class: "value-moving", action: "charge", app: "kernel", method: "POST",
    path: "/pay/api/charge",
    why: "charges the owner's balance",
  },
  "pay.escrow.create": {
    class: "value-moving", action: "create", app: "kernel", method: "POST",
    path: "/pay/api/escrow",
    why: "locks funds in escrow",
  },
  "pay.escrow.update": {
    class: "value-moving", action: "update", app: "kernel", method: "PUT",
    path: "/pay/api/escrow",
    why: "releases or refunds escrowed funds",
  },
} as const satisfies Record<string, DelegationRouteEntry>;

export type DelegationRouteKey = keyof typeof DELEGATION_ROUTES;
