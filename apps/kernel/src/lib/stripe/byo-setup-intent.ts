/**
 * Pledge cards live exclusively on the seller's OWN sealed Stripe account.
 * No SDK or platform-key fallback. Verification performs GETs only and is
 * repeatable; legacy platform intents have no app binding and fail closed.
 */
import {
  SetupIntentError,
  setupIntentMetadata,
  type SetupIntentBinding,
  type VerifySetupIntentInput,
} from '@/src/lib/pay/setup-intent';
import { resolveDidStripeKeys, SellerNoCardRailError } from '@/src/lib/pay/rails/stripe-keys';

const API = 'https://api.stripe.com/v1';
const REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function metadataMatches(metadata: unknown, expected: Record<string, string>): boolean {
  return isRecord(metadata) && Object.entries(expected).every(([name, value]) => metadata[name] === value);
}

function unavailable(): SetupIntentError {
  return new SetupIntentError(503, 'SETUP_INTENT_UNAVAILABLE', 'Seller payment setup is unavailable');
}


/** Never include upstream error text or the sealed key in a response/log. */
async function stripeRequest(key: string, path: string, form?: URLSearchParams): Promise<Record<string, unknown>> {
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(`${API}${path}`, {
      method: form ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: form.toString() } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
      cache: 'no-store',
    });
    body = await response.json();
  } catch {
    throw unavailable();
  }
  if (response.status === 404) {
    throw new SetupIntentError(404, 'setup_intent_resource_not_found', 'Payment setup resource not found on seller account');
  }
  if (!response.ok || !isRecord(body)) throw unavailable();
  return body;
}

function isStripeResourceId(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value);
}

function resourceId(value: unknown): unknown {
  return isRecord(value) ? value.id : value;
}

function mismatch(message: string): never {
  throw new SetupIntentError(403, 'setup_intent_binding_mismatch', message);
}

function assertCustomer(customer: Record<string, unknown>, customerId: string, buyerDid: string): void {
  if (customer.id !== customerId || customer.deleted === true) mismatch('Customer is missing or deleted');
  const metadata = customer.metadata;
  if (!isRecord(metadata)) mismatch('Customer has no buyer binding');
  // Accept either vocabulary, but reject conflicting values when both are present.
  if (metadata.buyerDid !== buyerDid && metadata.did !== buyerDid) mismatch('Customer buyer does not match');
  if (metadata.buyerDid !== undefined && metadata.buyerDid !== buyerDid) mismatch('Customer buyer does not match');
  if (metadata.did !== undefined && metadata.did !== buyerDid) mismatch('Customer DID does not match');
}

function assertIntent(intent: Record<string, unknown>, appDid: string, input: VerifySetupIntentInput): string {
  if (intent.id !== input.setupIntentId) mismatch('SetupIntent ID does not match');
  if (!isRecord(intent.metadata)) mismatch('SetupIntent has no registered-app binding');
  for (const [field, value] of Object.entries(setupIntentMetadata(appDid, input))) {
    if (intent.metadata[field] !== value) mismatch(`SetupIntent ${field} does not match`);
  }
  if (resourceId(intent.customer) !== input.customerId) mismatch('SetupIntent customer does not match');
  if (intent.status !== 'succeeded') {
    throw new SetupIntentError(409, 'setup_intent_not_succeeded', 'SetupIntent has not succeeded');
  }
  const paymentMethodId = resourceId(intent.payment_method);
  if (!isStripeResourceId(paymentMethodId, 'pm')) throw unavailable();
  return paymentMethodId;
}

async function expandedOrRetrieve(key: string, value: unknown, collection: string, id: string) {
  return isRecord(value) ? value : stripeRequest(key, `/${collection}/${encodeURIComponent(id)}`);
}

export async function createByoSetupIntent(appDid: string, input: SetupIntentBinding) {
  const { secretKey: key, publishableKey } = await resolveDidStripeKeys(input.sellerDid);
  // The client cannot confirm a SetupIntent without this account's public key.
  if (!publishableKey) throw new SellerNoCardRailError();
  // A fresh customer avoids accidentally reusing another buyer's record:
  // Stripe's ordinary customer list does not support filtering metadata.
  const customer = await stripeRequest(key, '/customers', new URLSearchParams({
    'metadata[buyerDid]': input.buyerDid,
    'metadata[did]': input.buyerDid,
  }));
  if (!isStripeResourceId(customer.id, 'cus')) throw unavailable();
  assertCustomer(customer, customer.id, input.buyerDid);
  const form = new URLSearchParams({
    customer: customer.id,
    usage: 'off_session',
    'payment_method_types[0]': 'card',
  });
  for (const [name, value] of Object.entries(setupIntentMetadata(appDid, input))) {
    form.set(`metadata[${name}]`, value);
  }
  const intent = await stripeRequest(key, '/setup_intents', form);
  if (!isStripeResourceId(intent.id, 'seti') || typeof intent.client_secret !== 'string' || !intent.client_secret.startsWith(`${intent.id}_secret_`)) {
    throw unavailable();
  }
  if (resourceId(intent.customer) !== customer.id) throw unavailable();
  const expected = setupIntentMetadata(appDid, input);
  if (!metadataMatches(intent.metadata, expected)) {
    throw unavailable();
  }
  return { clientSecret: intent.client_secret, setupIntentId: intent.id, customerId: customer.id, publishableKey };
}

export async function verifyByoSetupIntent(appDid: string, input: VerifySetupIntentInput) {
  const { secretKey: key } = await resolveDidStripeKeys(input.sellerDid);
  const intent = await stripeRequest(key, `/setup_intents/${encodeURIComponent(input.setupIntentId)}?expand[]=customer&expand[]=payment_method`);
  const paymentMethodId = assertIntent(intent, appDid, input);
  const customer = await expandedOrRetrieve(key, intent.customer, 'customers', input.customerId);
  assertCustomer(customer, input.customerId, input.buyerDid);
  const method = await expandedOrRetrieve(key, intent.payment_method, 'payment_methods', paymentMethodId);
  if (method.id !== paymentMethodId || resourceId(method.customer) !== input.customerId) {
    mismatch('Payment method is not attached to the verified customer');
  }
  return {
    verified: true as const,
    setupIntentId: input.setupIntentId,
    customerId: input.customerId,
    paymentMethodId,
    pledgeId: input.pledgeId,
    eventId: input.eventId,
    buyerDid: input.buyerDid,
    sellerDid: input.sellerDid,
    amount: input.amount,
    currency: input.currency,
  };
}
