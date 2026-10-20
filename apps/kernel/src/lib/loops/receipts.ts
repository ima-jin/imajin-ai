import { getClient } from '@imajin/db';
import { createLogger } from '@imajin/logger';
import { authorizeLoopPublisher } from './authorize-publisher';
import { verifyLoopPublisherSignature } from './verify-publisher-signature';
import type { LoopReceiptRequest } from './receipt-types';

const log = createLogger('kernel:loop-receipts');

export type LoopReceiptResult =
  | { status: 'accepted'; eventId: string }
  | { status: 'not_found' }
  | { status: 'error'; error: string; httpStatus: 400 | 500 };

/** No session, harness or upstream read: only this signer's durable history. */
export async function lookupLoopReceipt(request: LoopReceiptRequest): Promise<LoopReceiptResult> {
  const { type, payload, publisherDid, signature } = request;
  try {
    const verification = await verifyLoopPublisherSignature(publisherDid, { type, payload }, signature);
    if (!verification.ok) return { status: 'error', error: verification.error, httpStatus: 400 };
    const authorization = await authorizeLoopPublisher(publisherDid, payload.principal);
    // Denied scope and an absent/foreign hash have the same non-disclosing result.
    if (!authorization.authorized) return { status: 'not_found' };
    const sql = getClient();
    const rows = await sql`
      SELECT e.id FROM kernel.loop_events e
      INNER JOIN kernel.loops l ON l.loop_id = e.loop_id AND l.principal = e.principal
      WHERE e.id = ${`signed-loop:${payload.envelopeHash}`}
        AND e.loop_id = ${payload.loopId} AND e.principal = ${payload.principal}
        AND e.issuer = ${publisherDid}
      LIMIT 1
    `;
    return rows[0] ? { status: 'accepted', eventId: rows[0].id as string } : { status: 'not_found' };
  } catch {
    // Never expose SQL parameters or the underlying driver's error.
    log.error('loop receipt lookup failed');
    return { status: 'error', error: 'Failed to look up loop receipt', httpStatus: 500 };
  }
}
