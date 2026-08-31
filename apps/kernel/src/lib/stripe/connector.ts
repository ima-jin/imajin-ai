/**
 * Stripe connector backend — BYO restricted key, Connect deliberately
 * bypassed (#1785, closes ima-jin/imajin-ai#1785).
 *
 * ## Why not Stripe Connect
 * Connect makes Imajin the platform of record: connected accounts hang off
 * one platform credential, Stripe reviews *our* business, and Stripe skims a
 * platform fee on every charge. `.fair` manifests + settlement already do
 * attribution and splits at our layer — Connect's destination-charge
 * machinery duplicates a primitive this system already has. See the issue
 * for the full "NOT-PAT rule" argument for why a restricted key is not the
 * same anti-pattern as a raw PAT.
 *
 * ## Shape
 * Each identity brings their own Stripe **restricted key** — scoped to
 * exactly the permissions the connector card asks for, never `account:write`
 * — sealed per-DID via `createConnectorTokenPaste` (#1621), the same factory
 * Gemini/Anthropic/GCP use. On connect, that key self-provisions a webhook
 * endpoint on the OWNER's OWN Stripe account (`POST /v1/webhook_endpoints`,
 * called with their key) pointing back at this node; the signing secret
 * Stripe returns is sealed separately (see below) so inbound deliveries can
 * be verified with no session in play.
 *
 * ## Two sealed fields, two different reasons
 *   - `stripe-api-key:{ownerDid}` (v2, delegation-grant, via the token-paste
 *     factory) — the owner's authority-bearing restricted key. Revoking the
 *     grant crypto-erases it immediately (#1720 semantics).
 *   - `stripe-webhook-secret:{ownerDid}` (v1, node-sealed, this module) — the
 *     per-endpoint signing secret Stripe mints. This is NOT the owner
 *     spending their own credential; it is the node's own material for
 *     verifying deliveries that arrive with no session at all. Gating it
 *     behind a delegation grant (Tier 1 pending, or a lapsed grant) would
 *     make every webhook delivery unverifiable until the owner approved —
 *     exactly the failure mode `webhookVerifierToken` avoids in the
 *     QuickBooks connector's config (`quickbooks/connector.ts`), which this
 *     mirrors.
 *
 * ## Webhook routing (`webhook-index.ts`)
 * A direct-account Stripe event carries no owner-identifying field (unlike a
 * Connect event's `account`, or QuickBooks' `realmId`), and multiple owners'
 * endpoints can legitimately point at the same ingress path. So a fresh
 * opaque `routingId` is minted per connect and embedded in the URL Stripe is
 * told to call (`/stripe/api/webhook/{routingId}`); `webhook-index.ts` is the
 * reverse lookup from that id back to `{ ownerDid, endpointId }`.
 *
 * ## Settlement seam (#1073) — intentionally NOT built here
 * Verified events are republished onto the bus (`stripe.payment_intent.
 * succeeded`, `stripe.invoice.paid`, `stripe.payout.paid`), tagged with the
 * owning principal DID, gated behind the owner's own `stripe:events` grant.
 * That is the seam: a follow-up reactor can subscribe to these and route them
 * to the canonical `POST /api/settle`. Building that convergence is out of
 * scope for this PR (see the issue's "Shape of the work" checklist) — this
 * only lands the bus event.
 *
 * ## Non-goals
 * No Stripe Connect, no Account Links, no destination charges, anywhere in
 * this module.
 */
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { sealAndStore, loadAndUnseal, deleteFromVault } from '@/src/lib/vault';
import { generateId } from '@/src/lib/kernel/id';
import {
  createConnectorTokenPaste,
  type TokenPasteCredentials,
} from '@/src/lib/kernel/connector-token-paste';
import { verifyStripeWebhookSignature } from './webhook-verify';
import {
  upsertWebhookIndex,
  resolveWebhookOwner,
  findWebhookIndexByOwner,
  deleteWebhookIndexByOwner,
} from './webhook-index';

const log = createLogger('kernel');

/** Connector app DID — the selectable "Stripe" connector identity. */
export const STRIPE_CONNECTOR_DID = 'did:imajin:stripe-connector';

/** Scope gating whether verified events get republished onto the owner's bus. */
export const STRIPE_EVENTS_SCOPE = 'stripe:events';

/** Stripe events this connector subscribes to and forwards onto the bus. */
export const STRIPE_WEBHOOK_EVENTS = [
  'payment_intent.succeeded',
  'invoice.paid',
  'payout.paid',
] as const;

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

const stripe = createConnectorTokenPaste({
  id: 'stripe',
  displayName: 'Stripe',
  connectorDid: STRIPE_CONNECTOR_DID,
  channel: 'stripe',
});

/** Per-DID vault field for the restricted key. Encodes ownerDid for per-DID isolation. */
export const vaultField = stripe.vaultField;
export const resolveActiveGrant = stripe.resolveActiveGrant;
export const keySealed = stripe.keySealed;
export const keyPending = stripe.keyPending;
export type StripeCredentials = TokenPasteCredentials;

/** Node-sealed (v1) per-DID field for the webhook endpoint's signing secret. */
function webhookSecretField(ownerDid: string): string {
  return `stripe-webhook-secret:${ownerDid}`;
}

/** Stripe restricted keys start `rk_`; a full secret key (`sk_...`) is refused. */
function isRestrictedKey(key: string): boolean {
  return key.startsWith('rk_');
}

// ── Stripe API calls ─────────────────────────────────────────────────────────

interface StripeWebhookEndpointCreateResponse {
  id?: string;
  secret?: string;
}

async function createStripeWebhookEndpoint(
  restrictedKey: string,
  url: string,
): Promise<{ endpointId: string; signingSecret: string }> {
  const body = new URLSearchParams();
  body.set('url', url);
  body.set('description', 'imajin BYO-key connector (#1785)');
  for (const eventType of STRIPE_WEBHOOK_EVENTS) {
    body.append('enabled_events[]', eventType);
  }

  const res = await fetch(`${STRIPE_API_BASE}/webhook_endpoints`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${restrictedKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`stripe_webhook_provision_failed: ${res.status} ${res.statusText}: ${text}`);
  }

  const data = (await res.json()) as StripeWebhookEndpointCreateResponse;
  if (!data.id || !data.secret) {
    throw new Error('stripe_webhook_provision_failed: Stripe response is missing id/secret');
  }
  return { endpointId: data.id, signingSecret: data.secret };
}

async function deleteStripeWebhookEndpoint(restrictedKey: string, endpointId: string): Promise<void> {
  const res = await fetch(`${STRIPE_API_BASE}/webhook_endpoints/${encodeURIComponent(endpointId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${restrictedKey}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`stripe_webhook_deprovision_failed: ${res.status} ${res.statusText}: ${text}`);
  }
}

// ── Connect ───────────────────────────────────────────────────────────────────

/**
 * Best-effort deprovision of a previously-registered endpoint before a
 * reconnect installs a new one. Never blocks the reconnect: the prior key
 * may already be rotated/revoked on the owner's Stripe dashboard, in which
 * case Stripe itself will reject the delete — that failure is logged and
 * swallowed, not surfaced, because leaving one orphaned endpoint behind is
 * far less harmful than refusing to let the owner rotate their key.
 */
async function bestEffortDeprovisionExisting(ownerDid: string): Promise<void> {
  const existing = await findWebhookIndexByOwner(ownerDid);
  if (!existing) return;

  try {
    const credentials = await stripe.loadSealedCredentials(ownerDid);
    if (credentials?.apiKey) {
      await deleteStripeWebhookEndpoint(credentials.apiKey, existing.endpointId);
    }
  } catch (err) {
    log.warn(
      { err: String(err), ownerDid },
      'Stripe connector: best-effort deprovision of the prior webhook endpoint failed — continuing reconnect',
    );
  }
}

/**
 * Connect: validate the pasted key is a restricted key, self-provision a
 * webhook endpoint on the owner's OWN Stripe account using that key, and
 * only then seal the key and the endpoint's signing secret.
 *
 * Provisioning happens BEFORE anything is sealed — a failed provision must
 * leave the connector exactly as unconnected as it was, never a sealed key
 * with no corresponding webhook (a half-connected state nothing else in this
 * module checks for).
 *
 * Throws:
 *   - `stripe_key_not_restricted` — the pasted key is not a restricted key
 *     (e.g. a full secret key was pasted instead).
 *   - `stripe_webhook_provision_failed` — Stripe rejected the endpoint
 *     creation (bad key, insufficient permissions, etc).
 */
export async function connectAndProvisionWebhook(
  ownerDid: string,
  restrictedKey: string,
  webhookBaseUrl: string,
): Promise<{ routingId: string; endpointId: string }> {
  const trimmedKey = restrictedKey.trim();
  if (!isRestrictedKey(trimmedKey)) {
    throw new Error(
      'stripe_key_not_restricted: paste a Stripe RESTRICTED key (starts with "rk_"), not a full secret key. ' +
      'Create one in the Stripe Dashboard under Developers → API keys → Create restricted key.',
    );
  }

  await bestEffortDeprovisionExisting(ownerDid);

  const routingId = generateId('stripewh');
  const url = `${webhookBaseUrl.replace(/\/+$/, '')}/stripe/api/webhook/${routingId}`;

  const { endpointId, signingSecret } = await createStripeWebhookEndpoint(trimmedKey, url);

  await stripe.sealApiKey(ownerDid, trimmedKey);
  await sealAndStore(webhookSecretField(ownerDid), signingSecret);
  await upsertWebhookIndex(routingId, ownerDid, endpointId);

  log.info({ ownerDid, endpointId }, 'Stripe connector: key sealed and webhook endpoint provisioned');
  return { routingId, endpointId };
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
      if (credentials?.apiKey) {
        await deleteStripeWebhookEndpoint(credentials.apiKey, existing.endpointId);
        deprovisioned = true;
      }
    } catch (err) {
      log.warn(
        { err: String(err), ownerDid },
        'Stripe connector: webhook deprovision failed — continuing disconnect',
      );
    }
    await deleteWebhookIndexByOwner(ownerDid);
  }

  await deleteFromVault(webhookSecretField(ownerDid));
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
  | { status: 'malformed_payload' };

/** String-coerce a Stripe object field for a bus payload, defaulting to ''. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

/** Number-coerce a Stripe object field for a bus payload, defaulting to 0. */
function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0) || 0;
}

/**
 * Republish one verified Stripe event onto the bus, gated by the owner's own
 * `stripe:events` grant — the owner must have opted in before their events
 * reach any reactor chain. Returns whether a bus event was actually
 * published (false for an event type with no mapping, or when the grant is
 * absent, or when publish itself failed).
 */
async function publishStripeEvent(ownerDid: string, event: StripeEventLike): Promise<boolean> {
  const hasGrant = await stripe.resolveActiveGrant(ownerDid, STRIPE_EVENTS_SCOPE);
  if (!hasGrant) {
    log.info(
      { ownerDid, eventType: event.type },
      'Stripe webhook: verified but no active stripe:events grant — not publishing',
    );
    return false;
  }

  const object = event.data?.object ?? {};
  const envelope = { issuer: ownerDid, subject: ownerDid, scope: 'stripe' } as const;

  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await publish('stripe.payment_intent.succeeded', {
          ...envelope,
          payload: {
            ownerDid,
            eventId: event.id,
            paymentIntentId: str(object.id),
            amount: num(object.amount),
            currency: str(object.currency).toUpperCase(),
            context_id: event.id,
            context_type: 'stripe',
          },
        });
        return true;
      case 'invoice.paid':
        await publish('stripe.invoice.paid', {
          ...envelope,
          payload: {
            ownerDid,
            eventId: event.id,
            invoiceId: str(object.id),
            amountPaid: num(object.amount_paid),
            currency: str(object.currency).toUpperCase(),
            context_id: event.id,
            context_type: 'stripe',
          },
        });
        return true;
      case 'payout.paid':
        await publish('stripe.payout.paid', {
          ...envelope,
          payload: {
            ownerDid,
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
        return true;
      default:
        log.info(
          { ownerDid, eventType: event.type },
          'Stripe webhook: verified event type has no bus mapping — ack only',
        );
        return false;
    }
  } catch (err) {
    log.error({ err: String(err), ownerDid, eventType: event.type }, 'Stripe webhook: bus publish failed');
    return false;
  }
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

  const signingSecret = await loadAndUnseal(webhookSecretField(owner.ownerDid));
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

  const published = await publishStripeEvent(owner.ownerDid, event);
  return { status: 'ok', published };
}
