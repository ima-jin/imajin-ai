import { z } from 'zod';

export const PAY_SETUP_INTENT_SCOPE = 'pay:setup-intent';

const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const did = z.string().max(500).regex(/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/);

/** Unknown fields (including caller metadata) are stripped, never sent to Stripe. */
export const setupIntentBody = z.object({
  pledgeId: identifier,
  eventId: identifier,
  buyerDid: did,
  sellerDid: did,
  amount: z.number().int().positive().max(99_999_900),
  currency: z.string().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()),
});

export const verifySetupIntentBody = setupIntentBody.extend({
  setupIntentId: identifier.regex(/^seti_[A-Za-z0-9]+$/),
  customerId: identifier.regex(/^cus_[A-Za-z0-9]+$/),
});

export type SetupIntentBinding = z.infer<typeof setupIntentBody>;
export type VerifySetupIntentInput = z.infer<typeof verifySetupIntentBody>;

/** Reserved binding values come only from the authenticated app's validated body. */
export function setupIntentMetadata(appDid: string, binding: SetupIntentBinding): Record<string, string> {
  return {
    appDid,
    pledgeId: binding.pledgeId,
    eventId: binding.eventId,
    buyerDid: binding.buyerDid,
    sellerDid: binding.sellerDid,
    amount: String(binding.amount),
    currency: binding.currency,
  };
}

export class SetupIntentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'SetupIntentError';
  }
}
