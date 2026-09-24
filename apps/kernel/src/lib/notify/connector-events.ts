/**
 * Connector credential lifecycle + model-catalog change notifications
 * (#2205, follow-up to #1926/#2201).
 *
 * The kernel already pushes per-principal, real-time frames over one
 * transport — the authenticated WS channel `pushNotificationToDid` fans out
 * to (`ws-push.ts`, #1644). This module reuses that transport verbatim; it
 * does not open a new one. The three scopes below let a WS-connected
 * consumer — starting with the OpenClaw `imajin` model provider plugin,
 * ima-jin/openclaw-imajin-plugin#37 — invalidate its usable-model cache
 * sub-TTL instead of polling on a stale one:
 *
 *   - `connector.credential.sealed`   — a provider credential was sealed.
 *   - `connector.credential.unsealed` — a sealed credential was unsealed or
 *     removed (a disconnect that actually revoked something).
 *   - `connector.models.changed`      — the caller's usable-model catalog
 *     (`GET /infer/v1/models/usable`, #2201/PR #2203) may have changed.
 *
 * `models.changed` fires whenever a credential transition can move the
 * *inference* catalog specifically — sealing/unsealing a non-brain
 * connector (Stripe, GCP, …) still emits its own credential scope but never
 * `models.changed`. Membership is read from the existing, single source of
 * truth for "does this connector have a model catalog at all" —
 * `CONNECTOR_REGISTRY`'s own `modelsRoute` (non-null exactly for the brain
 * connectors `resolveBrain`/`listUsableBrains` walk) — rather than a second,
 * hand-maintained connector-id list that could drift from it.
 *
 * ## Payload shape (deviation from the issue's literal proposal, flagged in
 * the PR body)
 * The issue's proposal sketches a bespoke frame — `type` mirroring the scope
 * string, with top-level `principal`/`ts`/`payload` fields. The kernel's
 * existing per-DID push (`buildNotificationFrame`/`pushNotificationToDid`)
 * already has its own generic envelope — `type: 'notification'`, plus
 * `id`/`scope`/`title`/`body`/`data`/`createdAt` — and the consumer plugin
 * (PR #37) was written against exactly that shape: it filters on
 * `frame.type === 'notification'` and `frame.scope`. This module reuses
 * that existing envelope rather than inventing a second one: `data` carries
 * `{ provider, hint }` (no model list, no credential material — exactly the
 * fields the issue asked for), `createdAt` is the `ts`, and the recipient
 * DID `pushNotificationToDid` sends to is already the "principal" scoping.
 *
 * ## Best-effort by contract
 * Every failure — a DB error, a push error, an unknown provider — is caught
 * and logged inside {@link emitConnectorNotification} and never rethrown, so
 * a notifier fault can never fail the seal/unseal/update operation that
 * triggered it. Mirrors the existing fail-open precedent in
 * `connector-registry-store.ts` (`recordConnectorRegistration` /
 * `revokeConnectorRegistration`): the caller invokes these directly, with no
 * try/catch of its own, because the guarantee lives here.
 *
 * Deliberately skips the email leg and the per-scope `preferences` opt-out
 * `/notify/api/send` honors: these are small, secret-free technical hints
 * for a specific WS-connected consumer, not user-facing notifications — an
 * owner has no reason to disable them independently of just disconnecting
 * the socket.
 */
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, notifications } from '@/src/db';
import { getConnector } from '@/src/lib/kernel/connector-registry';
import { getTemplate } from './template-store';
import { buildNotificationFrame, pushNotificationToDid } from './ws-push';

const log = createLogger('kernel');

export const CONNECTOR_CREDENTIAL_SEALED_SCOPE = 'connector.credential.sealed';
export const CONNECTOR_CREDENTIAL_UNSEALED_SCOPE = 'connector.credential.unsealed';
export const CONNECTOR_MODELS_CHANGED_SCOPE = 'connector.models.changed';

/** Advisory reason attached to a `connector.models.changed` frame — never authoritative; consumers must re-pull #2201. */
export type ConnectorModelsChangedHint = 'credential-sealed' | 'credential-unsealed' | 'catalog-update';

interface ConnectorNotificationPayload {
  /** `CONNECTOR_REGISTRY` id, e.g. `'gemini'`. Never credential material. */
  provider: string;
  hint?: ConnectorModelsChangedHint;
}

/**
 * Persist + push one connector lifecycle/catalog-change notification over
 * the existing per-DID WS transport. Never throws — see the module doc's
 * "Best-effort by contract" section.
 *
 * A `notifications` row is written first because `pushNotificationToDid`'s
 * WS-send claim (`claimNotificationForWsSend`, delivery.ts) is itself a row
 * update keyed by id — the same persist-then-push shape `/notify/api/send`
 * uses, minus that route's HTTP/webhook/email legs, which do not apply to a
 * server-internal technical signal.
 */
async function emitConnectorNotification(
  principalDid: string,
  scope: string,
  payload: ConnectorNotificationPayload,
): Promise<void> {
  try {
    const id = `ntf_${nanoid(16)}`;
    const createdAt = new Date();
    const template = await getTemplate(scope);
    const title = template ? template.title(payload) : scope;

    await db.insert(notifications).values({
      id,
      recipientDid: principalDid,
      scope,
      urgency: 'low',
      title,
      body: null,
      data: payload,
      channelsSent: [],
      read: false,
      createdAt,
    });

    // `payload` has no index signature of its own, so it needs an explicit
    // widening to satisfy `data`'s `Record<string, unknown>` shape here —
    // still no `any`, and the DB insert above accepts it structurally as-is.
    const frame = buildNotificationFrame({
      id,
      scope,
      title,
      data: payload as unknown as Record<string, unknown>,
      createdAt,
    });
    const delivered = await pushNotificationToDid(principalDid, frame);

    await db
      .update(notifications)
      .set({ channelsSent: delivered ? ['inapp', 'ws'] : ['inapp'] })
      .where(eq(notifications.id, id));
  } catch (err) {
    log.error(
      { err: String(err), scope, principalDid, provider: payload.provider },
      'Connector lifecycle notification failed — continuing without blocking the underlying operation',
    );
  }
}

/**
 * True when a provider's credential changing can change the caller's
 * usable-model catalog (#2201's `listUsableBrains`) — derived from
 * `CONNECTOR_REGISTRY`'s own `modelsRoute` (see module doc).
 */
function affectsModelCatalog(provider: string): boolean {
  return getConnector(provider)?.modelsRoute != null;
}

/** Emit `connector.models.changed` directly — e.g. for a future model-picker or provider-toggle call site. */
export async function notifyConnectorModelsChanged(
  principalDid: string,
  provider: string,
  hint: ConnectorModelsChangedHint,
): Promise<void> {
  await emitConnectorNotification(principalDid, CONNECTOR_MODELS_CHANGED_SCOPE, { provider, hint });
}

/** Emit `connector.credential.sealed`, plus `connector.models.changed` when `provider` feeds the inference catalog. */
export async function notifyConnectorCredentialSealed(principalDid: string, provider: string): Promise<void> {
  await emitConnectorNotification(principalDid, CONNECTOR_CREDENTIAL_SEALED_SCOPE, { provider });
  if (affectsModelCatalog(provider)) {
    await notifyConnectorModelsChanged(principalDid, provider, 'credential-sealed');
  }
}

/** Emit `connector.credential.unsealed`, plus `connector.models.changed` when `provider` feeds the inference catalog. */
export async function notifyConnectorCredentialUnsealed(principalDid: string, provider: string): Promise<void> {
  await emitConnectorNotification(principalDid, CONNECTOR_CREDENTIAL_UNSEALED_SCOPE, { provider });
  if (affectsModelCatalog(provider)) {
    await notifyConnectorModelsChanged(principalDid, provider, 'credential-unsealed');
  }
}
