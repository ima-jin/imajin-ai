import { canonicalize, crypto } from '@imajin/auth';
import { getClient } from '@imajin/db';
import { publish, type FeeReceiptPayload } from '@imajin/bus';
import { getNodeSigningIdentity } from '../vault/sealing';
import { ingestLoopEvent } from '../loops/ingest';
import { loopObservationId } from '../loops/surface-lease';
import { serializeLoopEvent, type RawLoopEventRow } from '../loops/serialize';
import { verifyStoredLoopReceipt } from '../loops/verify-stored-receipt';
import { feeCreditKey } from './fee-credit-key';
import { ensureFeeLedgerReactorRegistered, feeLedgerRowId } from './fee-ledger-reactor';
import { validateFeeReceipt, type FeeEventType } from './fee-receipt-payload';

export interface FeeReceiptContext {
  stripeEventId: string;
  stripeEventAt: string;
}

type FeeFact = Pick<FeeReceiptPayload, 'transactionId' | 'recipientDid' | 'role' | 'amountCents' | 'currency' | 'status'>
  & Partial<Pick<FeeReceiptPayload, 'chainIndex' | 'tax' | 'sellerDid'>>;

/** Await the existing signed ingest/chain, never an attestation or a second store. */
export async function publishFeeReceipt(type: FeeEventType, fact: FeeFact, context?: FeeReceiptContext): Promise<FeeReceiptPayload> {
  if (!context) throw new Error('Verified Stripe event context is required for a fee receipt');
  const publisherDid = process.env.PLATFORM_DID;
  if (!publisherDid?.startsWith('did:')) throw new Error('Platform fee publisher DID is not configured');
  ensureFeeLedgerReactorRegistered();
  const key = feeCreditKey(fact);
  const sql = getClient();
  // Freeze the first signed fact, including actual-vs-estimated fees, on a
  // failed delivery retry. The receipt survives projection/wallet failures.
  const [prior] = await sql`
    SELECT * FROM kernel.loop_events
    WHERE loop_id = ${key} AND type = ${type} AND publisher_did = ${publisherDid}
    ORDER BY occurred_at, id LIMIT 1
  `;
  let payload: FeeReceiptPayload;
  let id: string;
  if (prior) {
    const receipt = serializeLoopEvent(prior as unknown as RawLoopEventRow);
    const verification = await verifyStoredLoopReceipt(receipt);
    if (!verification.ok || !validateFeeReceipt(type, receipt.payload, publisherDid)) throw new Error('Stored fee receipt is invalid');
    payload = receipt.payload;
    id = receipt.id;
    await publish(type, {
      id, issuer: receipt.issuer, publisherDid, signature: receipt.signature!,
      causeEventId: receipt.causeEventId, subject: payload.recipientDid, scope: 'pay',
      payload, correlationId: key,
    });
  } else {
    payload = {
      ...fact, stripeEventId: context.stripeEventId, loopId: key, kind: 'pay.fee',
      principal: publisherDid, state: 'recorded', summary: 'Stripe fee recorded',
      at: context.stripeEventAt,
    };
    if (!validateFeeReceipt(type, payload, publisherDid)) throw new Error('Invalid fee receipt facts');
    const identity = getNodeSigningIdentity();
    const request = {
      type, payload, publisherDid,
      signature: {
        keyId: identity.senderPubkey.toLowerCase(), alg: 'ed25519' as const,
        sig: crypto.signSync(canonicalize({ type, payload }), identity.privateKeyHex).toLowerCase(),
      },
    };
    id = loopObservationId(request);
    const result = await ingestLoopEvent(request);
    if (!result.ok) throw new Error('Fee receipt publish failed');
  }
  // A disabled/replaced chain must not silently acknowledge a lost projection.
  const [projected] = await sql`
    SELECT id FROM pay.fee_ledger WHERE id = ${feeLedgerRowId(key)} AND receipt_id = ${id}
  `;
  if (!projected) throw new Error('Fee ledger reactor did not materialize the receipt');
  return payload;
}
