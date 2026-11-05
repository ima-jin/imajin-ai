import { publish, type FeeReceiptPayload } from '@imajin/bus';
import { feeCreditKey } from '../fee-credit-key';
import { materializeVerifiedFeeReceipt } from '../fee-ledger-reactor';
import type { publishFeeReceipt } from '../fee-receipts';

/**
 * Legacy golden suites mock receipt persistence/signing, not fee materialization.
 * The real signed ingest, stored verification and retry contract are tested in
 * fee-receipts.test.ts against PostgreSQL and the actual bus chain.
 */
export const fixturePublishFeeReceipt: typeof publishFeeReceipt = async (type, fact) => {
  const payload: FeeReceiptPayload = {
    ...fact, loopId: feeCreditKey(fact), kind: 'pay.fee', principal: 'did:imajin:platform',
    state: 'recorded', summary: 'Test receipt', at: '2026-11-05T00:00:00Z', stripeEventId: 'evt_fixture',
  };
  await publish(type, {
    issuer: payload.principal, subject: payload.recipientDid, scope: 'pay', payload,
  });
  await materializeVerifiedFeeReceipt(payload, `fixture:${payload.loopId}`);
  return payload;
};
