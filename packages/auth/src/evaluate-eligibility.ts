import { createLogger } from '@imajin/logger';
import { postInternal } from './internal-post';

const log = createLogger('auth');

export interface EligibilityEvaluation {
  did: string;
  tier: string;
  upgraded: boolean;
}

/**
 * Service-to-service call to the kernel's `POST /api/eligibility/evaluate`
 * (#1999) — the single owner of the hard (established) verification
 * tier-upgrade rule. Re-evaluates `did` and performs the tier upgrade +
 * attestation emission atomically inside the kernel when eligible.
 *
 * Idempotent — safe to call repeatedly for the same DID; a no-op once
 * already upgraded (or never eligible). Mirrors emitAttestation's transport
 * (Bearer `ATTESTATION_INTERNAL_API_KEY`, same fire-and-forget calling
 * convention): callers should `.catch()` this and never block a
 * user-facing response on it. Never throws — returns `null` when the call
 * could not be completed (misconfiguration or transport/HTTP error).
 */
export async function evaluateEligibility(did: string): Promise<EligibilityEvaluation | null> {
  try {
    const outcome = await postInternal<EligibilityEvaluation>('/api/eligibility/evaluate', { did });
    if (!outcome) {
      log.warn({}, 'Eligibility evaluation skipped: AUTH_SERVICE_URL or ATTESTATION_INTERNAL_API_KEY not set');
      return null;
    }
    if (!outcome.ok) {
      log.warn({ did, status: outcome.status }, 'Eligibility evaluation rejected');
      return null;
    }
    return outcome.data;
  } catch (err) {
    log.error({ err: String(err), did }, 'Eligibility evaluation error');
    return null;
  }
}
