import { parsePositiveDecimalAmount } from '@/src/lib/pay/payment-requests/money-format';
import type { LineItemDraft, RecipientInviteDraft, SelectedConnection } from './types';

export interface CreateFormState {
  kind: 'invoice' | 'request';
  currency: string;
  lineItems: LineItemDraft[];
  dueAt: string;
  allowOnPlatform: boolean;
  recipientMode: 'connection' | 'invite';
  selectedConnection: SelectedConnection | null;
  invite: RecipientInviteDraft;
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
 * (#2211); the server always defaults to the single-payee manifest.
 */
export function buildCreatePaymentRequestBody(issuerDid: string, state: CreateFormState): CreateFormValidation {
  const lineItemsResult = validateLineItems(state.lineItems, state.currency);
  if (!lineItemsResult.ok) return lineItemsResult;

  const recipientResult = validateRecipient(state);
  if (!recipientResult.ok) return recipientResult;

  return {
    ok: true,
    body: {
      issuer_did: issuerDid,
      kind: state.kind,
      line_items: lineItemsResult.value,
      currency: state.currency,
      ...(state.dueAt ? { due_at: new Date(state.dueAt).toISOString() } : {}),
      allow_on_platform: state.allowOnPlatform,
      ...recipientResult.value,
    },
  };
}
