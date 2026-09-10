import { createLogger } from '@imajin/logger';
import { postInternal } from './internal-post';

const log = createLogger('auth');

let forwardFailureCount = 0;

// Re-exported for existing importers (evaluate-eligibility.ts,
// backfill-contact-email.ts, and any external callers) — the
// implementation moved to ./internal-post alongside the new shared
// postInternal() helper (#2058) so both live next to each other.
export { resolveInternalApiKey } from './internal-post';

/**
 * Count of attestation-forward requests (the internal write or the
 * chain-emit fan-out) that received a non-2xx response since process start.
 * Surfaced on `/auth/api/health` (#2037) so a 100% reject rate — e.g. from a
 * misconfigured internal API key — can't hide silently again.
 */
export function getAttestationForwardFailureCount(): number {
  return forwardFailureCount;
}

/** Test-only escape hatch: the module-level counter survives across calls on purpose. */
export function _resetAttestationForwardFailureCountForTests(): void {
  forwardFailureCount = 0;
}

export async function emitAttestation(params: {
  issuer_did: string;
  subject_did: string;
  type: string;
  context_id: string;
  context_type: string;
  payload?: Record<string, unknown>;
  expires_at?: string;
  /**
   * True when this attestation is genuinely awaiting the subject's
   * counter-signature (bilateral flow) rather than a one-shot system
   * attestation. Threaded through to the internal route's `attestation.created`
   * publish as `pendingSignature` (#1820). Defaults to false — callers must opt
   * in explicitly so the ~15 one-shot attestation types (vouch, receipts,
   * identity, etc.) never trigger a counterparty notification.
   */
  pending?: boolean;
  /**
   * The originating app's URL, when the caller can supply one (#1820). This is
   * a server-to-server call with no `Origin` header, so it can never be
   * derived from the request itself — callers that want a deep link in the
   * pending-signature notification must pass it explicitly.
   */
  originUrl?: string;
}): Promise<{ attestationId?: string }> {
  // 1. Write attestation to DB via the internal API
  let issuedAt: string | undefined;
  let attestationId: string | undefined;
  try {
    const outcome = await postInternal<Record<string, unknown>>('/api/attestations/internal', params);
    if (!outcome) {
      log.warn({}, 'Attestation skipped: AUTH_SERVICE_URL or ATTESTATION_INTERNAL_API_KEY not set');
      return {};
    }
    if (!outcome.ok) {
      forwardFailureCount += 1;
      // Never log the key itself — status + route is enough to diagnose an
      // auth mismatch (#2037) without leaking the secret into logs.
      log.warn(
        { type: params.type, status: outcome.status, route: '/api/attestations/internal' },
        `Attestation (${params.type}) forward rejected`,
      );
      return {};
    }
    // Capture issuedAt from the response for accurate chain timestamp
    issuedAt = typeof outcome.data?.['issuedAt'] === 'string' ? (outcome.data['issuedAt'] as string) : undefined;
    // #2016: capture the created attestation's id so callers (the `mjn`
    // reactor, via `attestationReactor`) can link an emission mint back to
    // the attestation that justified it.
    attestationId = typeof outcome.data?.['id'] === 'string' ? (outcome.data['id'] as string) : undefined;
  } catch (err) {
    log.error({ err: String(err) }, `Attestation (${params.type}) error`);
    return {};
  }

  // 2. Emit DFOS content chain entry — fire-and-forget, non-fatal
  // Chain emission is handled by the kernel's chain-emit endpoint which
  // signs with the node's DFOS DID via createAttestationEntry() in dfos.ts.
  postInternal('/api/attestations/chain-emit', { ...params, issued_at: issuedAt }).then((outcome) => {
    if (!outcome || outcome.ok) return;
    forwardFailureCount += 1;
    log.warn(
      { type: params.type, status: outcome.status, route: '/api/attestations/chain-emit' },
      `Attestation chain-emit (${params.type}) rejected`,
    );
  }).catch((err: unknown) => {
    log.warn({ err: String(err), type: params.type }, `Attestation chain-emit (${params.type}) error`);
  });

  return { attestationId };
}
