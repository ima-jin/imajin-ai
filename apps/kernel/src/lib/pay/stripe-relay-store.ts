/**
 * In-process handoff between the pay webhook ingress and its bus consumer
 * (#2177).
 *
 * The pay webhook routes verify a delivery's signature and then republish it
 * onto the #1785 connector bus as a `stripe.*` event; the `pay-stripe` reactor
 * (`stripe-bus-consumer.ts`) consumes it. The verified Stripe event itself is
 * deliberately NOT carried in the bus payload: bus payloads for these types
 * are durably persisted (`kernel.event_subscription_log`) and fanned out to
 * grant-bound subscribers, and a raw Stripe object carries customer PII
 * (emails, names, addresses). The payload instead carries only non-sensitive
 * facts (ids, amount, currency) plus an opaque `relayId`, and the raw event
 * stays in this per-process map for exactly the duration of the awaited
 * `publish()` call.
 *
 * The entry also doubles as the result channel. `publish()` catches and logs
 * every reactor error (even for an awaited reactor), so a failing handler
 * cannot surface through `publish()` itself — yet the webhook route MUST
 * still answer non-2xx for a failed delivery so Stripe retries it. The
 * consumer therefore records `handled` / `error` here, and the relay reads
 * them back after `publish()` returns.
 */

import type { StripeRelaySource } from '@imajin/bus';

export type { StripeRelaySource };

export interface StripeRelayEntry {
  /** Which webhook endpoint (and therefore which signing secret) verified this delivery. */
  source: StripeRelaySource;
  /** The full verified Stripe event (`{ id, type, data: { object }, account? }`). */
  stripeEvent: unknown;
  /** Set by the consumer once its handler finished without throwing. */
  handled: boolean;
  /** Set by the consumer when its handler threw. */
  error?: string;
}

const entries = new Map<string, StripeRelayEntry>();

/** Register a verified event for hand-off; returns the entry so the caller can read the outcome. */
export function putRelayEntry(relayId: string, source: StripeRelaySource, stripeEvent: unknown): StripeRelayEntry {
  const entry: StripeRelayEntry = { source, stripeEvent, handled: false };
  entries.set(relayId, entry);
  return entry;
}

/** Look up a pending entry. `undefined` for any event not relayed by the pay webhook ingress (e.g. a BYO-connector event). */
export function getRelayEntry(relayId: string): StripeRelayEntry | undefined {
  return entries.get(relayId);
}

/** Drop an entry once the relay has read its outcome. */
export function deleteRelayEntry(relayId: string): void {
  entries.delete(relayId);
}
