import { randomUUID } from 'node:crypto';
import { send } from '@imajin/notify';
import { format as formatMoney } from '@imajin/money';
import { createLogger } from '@imajin/logger';
import type { ReactorHandler } from '../types';

const log = createLogger('bus:payment-request-notify');

/**
 * Notify reactor for the `pay.payment_request` lifecycle (#2206/#2212).
 *
 * Registered for `payment_request.issued` / `.paid` / `.settled` / `.voided`
 * / `.recipient_claimed`. A single config-driven `notify` reactor entry
 * cannot express this chain: who gets notified (recipient only vs. issuer +
 * recipient), the DID-vs-stub email-target branching (#1834/#1839), and the
 * settled copy's "who asserted" phrasing (issuer vs. kernel/Stripe, #2209)
 * all depend on reading the payment_request row and its notify-relevant
 * shape — not just the event payload. That is the "genuinely can't express
 * one of these" case #2212's acceptance criteria calls out.
 *
 * Reads only the event payload and the `pay.payment_request` row (plus a
 * best-effort issuer display name and, for a stub recipient, the plaintext
 * `connections.invites.to_email` the invite was actually sent to) — never
 * touches the payment-requests service/routes.
 *
 * Raw SQL via `@imajin/db` throughout — `packages/bus` cannot import the
 * kernel's Drizzle schema (see `packages/bus/AGENTS.md`).
 */

const ISSUED_SCOPE = 'pay:payment_request-issued';
const PAID_SCOPE = 'pay:payment_request-paid';
const SETTLED_SCOPE = 'pay:payment_request-settled';
const VOIDED_SCOPE = 'pay:payment_request-voided';
const CLAIMED_SCOPE = 'pay:payment_request-claimed';

interface PaymentRequestRow {
  issuerDid: string;
  recipientDid: string | null;
  recipientStubId: string | null;
  totalAmount: number;
  currency: string;
  kind: string;
}

/** Fetch the canonical request row — the event payload alone doesn't always carry `recipient_stub_id` (e.g. `.paid`/`.settled`). */
async function fetchPaymentRequest(id: string): Promise<PaymentRequestRow | null> {
  try {
    const { getClient } = await import('@imajin/db');
    const sql = getClient();
    const rows = await sql`
      SELECT issuer_did, recipient_did, recipient_stub_id, total_amount, currency, kind
      FROM pay.payment_request
      WHERE id = ${id}
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    const row = rows[0] as Record<string, unknown>;
    return {
      issuerDid: row.issuer_did as string,
      recipientDid: (row.recipient_did as string | null) ?? null,
      recipientStubId: (row.recipient_stub_id as string | null) ?? null,
      totalAmount: Number(row.total_amount),
      currency: row.currency as string,
      kind: row.kind as string,
    };
  } catch (err) {
    log.error({ err: String(err), paymentRequestId: id }, 'payment_request lookup failed');
    return null;
  }
}

/** Best-effort issuer display name for the "who sent this" line. Fails open to `undefined` — never blocks the notification. */
async function fetchDisplayName(did: string): Promise<string | undefined> {
  try {
    const { getClient } = await import('@imajin/db');
    const sql = getClient();
    const rows = await sql`SELECT display_name FROM profile.profiles WHERE did = ${did} LIMIT 1`;
    const name = (rows[0] as Record<string, unknown> | undefined)?.display_name;
    return typeof name === 'string' && name ? name : undefined;
  } catch (err) {
    log.warn({ err: String(err), did }, 'issuer display-name lookup failed; proceeding without it');
    return undefined;
  }
}

/**
 * The plaintext email a claimable-stub recipient's invite was actually sent
 * to (`connections.invites.to_email`) — the pre-claim stub identity itself
 * carries no recoverable email (it's HMAC/AES-sealed in `auth.claim_stub_index`,
 * #1834), but the invite row that targets it does, because the invite email
 * itself has to be deliverable. Picks the most recent invite addressed to
 * this stub DID.
 */
async function fetchStubInviteEmail(stubDid: string): Promise<string | undefined> {
  try {
    const { getClient } = await import('@imajin/db');
    const sql = getClient();
    const rows = await sql`
      SELECT to_email
      FROM connections.invites
      WHERE to_did = ${stubDid} AND to_email IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const email = (rows[0] as Record<string, unknown> | undefined)?.to_email;
    return typeof email === 'string' && email ? email : undefined;
  } catch (err) {
    log.warn({ err: String(err), stubDid }, 'stub invite-email lookup failed');
    return undefined;
  }
}

/**
 * Idempotency guard (#2212 acceptance: "replays don't double-send").
 *
 * Each of these five event types already fires at most once per real state
 * transition at the service layer (guarded CAS on `status`, "exactly ONE
 * attestation" invariants) — this table is the belt-and-suspenders backstop
 * against a `publish()` retry or duplicate reactor dispatch, not the
 * primary guarantee. Keyed on (payment_request, event_type, target) rather
 * than a bus-level event id because `BusEvent` has no such id (`correlationId`
 * is caller-optional and unset by every payment_request publish call today) —
 * that composite key already IS "this event, for this recipient" in a model
 * where each transition happens once.
 *
 * Fails OPEN (returns true — proceed) on a DB error: dropping a genuine
 * payment notification silently is worse than a rare duplicate.
 */
async function claimNotification(paymentRequestId: string, eventType: string, targetDid: string): Promise<boolean> {
  try {
    const { getClient } = await import('@imajin/db');
    const sql = getClient();
    const rows = await sql`
      INSERT INTO kernel.payment_request_notifications (id, payment_request_id, event_type, target_did)
      VALUES (${randomUUID()}, ${paymentRequestId}, ${eventType}, ${targetDid})
      ON CONFLICT (payment_request_id, event_type, target_did) DO NOTHING
      RETURNING id
    `;
    return rows.length > 0;
  } catch (err) {
    log.warn({ err: String(err), paymentRequestId, eventType, targetDid }, 'idempotency claim failed; proceeding anyway');
    return true;
  }
}

interface NotifyTargetParams {
  paymentRequestId: string;
  eventType: string;
  targetDid: string;
  isStub: boolean;
  scope: string;
  data: Record<string, unknown>;
}

/**
 * Deliver one notification to one target, honoring the dedup guard and the
 * stub-vs-DID email branching.
 *
 * For a DID recipient, `send()` goes through the existing notify service
 * unchanged — in-app + email per the recipient's own preferences (#2119).
 * For a stub, `data.email` is set explicitly so `/notify/api/send`'s
 * `resolveRecipientEmail` uses it directly rather than falling through to
 * profile/identity/credentials lookups that a pre-claim stub has no rows
 * in — an in-app push is still attempted but is a harmless no-op (no live
 * session exists for an unclaimed stub) until the recipient claims and logs
 * in, at which point the stored notification row becomes visible to them.
 * Delivery status is whatever `/notify/api/send` honestly reports (#1867) —
 * this reactor never assumes or fabricates a `sent: true`.
 */
async function notifyTarget(params: NotifyTargetParams): Promise<void> {
  const claimed = await claimNotification(params.paymentRequestId, params.eventType, params.targetDid);
  if (!claimed) {
    log.debug(
      { paymentRequestId: params.paymentRequestId, eventType: params.eventType, targetDid: params.targetDid },
      'payment_request notification already sent — skipping replay'
    );
    return;
  }

  const data: Record<string, unknown> = { ...params.data, paymentRequestId: params.paymentRequestId };

  if (params.isStub) {
    const email = await fetchStubInviteEmail(params.targetDid);
    if (!email) {
      log.warn(
        { paymentRequestId: params.paymentRequestId, targetDid: params.targetDid },
        'no invite email found for stub recipient — notification skipped'
      );
      return;
    }
    data.email = email;
    data.stub = true;
  }

  await send({ to: params.targetDid, scope: params.scope, data }).catch((err: unknown) => {
    log.error(
      { err: String(err), paymentRequestId: params.paymentRequestId, targetDid: params.targetDid, scope: params.scope },
      'payment_request notification send failed'
    );
  });
}

/** The request's recipient — a known DID, or (pre-claim) a claimable stub. Null only for a malformed row. */
function recipientTarget(request: PaymentRequestRow): { targetDid: string; isStub: boolean } | null {
  if (request.recipientDid) return { targetDid: request.recipientDid, isStub: false };
  if (request.recipientStubId) return { targetDid: request.recipientStubId, isStub: true };
  return null;
}

export const paymentRequestNotifyReactor: ReactorHandler = async (event) => {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const paymentRequestId = typeof payload.paymentRequestId === 'string' ? payload.paymentRequestId : undefined;
  if (!paymentRequestId) {
    log.warn({ eventType: event.type }, 'payment_request event missing paymentRequestId — skipping');
    return;
  }

  const request = await fetchPaymentRequest(paymentRequestId);
  if (!request) return;

  const totalFormatted = formatMoney({ amount: request.totalAmount, currency: request.currency });

  switch (event.type) {
    case 'payment_request.issued': {
      const target = recipientTarget(request);
      if (!target) return;
      const issuerName = await fetchDisplayName(request.issuerDid);
      await notifyTarget({
        paymentRequestId,
        eventType: event.type,
        targetDid: target.targetDid,
        isStub: target.isStub,
        scope: ISSUED_SCOPE,
        data: { issuerName, totalFormatted, currency: request.currency, kind: request.kind },
      });
      return;
    }

    case 'payment_request.paid': {
      await notifyTarget({
        paymentRequestId,
        eventType: event.type,
        targetDid: request.issuerDid,
        isStub: false,
        scope: PAID_SCOPE,
        data: { role: 'issuer', totalFormatted },
      });
      const target = recipientTarget(request);
      if (target) {
        await notifyTarget({
          paymentRequestId,
          eventType: event.type,
          targetDid: target.targetDid,
          isStub: target.isStub,
          scope: PAID_SCOPE,
          data: { role: 'recipient', totalFormatted },
        });
      }
      return;
    }

    case 'payment_request.settled': {
      const method = typeof payload.method === 'string' ? payload.method : 'manual';
      await notifyTarget({
        paymentRequestId,
        eventType: event.type,
        targetDid: request.issuerDid,
        isStub: false,
        scope: SETTLED_SCOPE,
        data: { role: 'issuer', totalFormatted, method },
      });
      const target = recipientTarget(request);
      if (target) {
        await notifyTarget({
          paymentRequestId,
          eventType: event.type,
          targetDid: target.targetDid,
          isStub: target.isStub,
          scope: SETTLED_SCOPE,
          data: { role: 'recipient', totalFormatted, method },
        });
      }
      return;
    }

    case 'payment_request.voided': {
      // void is only ever reachable from 'issued' (service-layer guard), so
      // a recipient always exists and was already the .issued target.
      const target = recipientTarget(request);
      if (!target) return;
      await notifyTarget({
        paymentRequestId,
        eventType: event.type,
        targetDid: target.targetDid,
        isStub: target.isStub,
        scope: VOIDED_SCOPE,
        data: { totalFormatted },
      });
      return;
    }

    case 'payment_request.recipient_claimed': {
      await notifyTarget({
        paymentRequestId,
        eventType: event.type,
        targetDid: request.issuerDid,
        isStub: false,
        scope: CLAIMED_SCOPE,
        data: {},
      });
      return;
    }

    default:
      return;
  }
};
