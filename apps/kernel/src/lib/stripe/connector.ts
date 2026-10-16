/**
 * Per-DID Stripe credentials and verified event ingestion (#2794).
 * Owners configure their endpoint in Stripe and paste its signing secret into
 * the same connector as their rk/pk pair. All three fields are vault sealed;
 * routing is resolved from the opaque index before signature verification.
 * Sealed credentials alone do not enable ingress: the owner must sign consent
 * for the owner-only stripe:events scope before deliveries can be processed.
 */
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { sealAndStore, loadAndUnseal, deleteFromVault, vaultFieldStatus } from '@/src/lib/vault';
import { generateId } from '@/src/lib/kernel/id';
import { ensurePayStripeReactorRegistered } from '@/src/lib/pay/stripe-bus-consumer';
import { putRelayEntry, deleteRelayEntry } from '@/src/lib/pay/stripe-relay-store';
import { stripTrailingSlashes } from '@/src/lib/kernel/utils';
import { verifyStripeWebhookSignature } from './webhook-verify';
import { assertCheckoutSessionWriteAllowed } from './byo-checkout';
import { stripe, stripeEventsScope, stripePublishableKeyField, stripeWebhookSecretField } from './connector-core';
import { StripeCredentialError, validateStripeCredentialPair, validateStripeWebhookSecret } from './credential-pair';
import {
  upsertWebhookIndex,
  resolveWebhookOwner,
  findWebhookIndexByOwner,
  deleteWebhookIndexByOwner,
} from './webhook-index';

const log = createLogger('kernel');

// Identity + token-paste factory live in `connector-core.ts` (a leaf module, so the pay
// rail selection can read them without importing this file's bus/pay dependencies — #2754).
export { stripeConnectorDid, stripeEventsScope, type StripeCredentials } from './connector-core';

/** Stripe events this connector subscribes to and forwards onto the bus. */
export const stripeWebhookEvents = [
  'payment_intent.succeeded',
  'invoice.paid',
  'payout.paid',
] as const;

const stripeApiBase = 'https://api.stripe.com/v1';

/** Per-DID vault field for the restricted key. Encodes ownerDid for per-DID isolation. */
export const vaultField = stripe.vaultField;
export const resolveActiveGrant = stripe.resolveActiveGrant;
export const keySealed = stripe.keySealed;
export const keyPending = stripe.keyPending;
/** Check the owner's existing field without unsealing or exposing either key. */
export async function publishableKeySealed(ownerDid: string): Promise<boolean> {
  return await vaultFieldStatus(stripePublishableKeyField(ownerDid)) === 'ready';
}

/** Safe setup information; never unseals any credential. */
export async function webhookStatus(ownerDid: string, baseUrl: string) {
  const [existing, status] = await Promise.all([
    findWebhookIndexByOwner(ownerDid), vaultFieldStatus(stripeWebhookSecretField(ownerDid)),
  ]);
  return {
    webhookSecretSealed: status === 'ready',
    routingId: existing?.routingId ?? null,
    webhookUrl: existing ? `${stripTrailingSlashes(baseUrl)}/pay/api/webhook/did/${existing.routingId}` : null,
    webhookEvents: stripeWebhookEvents,
  };
}

async function deleteStripeWebhookEndpoint(restrictedKey: string, endpointId: string): Promise<void> {
  const res = await fetch(`${stripeApiBase}/webhook_endpoints/${encodeURIComponent(endpointId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${restrictedKey}` },
  });
  if (!res.ok) {
    throw new Error(`stripe_webhook_deprovision_failed: HTTP ${res.status}`);
  }
}

// ── Connect ───────────────────────────────────────────────────────────────────

/**
 * Seal an owner's same-mode pair and prepare manual webhook setup. Existing
 * routing survives key rotation, preserving both legacy and pay ingress URLs.
 * endpointId='' denotes an owner-managed endpoint; no remote endpoint is created.
 */
export async function connectAndProvisionWebhook(
  ownerDid: string,
  restrictedKey: string,
  _webhookBaseUrl: string,
  publishableKey?: string,
  webhookSecret?: string,
): Promise<{ routingId: string; endpointId: string }> {
  validateStripeCredentialPair(restrictedKey, publishableKey);
  if (webhookSecret !== undefined) validateStripeWebhookSecret(webhookSecret);
  await assertCheckoutSessionWriteAllowed(restrictedKey.trim());
  const existing = await findWebhookIndexByOwner(ownerDid);
  const routingId = existing?.routingId ?? generateId('stripewh');
  const endpointId = existing?.endpointId ?? '';
  await stripe.sealApiKey(ownerDid, restrictedKey.trim());
  await sealAndStore(stripePublishableKeyField(ownerDid), publishableKey!.trim());
  await upsertWebhookIndex(routingId, ownerDid, endpointId);
  if (webhookSecret !== undefined) {
    await sealAndStore(stripeWebhookSecretField(ownerDid), webhookSecret.trim());
  }
  log.info({ ownerDid }, 'Stripe connector: credentials sealed; configure endpoint in Stripe');
  return { routingId, endpointId };
}

/** Update only the signing secret without requiring the owner to re-paste keys. */
export async function sealWebhookSecret(ownerDid: string, secret: string): Promise<void> {
  validateStripeWebhookSecret(secret);
  const [ready, publicReady, existing] = await Promise.all([
    stripe.keySealed(ownerDid), publishableKeySealed(ownerDid), findWebhookIndexByOwner(ownerDid),
  ]);
  if (!ready || !publicReady) {
    throw new StripeCredentialError('stripe_connector_missing', 'token', 'Seal your restricted and publishable keys first.');
  }
  if (!existing) await upsertWebhookIndex(generateId('stripewh'), ownerDid, '');
  await sealAndStore(stripeWebhookSecretField(ownerDid), secret.trim());
}

// ── Disconnect ────────────────────────────────────────────────────────────────

/**
 * Disconnect: deprovision the webhook endpoint with the owner's own key
 * (#1776 disconnect-approval pattern — deprovision before removing the vault
 * entry), then remove the routing index row and the sealed signing secret,
 * then revoke the restricted key's delegation grant + channel_links rows.
 *
 * Deprovisioning is best-effort: a key already rotated/revoked by the owner
 * cannot deprovision the endpoint it created, and that must not block the
 * rest of disconnect from completing.
 */
export async function disconnectAndDeprovision(
  ownerDid: string,
): Promise<{ revoked: boolean; deprovisioned: boolean }> {
  const existing = await findWebhookIndexByOwner(ownerDid);
  let deprovisioned = false;

  if (existing) {
    try {
      const credentials = await stripe.loadSealedCredentials(ownerDid);
      if (credentials?.apiKey && existing.endpointId) {
        await deleteStripeWebhookEndpoint(credentials.apiKey, existing.endpointId);
        deprovisioned = true;
      }
    } catch {
      log.warn(
        { ownerDid },
        'Stripe connector: webhook deprovision failed — continuing disconnect',
      );
    }
    await deleteWebhookIndexByOwner(ownerDid);
  }

  await deleteFromVault(stripeWebhookSecretField(ownerDid));
  await deleteFromVault(stripePublishableKeyField(ownerDid));
  const revoked = await stripe.revokeApiKey(ownerDid);

  log.info({ ownerDid, revoked, deprovisioned }, 'Stripe connector: disconnect complete');
  return { revoked, deprovisioned };
}

// ── Webhook delivery ──────────────────────────────────────────────────────────

/** Minimal shape read from a verified Stripe event payload. */
interface StripeEventLike {
  id: string;
  type: string;
  data?: { object?: Record<string, unknown> };
}

export type StripeWebhookResult =
  | { status: 'ok'; published: boolean }
  | { status: 'unknown_routing' }
  | { status: 'invalid_signature'; reason: string }
  | { status: 'malformed_payload' }
  | { status: 'connector_unavailable' }
  | { status: 'processing_failed' };

/** String-coerce a Stripe object field for a bus payload, defaulting to ''. */
function str(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return value === null || value === undefined ? '' : JSON.stringify(value);
}

/** Number-coerce a Stripe object field for a bus payload, defaulting to 0. */
function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0) || 0;
}

/** A non-empty string metadata value, or `undefined`. */
function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The two references a checkout written by `byo-checkout.ts` puts on its
 * PaymentIntent metadata, and the ONLY metadata fields lifted onto the durable,
 * subscriber-visible bus payload: `payment_request_id` (#2754, an invoice) and
 * `pay_transaction_id` (#2757, a generic hosted checkout — events, market). The
 * pay reactor settles the named object iff it is owned by `ownerDid`. `{}` for
 * every PaymentIntent that is neither.
 */
function checkoutReferenceFields(
  object: Record<string, unknown>,
): { paymentRequestId?: string; payTransactionId?: string } {
  const metadata = object.metadata as Record<string, unknown> | null | undefined;
  const paymentRequestId = metadataString(metadata, 'payment_request_id') ?? metadataString(metadata, 'paymentRequestId');
  const payTransactionId = metadataString(metadata, 'pay_transaction_id');
  return {
    ...(paymentRequestId && { paymentRequestId }),
    ...(payTransactionId && { payTransactionId }),
  };
}

/**
 * Republish one verified Stripe event onto the bus, gated by the owner's own
 * `stripe:events` grant — the owner must have opted in before their events
 * reach any reactor chain. Returns whether a bus event was actually
 * published (false for an unmapped type). Publish/settlement failures throw
 * so the ingress can request a retry rather than acknowledging a lost payment.
 */
async function publishStripeEvent(ownerDid: string, event: StripeEventLike): Promise<boolean> {
  if (!(stripeWebhookEvents as readonly string[]).includes(event.type)) return false;

  const object = event.data?.object ?? {};
  const envelope = { issuer: ownerDid, subject: ownerDid, scope: 'stripe' } as const;

  ensurePayStripeReactorRegistered();
  const relayId = generateId('striperelay');
  const entry = putRelayEntry(relayId, 'platform', event, ownerDid);

  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await publish('stripe.payment_intent.succeeded', {
          ...envelope,
          payload: {
            ownerDid,
            relayId,
            eventId: event.id,
            paymentIntentId: str(object.id),
            amount: num(object.amount),
            currency: str(object.currency).toUpperCase(),
            ...checkoutReferenceFields(object),
            context_id: event.id,
            context_type: 'stripe',
          },
        });
        break;
      case 'invoice.paid':
        await publish('stripe.invoice.paid', {
          ...envelope,
          payload: {
            ownerDid,
            relayId,
            eventId: event.id,
            invoiceId: str(object.id),
            amountPaid: num(object.amount_paid),
            currency: str(object.currency).toUpperCase(),
            context_id: event.id,
            context_type: 'stripe',
          },
        });
        break;
      case 'payout.paid':
        await publish('stripe.payout.paid', {
          ...envelope,
          payload: {
            ownerDid,
            relayId,
            eventId: event.id,
            payoutId: str(object.id),
            amount: num(object.amount),
            currency: str(object.currency).toUpperCase(),
            arrivalDate: typeof object.arrival_date === 'number'
              ? new Date(object.arrival_date * 1000).toISOString()
              : null,
            context_id: event.id,
            context_type: 'stripe',
          },
        });
        break;
      default:
        log.info(
          { ownerDid, eventType: event.type },
          'Stripe webhook: verified event type has no bus mapping — ack only',
        );
        return false;
    }
    if (entry.error || !entry.handled) throw new Error('Stripe settlement was not handled');
    return true;
  } finally {
    deleteRelayEntry(relayId);
  }
}

/** Warm-process replay suppression; durable business settlement remains idempotent. */
const completedDeliveries = new Map<string, number>();
const pendingDeliveries = new Map<string, Promise<StripeWebhookResult>>();
const deliveryRetentionMs = 24 * 60 * 60 * 1000;
const maxCompletedDeliveries = 10_000;

function recordDelivery(key: string): void {
  const now = Date.now();
  for (const [id, completedAt] of completedDeliveries) {
    if (completedAt > now - deliveryRetentionMs && completedDeliveries.size < maxCompletedDeliveries) break;
    completedDeliveries.delete(id);
  }
  completedDeliveries.set(key, now);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStripeEvent(value: unknown): value is StripeEventLike {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() ||
      typeof value.type !== 'string' || !value.type.trim() ||
      !isRecord(value.data) || !isRecord(value.data.object)) return false;
  if (!(stripeWebhookEvents as readonly string[]).includes(value.type)) return true;
  const object = value.data.object;
  const amount = value.type === 'invoice.paid' ? object.amount_paid : object.amount;
  return typeof object.id === 'string' && object.id.length > 0 &&
    typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 &&
    typeof object.currency === 'string' && /^[a-z]{3}$/i.test(object.currency) &&
    (object.metadata === undefined || object.metadata === null || isRecord(object.metadata)) &&
    (object.arrival_date === undefined || (typeof object.arrival_date === 'number' &&
      Number.isFinite(object.arrival_date) && !Number.isNaN(new Date(object.arrival_date * 1000).getTime())));
}

/**
 * Verify and process one inbound Stripe webhook delivery for `routingId`.
 *
 * Order matters: routing lookup, THEN signing-secret load, THEN signature
 * verification (valid/invalid/replay, see `webhook-verify.ts`), and only
 * once all three pass is the body parsed and republished. Every failure
 * branch is fail-closed and none of them touch the bus.
 *
 * The signing secret and restricted key are never logged.
 */
export async function handleVerifiedWebhookEvent(
  routingId: string,
  rawBody: string,
  signatureHeader: string | null,
): Promise<StripeWebhookResult> {
  const owner = await resolveWebhookOwner(routingId);
  if (!owner) {
    return { status: 'unknown_routing' };
  }

  const signingSecret = await loadAndUnseal(stripeWebhookSecretField(owner.ownerDid));
  if (!signingSecret) {
    log.error({ ownerDid: owner.ownerDid }, 'Stripe webhook: no signing secret sealed for this owner — rejecting');
    return { status: 'invalid_signature', reason: 'missing_secret' };
  }

  const verification = verifyStripeWebhookSignature(rawBody, signatureHeader, signingSecret);
  if (!verification.ok) {
    return { status: 'invalid_signature', reason: verification.reason };
  }

  let event: StripeEventLike;
  try {
    event = JSON.parse(rawBody) as StripeEventLike;
  } catch {
    return { status: 'malformed_payload' };
  }

  if (!isStripeEvent(event)) return { status: 'malformed_payload' };
  if (!await stripe.keySealed(owner.ownerDid) ||
      !await stripe.resolveActiveGrant(owner.ownerDid, stripeEventsScope)) {
    return { status: 'connector_unavailable' };
  }
  const deliveryKey = JSON.stringify([owner.ownerDid, event.id]);
  const completedAt = completedDeliveries.get(deliveryKey);
  if (completedAt !== undefined && completedAt > Date.now() - deliveryRetentionMs) {
    return { status: 'ok', published: false };
  }
  const pending = pendingDeliveries.get(deliveryKey);
  if (pending) {
    const result = await pending;
    return result.status === 'ok' ? { status: 'ok', published: false } : result;
  }
  const delivery = (async (): Promise<StripeWebhookResult> => {
    try {
      const published = await publishStripeEvent(owner.ownerDid, event);
      recordDelivery(deliveryKey);
      return { status: 'ok', published };
    } catch {
      log.error({ ownerDid: owner.ownerDid, eventType: event.type }, 'Stripe webhook processing failed');
      return { status: 'processing_failed' };
    }
  })();
  pendingDeliveries.set(deliveryKey, delivery);
  try {
    return await delivery;
  } finally {
    pendingDeliveries.delete(deliveryKey);
  }
}
