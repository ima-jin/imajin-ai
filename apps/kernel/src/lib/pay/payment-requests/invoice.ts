/**
 * Pure helpers behind the printable invoice / receipt (#2661).
 *
 * The printable view lives at the same opaque `pay_handle` gate as the pay
 * page and deliberately adds only what an invoice document needs and is not
 * personal data: a document number, issue/due dates, the issuer's public
 * business address, and — once paid — the payment date plus a sanitised
 * settlement reference. It never carries a DID, the recipient, free-text
 * settlement notes, or who asserted the settlement.
 */
import { formatDueDate } from './due-date';
import type { PaymentRequestKind } from './types';

/** Hex characters of the internal id used as the human-facing document number. */
const NUMBER_ID_CHARS = 10;

const NUMBER_PREFIX: Record<PaymentRequestKind, string> = {
  invoice: 'INV',
  request: 'REQ',
};

/**
 * Stable, human-facing document number derived from the internal id
 * (`pr_<24 hex>` → `INV-3F9A1C07D2`). It identifies the document without
 * revealing the full internal id, and the opaque pay handle is never used.
 */
export function invoiceNumberOf(kind: PaymentRequestKind, id: string): string {
  const hex = id.replace(/^pr_/, '').slice(0, NUMBER_ID_CHARS).toUpperCase();
  return `${NUMBER_PREFIX[kind]}-${hex}`;
}

/** The issuer's business address, if the profile has one and it is public. Reads `metadata.location` (the field the business profile page prints) and honours a non-public `fieldVisibility.location` rule. */
export function issuerAddressOf(profile: { metadata?: unknown; fieldVisibility?: unknown } | undefined): string | null {
  const metadata = (profile?.metadata ?? {}) as Record<string, unknown>;
  const visibility = (profile?.fieldVisibility ?? {}) as Record<string, { level?: string } | undefined>;
  const level = visibility.location?.level;
  if (level && level !== 'public') return null;
  const location = metadata.location;
  if (typeof location !== 'string') return null;
  const trimmed = location.trim();
  return trimmed || null;
}

/** What the printed receipt may say about how a request was settled. */
export interface PublicSettlement {
  /** `stripe` | `manual` | `mjnx` | `emt`. */
  method: string;
  /** The rail's own reference when there is one — the Stripe PaymentIntent (else Checkout session), or the e-Transfer memo (#2665). Never the free-text note. */
  reference: string | null;
}

interface StoredSettlementRef {
  method?: unknown;
  settled_at?: unknown;
  payment_intent_id?: unknown;
  checkout_session_id?: unknown;
  reference?: unknown;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** Payment date (ISO instant) and sanitised settlement ref from a stored `settlement_ref`; both `null` for an unsettled request. */
export function publicSettlementOf(settlementRef: unknown): { paidAt: string | null; settlement: PublicSettlement | null } {
  if (!settlementRef || typeof settlementRef !== 'object') return { paidAt: null, settlement: null };
  const ref = settlementRef as StoredSettlementRef;
  const method = nonEmptyString(ref.method);
  return {
    paidAt: nonEmptyString(ref.settled_at),
    settlement: method
      ? {
          method,
          reference:
            nonEmptyString(ref.payment_intent_id) ?? nonEmptyString(ref.checkout_session_id) ?? nonEmptyString(ref.reference),
        }
      : null,
  };
}

/**
 * Render a stored instant as an unambiguous `YYYY-MM-DD` date (en-CA), read in
 * UTC exactly like due dates are (#2651) — so a due date prints as the calendar
 * date the issuer entered, and issue/payment dates don't shift with the
 * server's or viewer's zone. `''` for an unparseable value.
 */
export function formatInvoiceDate(instant: string): string {
  return formatDueDate(instant, 'en-CA');
}

/** How a rail is named on a receipt; a rail not listed prints its raw method. */
const SETTLEMENT_METHOD_LABELS: Record<string, string> = {
  emt: 'e-Transfer',
};

/** `stripe · pi_123`, `e-Transfer · INV-3F9A1C07D2`, or just `manual` when the rail has no reference of its own. */
export function settlementRefLabel(settlement: PublicSettlement): string {
  const method = SETTLEMENT_METHOD_LABELS[settlement.method] ?? settlement.method;
  return settlement.reference ? `${method} · ${settlement.reference}` : method;
}
