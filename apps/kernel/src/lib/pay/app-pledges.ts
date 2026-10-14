import { createHash } from 'node:crypto';
import { z } from 'zod';
import { verifyByoSetupIntent } from '@/src/lib/stripe/byo-setup-intent';
import { sellerPledgeRefundClient } from './providers/seller-pledge-refund';
import { resolveDidStripeKeys } from './rails/stripe-keys';
import { SetupIntentError, setupIntentBody, setupIntentMetadata, type VerifySetupIntentInput } from './setup-intent';

const referenceBody = setupIntentBody.pick({ pledgeId: true, sellerDid: true }).extend({
  setupIntentId: z.string().regex(/^seti_[A-Za-z0-9]+$/),
});
const ATTEMPT_FIELD = 'imajin_pledge_charge_attempt';
const MAX_CLAIM_DURATION_MS = 30_000;
const RAIL_REQUEST = { timeout: 10_000, maxNetworkRetries: 0 };

export type PledgeReference = z.infer<typeof referenceBody>;
export interface BoundPledge extends VerifySetupIntentInput {
  appDid: string;
  paymentMethodId: string;
}

/** Safe client-facing failures, never Stripe's credential-bearing error text. */
export class PledgeChargeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'PledgeChargeError';
  }
}

function mismatch(): never {
  throw new PledgeChargeError(403, 'PLEDGE_BINDING_MISMATCH', 'Pledge does not match the seller-account setup binding');
}

function assertNotAttempted(metadata: Record<string, string> | null): void {
  if (metadata?.[ATTEMPT_FIELD]) {
    throw new PledgeChargeError(409, 'PLEDGE_CHARGE_ALREADY_ATTEMPTED',
      'Pledge charge already attempted; reconcile the seller payment before retrying');
  }
}

function resourceId(value: string | { id: string } | null): string | undefined {
  return typeof value === 'string' ? value : value?.id;
}

async function retrieveSellerSetup(secretKey: string, setupIntentId: string) {
  try {
    return await sellerPledgeRefundClient(secretKey).setupIntents.retrieve(setupIntentId, {}, RAIL_REQUEST);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404) {
      throw new PledgeChargeError(404, 'PLEDGE_SETUP_NOT_FOUND', 'Pledge setup was not found on the selected seller account');
    }
    throw error;
  }
}

/** All authority comes from #2788's seller Stripe metadata, not events card/amount fields or a kernel row. */
async function bindPledge(appDid: string, eventId: string, ref: PledgeReference): Promise<BoundPledge> {
  const { secretKey } = await resolveDidStripeKeys(ref.sellerDid);
  const setup = await retrieveSellerSetup(secretKey, ref.setupIntentId);
  const metadata = setup.metadata;
  const parsed = setupIntentBody.safeParse({ ...metadata, amount: Number(metadata?.amount) });
  if (!parsed.success || metadata?.appDid !== appDid) mismatch();
  const binding = parsed.data;
  if (binding.sellerDid !== ref.sellerDid || binding.pledgeId !== ref.pledgeId || binding.eventId !== eventId) mismatch();
  assertNotAttempted(metadata);
  const customerId = resourceId(setup.customer);
  if (!customerId) mismatch();
  const input = { ...binding, setupIntentId: ref.setupIntentId, customerId };
  // Reuse #2788's checks: succeeded setup, complete app binding, customer buyer,
  // and the saved payment method's attachment on this same seller account.
  const verified = await verifyByoSetupIntent(appDid, input);
  return { ...input, appDid, paymentMethodId: verified.paymentMethodId };
}

/** Preflight every binding before starting any off-session charge. */
export async function loadAppPledges(appDid: string, eventId: string, refs: PledgeReference[]): Promise<BoundPledge[]> {
  const seenSetups = new Set<string>();
  const seenPledges = new Set<string>();
  const references: PledgeReference[] = [];
  for (const ref of refs) {
    const parsed = referenceBody.safeParse(ref);
    if (!parsed.success || seenSetups.has(parsed.data.setupIntentId) || seenPledges.has(parsed.data.pledgeId)) {
      throw new PledgeChargeError(400, 'INVALID_PLEDGE_REFERENCE',
        'Each pledge requires a sellerDid, pledgeId and unique setupIntentId');
    }
    seenSetups.add(parsed.data.setupIntentId);
    seenPledges.add(parsed.data.pledgeId);
    references.push(parsed.data);
  }
  const result: BoundPledge[] = [];
  for (const ref of references) result.push(await bindPledge(appDid, eventId, ref));
  return result;
}

/** Durable Stripe-side attempt marker: never reset or automatically retry an ambiguous charge. */
export async function chargeBoundPledge(pledge: BoundPledge, eventId: string): Promise<string> {
  const startedAt = Date.now();
  if (pledge.eventId !== eventId) mismatch();
  const { secretKey } = await resolveDidStripeKeys(pledge.sellerDid);
  const stripe = sellerPledgeRefundClient(secretKey);
  const setup = await retrieveSellerSetup(secretKey, pledge.setupIntentId);
  const expected = setupIntentMetadata(pledge.appDid, pledge);
  if (setup.id !== pledge.setupIntentId || setup.status !== 'succeeded' ||
      resourceId(setup.customer) !== pledge.customerId || resourceId(setup.payment_method) !== pledge.paymentMethodId ||
      !Object.entries(expected).every(([field, value]) => setup.metadata?.[field] === value)) mismatch();
  assertNotAttempted(setup.metadata);
  await verifyByoSetupIntent(pledge.appDid, pledge);
  const digest = createHash('sha256')
    .update(JSON.stringify([pledge.appDid, pledge.sellerDid, pledge.setupIntentId])).digest('hex');
  // Concurrent requests may both read an unmarked setup: their charge params
  // and idempotency key are identical. Stripe creates at most one intent.
  // Later requests see the permanent marker and fail closed even after the
  // Stripe idempotency retention period has elapsed.
  await stripe.setupIntents.update(pledge.setupIntentId, { metadata: { [ATTEMPT_FIELD]: digest } }, RAIL_REQUEST);
  if (Date.now() - startedAt < 0 || Date.now() - startedAt > MAX_CLAIM_DURATION_MS) {
    throw new PledgeChargeError(409, 'PLEDGE_CHARGE_RECONCILIATION_REQUIRED', 'Pledge charge claim expired; reconciliation required');
  }
  const payment = await stripe.paymentIntents.create({
    amount: pledge.amount,
    currency: pledge.currency.toLowerCase(),
    customer: pledge.customerId,
    payment_method: pledge.paymentMethodId,
    off_session: true,
    confirm: true,
    metadata: { ...expected, setupIntentId: pledge.setupIntentId, type: 'campaign_pledge_charge' },
  }, { ...RAIL_REQUEST, idempotencyKey: `pledge-charge:${digest}` });
  return payment.status;
}

/** Only known domain errors cross the HTTP boundary. */
export function pledgeFailure(error: unknown): { status: number; code: string; error: string } {
  if (error instanceof PledgeChargeError || error instanceof SetupIntentError) {
    return { status: error.status, code: error.code, error: error.message };
  }
  return { status: 503, code: 'PLEDGE_CHARGE_UNAVAILABLE', error: 'Seller pledge charge unavailable; reconcile before retrying an attempted charge' };
}
