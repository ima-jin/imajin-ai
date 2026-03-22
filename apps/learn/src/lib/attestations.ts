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
    console.warn('Attestation skipped: AUTH_SERVICE_URL or AUTH_INTERNAL_API_KEY not set');
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
      console.error(`Attestation (${params.type}) failed: ${res.status} ${text}`);
    }
  } catch (err) {
    console.error(`Attestation (${params.type}) error:`, err);
  }
}
