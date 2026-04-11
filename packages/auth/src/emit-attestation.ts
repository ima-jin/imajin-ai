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
    }
  } catch (err) {
    log.error({ err: String(err) }, `Attestation (${params.type}) error`);
  }
}
