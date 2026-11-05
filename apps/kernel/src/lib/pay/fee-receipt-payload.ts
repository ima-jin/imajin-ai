import type { FeeReceiptPayload } from '@imajin/bus';
import { feeCreditKey } from './fee-credit-key';

export const FEE_EVENT_TYPES = ['fee.record', 'fee.rebate', 'fee.surcharge'] as const;
export type FeeEventType = typeof FEE_EVENT_TYPES[number];

export function isFeeEventType(type: unknown): type is FeeEventType {
  return typeof type === 'string' && (FEE_EVENT_TYPES as readonly string[]).includes(type);
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Fee receipts are platform facts, not self-asserted money from arbitrary loop publishers. */
export function validateFeeReceipt(type: FeeEventType, payload: Record<string, unknown>, publisherDid: string): payload is FeeReceiptPayload {
  if (!process.env.PLATFORM_DID || publisherDid !== process.env.PLATFORM_DID || payload.principal !== publisherDid) return false;
  if (!['transactionId', 'recipientDid', 'role', 'currency', 'stripeEventId', 'at'].every(field => nonempty(payload[field]))) return false;
  if (!Number.isSafeInteger(payload.amountCents) || Number(payload.amountCents) < 0 || Number(payload.amountCents) > 2147483647) return false;
  if (!/^[A-Z]{3}$/.test(String(payload.currency)) || !String(payload.stripeEventId).startsWith('evt_')) return false;
  if (!Number.isFinite(Date.parse(String(payload.at)))) return false;
  if (payload.chainIndex !== undefined && (!Number.isSafeInteger(payload.chainIndex) || Number(payload.chainIndex) < 0)) return false;
  const identity = payload as unknown as FeeReceiptPayload;
  if (payload.loopId !== feeCreditKey(identity) || payload.kind !== 'pay.fee' || payload.state !== 'recorded') return false;
  const adjustment = type === 'fee.rebate' ? 'processor_rebate' : 'processor_surcharge';
  if (type !== 'fee.record' && (payload.role !== adjustment || payload.sellerDid !== payload.recipientDid)) return false;
  const status = payload.role === 'tax' ? 'held_in_trust'
    : payload.role === 'seller' || payload.role === 'processor' ? 'paid_out' : 'accrued';
  if (payload.status !== status) return false;
  if (payload.role !== 'tax') return payload.tax === undefined;
  return validTax(payload.tax);
}

function validTax(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const tax = value as Record<string, unknown>;
  return ['jurisdiction', 'kind', 'remitTo', 'registrationNumber', 'service'].every(field => nonempty(tax[field]))
    && Number.isSafeInteger(tax.rateBps) && Number(tax.rateBps) >= 0
    && (tax.buyerDid === null || nonempty(tax.buyerDid));
}
