import { db } from '@/src/db';
import type { Logger } from '@imajin/logger';

type LoggerLike = Pick<Logger, 'error'>;

const CONNECTIONS_URL = process.env.CONNECTIONS_URL!;
const TRUST_INTERNAL_API_KEY = process.env.TRUST_INTERNAL_API_KEY!;

export interface QueryProfile {
  did: string;
  displayName: string | null;
  featureToggles: { inference_enabled?: boolean } | null;
}

export type ResolveQueryProfileResult =
  | { ok: true; profile: QueryProfile }
  | { ok: false; error: string; status: number };

/** Look up a presence target profile by DID or handle and verify inference is enabled for it. */
export async function resolveQueryProfile(targetDid: string): Promise<ResolveQueryProfileResult> {
  const profile = await db.query.profiles.findFirst({
    where: (profiles, { eq, or }) => or(eq(profiles.did, targetDid), eq(profiles.handle, targetDid)),
  });

  if (!profile) {
    return { ok: false, error: 'Profile not found', status: 404 };
  }
  if (!profile.featureToggles?.inference_enabled) {
    return { ok: false, error: 'Inference not enabled for this profile', status: 403 };
  }

  return { ok: true, profile };
}

export type TrustDistanceResult =
  | { ok: true; trustDistance: number }
  | { ok: false; error: string; status: number };

export interface TrustDistanceMessages {
  notConnected: string;
  tooFar: string;
}

async function fetchTrustDistance(requesterDid: string, targetDid: string): Promise<{ connected: boolean; distance: number } | null> {
  const trustRes = await fetch(
    `${CONNECTIONS_URL}/api/trust/distance?from=${encodeURIComponent(requesterDid)}&to=${encodeURIComponent(targetDid)}`,
    { headers: { Authorization: `Bearer ${TRUST_INTERNAL_API_KEY}` } },
  );
  if (!trustRes.ok) return null;
  return trustRes.json();
}

/**
 * Check the requester's trust distance to the target profile (skipped for
 * self-queries). Two failure modes on a fetch/non-ok response, matching the
 * two callers' original behavior exactly:
 *  - `strict: true` (query route): a failed distance check is a hard 502.
 *  - `strict: false` (stream route): the trust service being down is
 *    permissive — the query proceeds with `trustDistance: 0`.
 */
export async function checkTrustDistance(
  requesterDid: string,
  targetDid: string,
  isSelf: boolean,
  options: { strict: boolean; messages: TrustDistanceMessages },
): Promise<TrustDistanceResult> {
  if (isSelf) return { ok: true, trustDistance: 0 };

  let trustData: { connected: boolean; distance: number } | null;
  if (options.strict) {
    trustData = await fetchTrustDistance(requesterDid, targetDid);
    if (!trustData) return { ok: false, error: 'Failed to check trust distance', status: 502 };
  } else {
    try {
      trustData = await fetchTrustDistance(requesterDid, targetDid);
    } catch {
      trustData = null;
    }
    if (!trustData) return { ok: true, trustDistance: 0 };
  }

  if (!trustData.connected) {
    return { ok: false, error: options.messages.notConnected, status: 403 };
  }
  if (trustData.distance > 2) {
    return { ok: false, error: options.messages.tooFar, status: 403 };
  }
  return { ok: true, trustDistance: trustData.distance };
}

export interface PresenceData {
  config?: Record<string, unknown>;
  soul?: string;
  context?: string;
}

/** Fetch presence config/soul/context from the media service. Fails open to `{}`. */
export async function fetchPresenceData(targetDid: string): Promise<PresenceData> {
  const MEDIA_URL = process.env.MEDIA_SERVICE_URL!;
  const MEDIA_INTERNAL_API_KEY = process.env.MEDIA_INTERNAL_API_KEY!;

  try {
    const presenceRes = await fetch(
      `${MEDIA_URL}/api/presence/${encodeURIComponent(targetDid)}`,
      { headers: { Authorization: `Bearer ${MEDIA_INTERNAL_API_KEY}` } },
    );
    if (presenceRes.ok) {
      return await presenceRes.json();
    }
  } catch {
    // Non-fatal: proceed with defaults
  }
  return {};
}

/**
 * Settle the inference cost via the pay service (non-fatal): the
 * presence-owner receives `1 - PLATFORM_FEE_PERCENT` of the cost, the
 * platform receives the rest. Returns whether settlement succeeded; never
 * throws (settlement failures shouldn't affect the response already
 * computed by the caller).
 *
 * `log`/`logFailureMessage`/`logErrorMessage` are optional so each caller
 * can preserve its own original logging behavior (the query route logs
 * failed/erroring settlement attempts; the stream route settles silently).
 */
export async function settleQueryCost(params: {
  cost: number;
  isSelf: boolean;
  requesterDid: string;
  resolvedTargetDid: string;
  queryId: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  log?: LoggerLike;
  logFailureMessage?: string;
  logErrorMessage?: string;
}): Promise<boolean> {
  const {
    cost, isSelf, requesterDid, resolvedTargetDid, queryId, modelId, promptTokens, completionTokens,
    log, logFailureMessage, logErrorMessage,
  } = params;
  if (cost <= 0 || isSelf) return false;

  const payUrl = process.env.PAY_SERVICE_URL;
  const payKey = process.env.PAY_SERVICE_API_KEY;
  const platformDid = process.env.PLATFORM_DID;
  if (!payUrl || !payKey || !platformDid) return false;

  const platformFee = Number.parseFloat(process.env.PLATFORM_FEE_PERCENT ?? '0.2'); // 20% default
  const platformAmount = +(cost * platformFee).toFixed(6);
  const targetAmount = +(cost - platformAmount).toFixed(6);

  try {
    const settleRes = await fetch(`${payUrl}/api/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${payKey}` },
      body: JSON.stringify({
        from_did: requesterDid,
        total_amount: cost,
        service: 'inference',
        type: 'query',
        fair_manifest: {
          chain: [
            { did: resolvedTargetDid, amount: targetAmount, role: 'presence-owner' },
            { did: platformDid, amount: platformAmount, role: 'infrastructure' },
          ],
        },
        metadata: { queryId, model: modelId, promptTokens, completionTokens },
      }),
    });
    if (!settleRes.ok && log && logFailureMessage) {
      log.error({ err: await settleRes.text().catch(() => '') }, logFailureMessage);
    }
    return settleRes.ok;
  } catch (err) {
    if (log && logErrorMessage) {
      log.error({ err: String(err) }, logErrorMessage);
    }
    return false;
  }
}
