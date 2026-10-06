import { add as moneyAdd, type Money } from '@imajin/money';
import { parsePositiveDecimalAmount } from '@/src/lib/pay/payment-requests/money-format';
import { calendarDateToDueAt } from '@/src/lib/pay/payment-requests/due-date';
import { buildTaxFields } from './tax-form';
import type { LineItemDraft, RecipientInviteDraft, SelectedConnection, TaxRowDraft } from './types';

export interface CreateFormState {
  kind: 'invoice' | 'request';
  currency: string;
  lineItems: LineItemDraft[];
  dueAt: string;
  allowOnPlatform: boolean;
  recipientMode: 'connection' | 'invite';
  selectedConnection: SelectedConnection | null;
  invite: RecipientInviteDraft;
  /** #2421 — the "Charge tax" toggle; when off, the request body carries no tax fields at all. */
  chargeTax: boolean;
  taxRows: TaxRowDraft[];
}

export type CreateFormValidation = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

interface ParsedLineItem {
  name: string;
  description?: string;
  amount: number;
  quantity: number;
}

type LineItemsResult = { ok: true; value: ParsedLineItem[] } | { ok: false; error: string };

/** Mirrors `service.ts`'s `validateLineItem` client-side, so a bad line item is caught before the round trip. */
function validateLineItems(items: LineItemDraft[], currency: string): LineItemsResult {
  if (items.length === 0) {
    return { ok: false, error: 'Add at least one line item' };
  }
  const parsed: ParsedLineItem[] = [];
  for (const [index, item] of items.entries()) {
    if (!item.name.trim()) {
      return { ok: false, error: `Line item ${index + 1} needs a name` };
    }
    const amount = parsePositiveDecimalAmount(item.unitAmount, currency);
    if (amount === null) {
      return { ok: false, error: `Line item ${index + 1} needs a valid unit amount` };
    }
    const quantity = Number.parseInt(item.quantity, 10);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { ok: false, error: `Line item ${index + 1} needs a quantity of at least 1` };
    }
    parsed.push({
      name: item.name.trim(),
      ...(item.description.trim() ? { description: item.description.trim() } : {}),
      amount,
      quantity,
    });
  }
  return { ok: true, value: parsed };
}

/** Σ amount × quantity in minor units via `packages/money` — the pre-tax subtotal the tax is computed on. */
function sumLineItems(items: ParsedLineItem[], currency: string): number {
  let subtotal: Money = { amount: 0, currency };
  for (const item of items) {
    subtotal = moneyAdd(subtotal, { amount: item.amount * item.quantity, currency });
  }
  return subtotal.amount;
}

/** The subtotal (minor units) of the line items as currently typed, or `null` while any of them is still incomplete/invalid — for the live subtotal → tax → total preview. */
export function previewSubtotal(items: LineItemDraft[], currency: string): number | null {
  const result = validateLineItems(items, currency);
  return result.ok ? sumLineItems(result.value, currency) : null;
}

type RecipientResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/** Exactly one of `recipient_did` / `recipient_invite` — mirrors `service.ts`'s recipient XOR. */
function validateRecipient(state: CreateFormState): RecipientResult {
  if (state.recipientMode === 'connection') {
    if (!state.selectedConnection) {
      return { ok: false, error: 'Pick a connection to send this to' };
    }
    return { ok: true, value: { recipient_did: state.selectedConnection.did } };
  }

  if (!state.invite.email.trim()) {
    return { ok: false, error: 'Enter an email to invite' };
  }
  return {
    ok: true,
    value: {
      recipient_invite: {
        email: state.invite.email.trim(),
        delivery: state.invite.delivery,
        ...(state.invite.note.trim() ? { note: state.invite.note.trim() } : {}),
      },
    },
  };
}

/**
 * Validate the create-form draft state and build the `POST
 * /pay/api/payment-requests` request body. `fair_manifest` is deliberately
 * never included — the optional custom-manifest editor is out of scope
 * (#2211); the server always defaults to the single-payee manifest. With
 * "Charge tax" on (#2421) the body also carries `charge_tax`, one `taxes[]`
 * row per charged registration and the previewed subtotal/tax/total; the
 * server recomputes all of it and rejects any mismatch.
 */
export function buildCreatePaymentRequestBody(issuerDid: string, state: CreateFormState): CreateFormValidation {
  const lineItemsResult = validateLineItems(state.lineItems, state.currency);
  if (!lineItemsResult.ok) return lineItemsResult;

  const recipientResult = validateRecipient(state);
  if (!recipientResult.ok) return recipientResult;

  // The due date is a calendar date (#2651): sent as UTC midnight of the picked day, never via the local zone.
  const dueAt = state.dueAt ? calendarDateToDueAt(state.dueAt) : null;
  if (state.dueAt && dueAt === null) return { ok: false, error: 'Due date must be a valid date' };

  const subtotal = sumLineItems(lineItemsResult.value, state.currency);
  const taxResult = buildTaxFields(state.chargeTax, state.taxRows, subtotal, state.currency);
  if (!taxResult.ok) return taxResult;

  return {
    ok: true,
    body: {
      issuer_did: issuerDid,
      kind: state.kind,
      line_items: lineItemsResult.value,
      currency: state.currency,
      ...(dueAt ? { due_at: dueAt } : {}),
      allow_on_platform: state.allowOnPlatform,
      ...recipientResult.value,
      ...taxResult.value,
    },
  };
}
