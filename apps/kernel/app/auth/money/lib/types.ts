/**
 * Client-side types for the Money tab (#2211).
 *
 * Deliberately NOT re-using `@/src/db`'s `PaymentRequest` type: its jsonb
 * columns (`lineItems`, `fairManifest`, `settlementRef`) are untyped
 * (`unknown`) at the drizzle level, so every server call site casts them
 * manually against `src/lib/pay/payment-requests/types.ts`'s shapes. These
 * mirror that same shape, but describe the JSON *as received by the
 * browser* (dates are ISO strings, not `Date`).
 */

export type PaymentRequestKind = 'invoice' | 'request';
export type PaymentRequestStatus = 'issued' | 'paid' | 'settled_manual' | 'void';

export interface PaymentRequestLineItemView {
  name: string;
  description?: string;
  /** Unit price in minor units (e.g. cents), per `packages/money`. */
  amount: number;
  quantity: number;
}

export interface FairManifestEntryView {
  did?: string;
  role: string;
  share: number;
}

export interface FairManifestView {
  version: string;
  chain: FairManifestEntryView[];
  /** The PRE-TAX subtotal (equals the row's `subtotalAmount`). */
  total: { amount: number; currency: string };
}

export interface SettlementRefView {
  method: string;
  note?: string;
  asserted_by: string;
  settled_at: string;
}

export interface PaymentRequestInviteView {
  id: string;
  code: string;
  url: string;
}

/** A `pay.payment_request` row as returned by the JSON API. */
export interface PaymentRequestRow {
  id: string;
  kind: PaymentRequestKind;
  issuerDid: string;
  payeeAccount: string;
  recipientDid: string | null;
  recipientStubId: string | null;
  lineItems: PaymentRequestLineItemView[];
  currency: string;
  /** The GRAND total the payer owes: `subtotalAmount + taxTotalAmount` (#2421). */
  totalAmount: number;
  subtotalAmount: number;
  taxTotalAmount: number;
  fairManifest: FairManifestView;
  dueAt: string | null;
  allowOnPlatform: boolean;
  status: PaymentRequestStatus;
  settlementRef: SettlementRefView | null;
  contentHash: string;
  payHandle: string;
  createdAt: string;
  updatedAt: string;
  /** Only present on the create response. */
  attestationId?: string | null;
  /** Only present on the create response, when the recipient was a fresh invite (#2210). */
  invite?: PaymentRequestInviteView;
}

/** A connection selected as the recipient in the create form. */
export interface SelectedConnection {
  did: string;
  name: string | null;
  handle: string | null;
}

/** In-progress "invite new" recipient draft in the create form. */
export interface RecipientInviteDraft {
  email: string;
  delivery: 'link' | 'email';
  note: string;
}

/**
 * One tax registration from the issuer's business profile (#2420) as a row of
 * the create form's tax section (#2421). `rate` is the editable percentage as
 * typed ("13", "9.97"); blank when there is no integer-bps default for the
 * registration — and required whenever the row is charged.
 */
export interface TaxRowDraft {
  key: string;
  jurisdiction: string;
  kind: string;
  number: string;
  included: boolean;
  rate: string;
}

/** One in-progress line item row in the create form — string-valued so inputs stay uncontrolled-input-safe while editing. */
export interface LineItemDraft {
  key: string;
  name: string;
  description: string;
  quantity: string;
  unitAmount: string;
}
