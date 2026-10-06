/**
 * Pure e-Transfer offer logic for a payment_request (#2665) — no I/O, so the
 * pay page view (`service.ts`), the pay-in service (`emt.ts`) and the tests
 * all share one definition of "is e-Transfer on offer, and what does the
 * payer send".
 */
import type { PaymentRequest } from '@/src/db';
import type { PayInInstructions } from '../rails/types';
import { EMT_RAIL_NAME } from '../rails/emt-pay-in-rail';
import { getPayInRailForCurrency } from '../rails/registry';
import { invoiceNumberOf } from './invoice';
import type { PaymentRequestKind } from './types';

/** What the pay page needs to render the e-Transfer instructions. */
export interface EmtInstructionsView {
  /** The issuer's receiving email — shown only to a payer who chose e-Transfer. */
  email: string;
  /** Exact amount in minor units; render with `formatMinorUnits`. */
  amountMinor: number;
  currency: string;
  /** The transfer memo — unique to the request. */
  memo: string;
}

/**
 * The e-Transfer option on the pay page. `available`: offered, nothing
 * chosen yet (the instructions are fetched on demand, never rendered into
 * the page). `pending`: the payer already chose it, so the instructions are
 * shown again for anyone returning to the link.
 */
export interface EmtPayOption {
  state: 'available' | 'pending';
  instructions: EmtInstructionsView | null;
}

/**
 * The memo a payer must quote: the request's human-facing document number
 * (`INV-3F9A1C07D2`), which is already printed on the invoice, unique to the
 * request, and does not reveal the full internal id.
 */
export function emtMemoOf(request: Pick<PaymentRequest, 'kind' | 'id'>): string {
  return invoiceNumberOf(request.kind as PaymentRequestKind, request.id);
}

/**
 * The rail-neutral instructions for paying `request` into `receivingEmail`,
 * or `null` when e-Transfer can't be offered for it: no receiving email, the
 * issuer disallows on-platform payment, or the currency isn't one the rail
 * collects (e-Transfer is CAD only).
 */
export function emtInstructionsFor(
  request: Pick<PaymentRequest, 'kind' | 'id' | 'totalAmount' | 'currency' | 'allowOnPlatform'>,
  receivingEmail: string | null | undefined,
): PayInInstructions | null {
  if (!receivingEmail?.trim() || !request.allowOnPlatform) return null;
  const rail = getPayInRailForCurrency(EMT_RAIL_NAME, request.currency);
  if (!rail) return null;
  return rail.instructionsFor(
    { reference: emtMemoOf(request), amountMinor: request.totalAmount, currency: request.currency },
    receivingEmail,
  );
}

/** Rail-neutral instructions -> the pay page's / API's e-Transfer shape (`{ email, amount, memo }`, as the top-up route returns). */
export function toEmtInstructionsView(instructions: PayInInstructions): EmtInstructionsView {
  return {
    email: instructions.destination,
    amountMinor: instructions.amountMinor,
    currency: instructions.currency,
    memo: instructions.reference,
  };
}

/**
 * The e-Transfer option for the pay page, or `null` when it must not appear
 * — which is whenever the issuer has no receiving email set, or the request
 * is no longer open (settled, void), or e-Transfer can't carry it.
 */
export function emtOptionOf(
  request: Pick<PaymentRequest, 'kind' | 'id' | 'totalAmount' | 'currency' | 'allowOnPlatform' | 'status'>,
  receivingEmail: string | null | undefined,
): EmtPayOption | null {
  if (request.status !== 'issued' && request.status !== 'emt_pending') return null;
  const instructions = emtInstructionsFor(request, receivingEmail);
  if (!instructions) return null;
  return request.status === 'emt_pending'
    ? { state: 'pending', instructions: toEmtInstructionsView(instructions) }
    : { state: 'available', instructions: null };
}
