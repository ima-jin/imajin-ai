import { createLogger } from '@imajin/logger';
const log = createLogger('auth');

export async function emitAttestation(params: {
  issuer_did: string;
  subject_did: string;
  type: string;
  context_id: string;
  context_type: string;
  payload?: Record<string, unknown>;
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
