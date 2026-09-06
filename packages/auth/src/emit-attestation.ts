import { createLogger } from '@imajin/logger';
const log = createLogger('auth');

let deprecatedKeyWarned = false;
let forwardFailureCount = 0;

/**
 * Resolves the shared secret used to authenticate the service-to-service
 * calls below to the kernel's attestation routes
 * (`/api/attestations/internal`, `/api/attestations/chain-emit`) — both
 * routes check `ATTESTATION_INTERNAL_API_KEY` exclusively. `AUTH_INTERNAL_API_KEY`
 * is accepted as a deprecated fallback for one release (#2037: the two names
 * had drifted apart, so this file sent a key neither route ever checked and
 * every mechanical attestation forward was silently rejected). Warns once
 * per process — not once per call — so a misconfigured deployment shows up
 * without spamming the logs.
 */
export function resolveInternalApiKey(): string | undefined {
  const canonical = process.env.ATTESTATION_INTERNAL_API_KEY;
  if (canonical) return canonical;

  const legacy = process.env.AUTH_INTERNAL_API_KEY;
  if (legacy && !deprecatedKeyWarned) {
    deprecatedKeyWarned = true;
    console.warn(
      '[auth] AUTH_INTERNAL_API_KEY is deprecated for attestation forwarding (#2037) — set ATTESTATION_INTERNAL_API_KEY instead. This fallback will be removed in a future release.',
    );
  }
  return legacy;
}

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
}): Promise<void> {
  const authServiceUrl = process.env.AUTH_SERVICE_URL;
  const internalApiKey = resolveInternalApiKey();
  if (!authServiceUrl || !internalApiKey) {
    log.warn({}, 'Attestation skipped: AUTH_SERVICE_URL or ATTESTATION_INTERNAL_API_KEY not set');
    return;
  }

  // 1. Write attestation to DB via the internal API
  let issuedAt: string | undefined;
  try {
    const res = await fetch(`${authServiceUrl}/api/attestations/internal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${internalApiKey}`,
      },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      forwardFailureCount += 1;
      // Never log the key itself — status + route is enough to diagnose an
      // auth mismatch (#2037) without leaking the secret into logs.
      log.warn(
        { type: params.type, status: res.status, route: '/api/attestations/internal' },
        `Attestation (${params.type}) forward rejected`,
      );
      return;
    }
    // Capture issuedAt from the response for accurate chain timestamp
    const attestation = await res.json().catch(() => null) as Record<string, unknown> | null;
    issuedAt = typeof attestation?.['issuedAt'] === 'string' ? attestation['issuedAt'] : undefined;
  } catch (err) {
    log.error({ err: String(err) }, `Attestation (${params.type}) error`);
    return;
  }

  // 2. Emit DFOS content chain entry — fire-and-forget, non-fatal
  // Chain emission is handled by the kernel's chain-emit endpoint which
  // signs with the node's DFOS DID via createAttestationEntry() in dfos.ts.
  fetch(`${authServiceUrl}/api/attestations/chain-emit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${internalApiKey}`,
    },
    body: JSON.stringify({ ...params, issued_at: issuedAt }),
  }).then((res) => {
    if (res.ok) return;
    forwardFailureCount += 1;
    log.warn(
      { type: params.type, status: res.status, route: '/api/attestations/chain-emit' },
      `Attestation chain-emit (${params.type}) rejected`,
    );
  }).catch((err: unknown) => {
    log.warn({ err: String(err), type: params.type }, `Attestation chain-emit (${params.type}) error`);
  });
}
