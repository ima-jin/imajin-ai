import { z } from 'zod';
import { isDid, isWithinClockSkew, parseSignature, type LoopPublisherSignature, type ParseResult } from './types';

const receiptPayload = z.object({
  loopId: z.string().min(1).max(2000),
  principal: z.string().refine(isDid),
  envelopeHash: z.string().regex(/^[0-9a-f]{64}$/),
  at: z.string().datetime({ offset: true }).refine(isWithinClockSkew),
}).strict();

export interface LoopReceiptRequest {
  type: 'loop.receipt';
  payload: z.infer<typeof receiptPayload>;
  publisherDid: string;
  signature: LoopPublisherSignature;
}

/** The fresh lookup is signed separately; the original envelope stays untouched. */
export function parseLoopReceiptRequest(raw: unknown): ParseResult<LoopReceiptRequest> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'request body must be an object' };
  }
  const { type, payload, publisherDid, signature } = raw as Record<string, unknown>;
  if (type !== 'loop.receipt' || !isDid(publisherDid) || !receiptPayload.safeParse(payload).success) {
    return { ok: false, error: 'Invalid signed loop receipt request' };
  }
  const parsedSignature = parseSignature(signature);
  if (!parsedSignature.ok) return parsedSignature;
  return {
    ok: true,
    value: { type, payload: payload as LoopReceiptRequest['payload'], publisherDid, signature: parsedSignature.value },
  };
}
