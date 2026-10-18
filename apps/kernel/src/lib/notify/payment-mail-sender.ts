import { db, paymentRequests } from '@/src/db';
import { eq } from 'drizzle-orm';
import type { NotifySender } from './service-auth';

const PAYMENT_REQUEST_SCOPES = new Set([
  'pay:payment_request-issued',
  'pay:payment_request-paid',
  'pay:payment_request-settled',
  'pay:payment_request-voided',
  'pay:payment_request-claimed',
]);

/** Only the internal bus lane may resolve an issuer from canonical pay state. */
export async function resolvePaymentMailSender(
  input: { internal: boolean; sender: NotifySender; scope: string; to: string; data: Record<string, unknown> },
): Promise<NotifySender> {
  if (!input.internal || !PAYMENT_REQUEST_SCOPES.has(input.scope)) return input.sender;
  const id = input.data.paymentRequestId;
  if (typeof id !== 'string' || !id) return input.sender;
  const [row] = await db.select({
    issuerDid: paymentRequests.issuerDid,
    recipientDid: paymentRequests.recipientDid,
    recipientStubId: paymentRequests.recipientStubId,
  }).from(paymentRequests).where(eq(paymentRequests.id, id)).limit(1);
  if (!row || ![row.issuerDid, row.recipientDid, row.recipientStubId].includes(input.to)) return input.sender;
  return { ownerDid: row.issuerDid };
}
