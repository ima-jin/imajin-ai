/**
 * Ticket statuses that mean "this DID holds a ticket" (#2734).
 *
 * - `valid`  — bought or given (written by checkout / confirm-payment)
 * - `sold`   — legacy vocabulary, kept until the status-vocabulary decision
 *              in docs/rearchitect/06-decisions.md is ruled (no data change)
 * - `used`   — checked in; still holds the ticket
 *
 * Never holding: `available`, `held` (unpaid reservation), `cancelled`,
 * `refunded`, `refund_pending`.
 *
 * Every reader that asks "does this DID hold a ticket?" must use this
 * constant instead of an inline status list.
 */
export const HOLDING_TICKET_STATUSES = ['valid', 'sold', 'used'] as const;

export type HoldingTicketStatus = (typeof HOLDING_TICKET_STATUSES)[number];

/** Mutable copy for APIs (drizzle `inArray`, SQL `ANY(...)`) that reject readonly tuples. */
export const holdingTicketStatuses = (): HoldingTicketStatus[] => [...HOLDING_TICKET_STATUSES];

/** True when a ticket in `status` counts as held by its owner. */
export function isHoldingTicketStatus(status: string | null | undefined): boolean {
  return (HOLDING_TICKET_STATUSES as readonly string[]).includes(status ?? '');
}
