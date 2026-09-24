/**
 * VAPID keypair for Web Push (#2291 — phone push path).
 *
 * Follows the #2245 "kernel-internal, self-provisioned secret" ruling
 * (single in-process consumer, never fanned out to another service) rather
 * than the cross-service `loadFromVault` handoff (#2241/#2243,
 * `packages/auth/src/vault-client.ts`) — a VAPID keypair is only ever used
 * by this kernel process to sign its own web-push requests, so there is no
 * second service to authenticate as. `getOrGenerateInternalSecret`
 * (`../vault/internal-secret.ts`) already implements the generate-once/
 * self-grant/fetch-thereafter/provisioning-race contract this reuses
 * verbatim; the only new part here is the generator (a real VAPID keypair,
 * serialized as one JSON string, instead of an opaque random token) and
 * parsing it back out.
 *
 * Never hand-pasted via `.env` — there is no `VAPID_PUBLIC_KEY` /
 * `VAPID_PRIVATE_KEY` var anywhere in this codebase. `VAPID_SUBJECT` is the
 * one plain env var this module reads, and it is not a secret: it is the
 * mailto/URL contact web-push's own spec requires every VAPID JWT to carry
 * (RFC 8292), the same way an email's `From:` header names a sender.
 */
import { generateVAPIDKeys } from 'web-push';
import { createLogger } from '@imajin/logger';
import { getOrGenerateInternalSecret } from '../vault/internal-secret';

const log = createLogger('kernel:notify');

/** Purpose string the self-provisioned grant is filed under (see internal-secret.ts). */
export const VAPID_KEYS_PURPOSE = 'notify.web-push-vapid-keys';

export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

/** The one-time generator handed to `getOrGenerateInternalSecret` — a real VAPID keypair, not random bytes. */
function generateVapidKeyPairJson(): string {
  const { publicKey, privateKey } = generateVAPIDKeys();
  return JSON.stringify({ publicKey, privateKey });
}

function parseVapidKeyPair(raw: string): VapidKeyPair | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const candidate = parsed as Partial<VapidKeyPair> | null;
  if (candidate && typeof candidate.publicKey === 'string' && typeof candidate.privateKey === 'string') {
    return { publicKey: candidate.publicKey, privateKey: candidate.privateKey };
  }
  return null;
}

/**
 * Resolve the node's VAPID keypair, self-provisioning it on first call.
 * Returns `null` (never throws) on any failure — every caller treats a
 * missing keypair as "skip the web-push leg for now", the same soft-fail
 * posture `loadCorpusIdentity` uses for a missing signing identity. The
 * persisted notification/approval row is the authority regardless; a
 * degraded web-push leg is never a reason to fail a request.
 */
export async function getVapidKeys(): Promise<VapidKeyPair | null> {
  try {
    const raw = await getOrGenerateInternalSecret(VAPID_KEYS_PURPOSE, generateVapidKeyPairJson);
    const parsed = parseVapidKeyPair(raw);
    if (!parsed) {
      log.error({}, 'vapid: stored keypair could not be parsed — web-push disabled until this is resolved');
      return null;
    }
    return parsed;
  } catch (err) {
    log.warn({ err: String(err) }, 'vapid: keypair unavailable — web-push disabled for now');
    return null;
  }
}

/**
 * The `subject` web-push's `setVapidDetails` requires (RFC 8292) — a
 * mailto: or https: contact the receiving push service may use to reach
 * the sender. Not secret: `VAPID_SUBJECT` is a plain, optional env var
 * (see `.env.example`), falling back to the node's own public origin, then
 * a generic mailto as a last resort so a fresh node never fails to send
 * purely for lack of this one cosmetic field.
 */
export function resolveVapidSubject(): string {
  return process.env.VAPID_SUBJECT || process.env.APP_URL || 'mailto:ops@imajin.ai';
}

/** The public half only, for the browser's `PushManager.subscribe({applicationServerKey})` — see the push-subscriptions route. */
export async function getVapidPublicKey(): Promise<string | null> {
  const keys = await getVapidKeys();
  return keys?.publicKey ?? null;
}
