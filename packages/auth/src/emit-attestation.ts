import { createLogger } from '@imajin/logger';
const log = createLogger('auth');

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
  const internalApiKey = process.env.AUTH_INTERNAL_API_KEY;
  if (!authServiceUrl || !internalApiKey) {
    log.warn({}, 'Attestation skipped: AUTH_SERVICE_URL or AUTH_INTERNAL_API_KEY not set');
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
      const text = await res.text().catch(() => '');
      log.error({ type: params.type, status: res.status, text }, `Attestation (${params.type}) failed`);
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
  }).catch((err: unknown) => {
    log.warn({ err: String(err), type: params.type }, `Attestation chain-emit (${params.type}) error`);
  });
}
