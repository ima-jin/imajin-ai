/**
 * Checkout Sessions on the ISSUER'S OWN Stripe account (#2754), through the
 * #1785 BYO restricted-key connector — no Stripe Connect, no destination
 * charge, no platform credential.
 *
 * ## Restricted-key permissions this needs
 * On top of the connector's existing `Webhooks = Write` (self-provisioning the
 * webhook endpoint) and `Payments = Write`, creating an invoice's hosted
 * checkout needs **Checkout Sessions = Write** (Stripe Dashboard → Developers
 * → API keys → Create restricted key). Nothing here ever needs `Account`.
 * {@link assertCheckoutSessionWriteAllowed} checks it at CONNECT time, so a
 * key without it fails when pasted — not when a payer clicks Pay.
 *
 * ## Why raw HTTP, not the SDK
 * `ci-guard-stripe-import-scope` keeps the `stripe` SDK under `lib/pay/providers/`
 * (it is built around the platform's one secret). This module speaks to the
 * Stripe REST API with the owner's key exactly as `connector.ts` already does
 * for webhook provisioning.
 *
 * The restricted key is read from the sealed vault per call, used for one
 * request and never logged, returned or cached.
 */
import { stripe } from './connector-core';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/** Hosted Checkout sessions expire after a day, matching the platform provider's session lifetime. */
const SESSION_LIFETIME_SECONDS = 24 * 60 * 60;

export type ByoCheckoutErrorCode =
  /** No readable restricted key is sealed for the owner (never connected, disconnected, or grant pending). */
  | 'no_key'
  /** Stripe refused the key — revoked/rotated, or it lacks Checkout Sessions = Write. */
  | 'key_rejected'
  /** Stripe was unreachable, rate-limited or errored — nothing about the request or key is known to be wrong. */
  | 'unavailable'
  /** Stripe understood the key but rejected the request itself (currency, amount floor, …). */
  | 'request_rejected';

/** A failure creating/reading a Checkout Session on the owner's account; `code` drives the payer-facing message. */
export class ByoCheckoutError extends Error {
  readonly code: ByoCheckoutErrorCode;
  readonly stripeStatus: number | undefined;

  constructor(code: ByoCheckoutErrorCode, message: string, stripeStatus?: number) {
    super(message);
    this.name = 'ByoCheckoutError';
    this.code = code;
    this.stripeStatus = stripeStatus;
  }
}

export interface ByoCheckoutItem {
  name: string;
  description?: string;
  /** Unit amount, minor units. */
  amount: number;
  quantity: number;
}

export interface CreateByoCheckoutInput {
  items: ByoCheckoutItem[];
  currency: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  /** Written to the session AND its PaymentIntent, so the owner's own `payment_intent.succeeded` names the request. */
  metadata: Record<string, string>;
}

export interface ByoCheckoutSession {
  id: string;
  url: string;
  expiresAt: Date;
}

export interface ByoCheckoutSessionState {
  id: string;
  url: string | null;
  status: string | null;
  expiresAt: Date | null;
}

interface StripeErrorBody {
  error?: { type?: string; message?: string };
}

interface StripeResponse {
  status: number;
  ok: boolean;
  body: Record<string, unknown> & StripeErrorBody;
}

async function stripeRequest(
  key: string,
  method: 'GET' | 'POST',
  path: string,
  form?: URLSearchParams,
): Promise<StripeResponse> {
  let res: Response;
  try {
    res = await fetch(`${STRIPE_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: form.toString() } : {}),
    });
  } catch (error) {
    throw new ByoCheckoutError('unavailable', `stripe_unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let body: StripeResponse['body'] = {};
  try {
    body = (await res.json()) as StripeResponse['body'];
  } catch {
    // A non-JSON body (proxy error page) is classified by status alone.
  }
  return { status: res.status, ok: res.ok, body };
}

/** True when Stripe says the key itself is refused: revoked/rotated, or missing a permission. */
function isKeyRefusal(res: StripeResponse): boolean {
  const type = res.body.error?.type;
  return res.status === 401 || res.status === 403 || type === 'permission_error' || type === 'authentication_error';
}

function failureOf(res: StripeResponse, action: string): ByoCheckoutError {
  const detail = res.body.error?.message ?? 'no detail';
  const message = `stripe_${action}_failed: ${res.status} ${detail}`;
  if (isKeyRefusal(res)) return new ByoCheckoutError('key_rejected', message, res.status);
  if (res.status === 429 || res.status >= 500) return new ByoCheckoutError('unavailable', message, res.status);
  return new ByoCheckoutError('request_rejected', message, res.status);
}

async function loadKey(ownerDid: string): Promise<string> {
  const credentials = await stripe.loadSealedCredentials(ownerDid);
  if (!credentials?.apiKey) {
    throw new ByoCheckoutError('no_key', 'stripe_no_key: no readable Stripe restricted key is sealed for this issuer');
  }
  return credentials.apiKey;
}

/** Flatten a Checkout Session create request into Stripe's bracketed form encoding. */
function checkoutForm(input: CreateByoCheckoutInput): URLSearchParams {
  const form = new URLSearchParams();
  form.set('mode', 'payment');
  // Card only: the pay page's button says "card", and the owner's dashboard defaults could add async methods.
  form.set('payment_method_types[0]', 'card');
  input.items.forEach((item, i) => {
    form.set(`line_items[${i}][quantity]`, String(item.quantity));
    form.set(`line_items[${i}][price_data][currency]`, input.currency.toLowerCase());
    form.set(`line_items[${i}][price_data][unit_amount]`, String(item.amount));
    form.set(`line_items[${i}][price_data][product_data][name]`, item.name);
    if (item.description) form.set(`line_items[${i}][price_data][product_data][description]`, item.description);
  });
  if (input.customerEmail) form.set('customer_email', input.customerEmail);
  form.set('success_url', input.successUrl);
  form.set('cancel_url', input.cancelUrl);
  form.set('expires_at', String(Math.floor(Date.now() / 1000) + SESSION_LIFETIME_SECONDS));
  for (const [name, value] of Object.entries(input.metadata)) {
    form.set(`metadata[${name}]`, value);
    form.set(`payment_intent_data[metadata][${name}]`, value);
  }
  return form;
}

/** Create a hosted Checkout Session on `ownerDid`'s own Stripe account with their sealed restricted key. */
export async function createByoCheckoutSession(
  ownerDid: string,
  input: CreateByoCheckoutInput,
): Promise<ByoCheckoutSession> {
  const key = await loadKey(ownerDid);
  const res = await stripeRequest(key, 'POST', '/checkout/sessions', checkoutForm(input));
  if (!res.ok) throw failureOf(res, 'checkout_create');

  const { id, url, expires_at: expiresAt } = res.body as { id?: unknown; url?: unknown; expires_at?: unknown };
  if (typeof id !== 'string' || typeof url !== 'string' || typeof expiresAt !== 'number') {
    throw new ByoCheckoutError('unavailable', 'stripe_checkout_create_failed: response is missing id/url/expires_at', res.status);
  }
  return { id, url, expiresAt: new Date(expiresAt * 1000) };
}

/** Read back a Checkout Session on the owner's account (to reuse a still-open one). */
export async function retrieveByoCheckoutSession(
  ownerDid: string,
  sessionId: string,
): Promise<ByoCheckoutSessionState> {
  const key = await loadKey(ownerDid);
  const res = await stripeRequest(key, 'GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw failureOf(res, 'checkout_retrieve');

  const { id, url, status, expires_at: expiresAt } = res.body as {
    id?: unknown;
    url?: unknown;
    status?: unknown;
    expires_at?: unknown;
  };
  return {
    id: typeof id === 'string' ? id : sessionId,
    url: typeof url === 'string' ? url : null,
    status: typeof status === 'string' ? status : null,
    expiresAt: typeof expiresAt === 'number' ? new Date(expiresAt * 1000) : null,
  };
}

/**
 * Connect-time permission check (#2754): does this restricted key carry
 * **Checkout Sessions = Write**?
 *
 * Stripe has no "what can this key do" endpoint, and creating a real session
 * just to find out would leave debris on the owner's account. Instead this
 * POSTs a deliberately INCOMPLETE session (`mode` only, no line items): a key
 * that may write sessions is rejected on the missing parameters (HTTP 400,
 * `invalid_request_error`), while a key that may not is rejected on
 * permission (HTTP 403, `permission_error`). Only that definitive permission
 * refusal fails the connect — anything else (a 400, an unreachable Stripe, a
 * revoked key, which the webhook provisioning that follows reports with its
 * own error) is not evidence about this permission.
 *
 * Throws `stripe_key_missing_permission` on a definitive refusal.
 */
export async function assertCheckoutSessionWriteAllowed(restrictedKey: string): Promise<void> {
  let res: StripeResponse;
  try {
    res = await stripeRequest(restrictedKey, 'POST', '/checkout/sessions', new URLSearchParams({ mode: 'payment' }));
  } catch {
    return;
  }
  const type = res.body.error?.type;
  if (res.status === 403 || type === 'permission_error') {
    throw new Error(
      'stripe_key_missing_permission: this restricted key cannot create Checkout Sessions. ' +
      'Edit the key in the Stripe Dashboard and set Checkout Sessions = Write ' +
      '(together with Payments = Write and Webhooks = Write), then paste it again.',
    );
  }
}
