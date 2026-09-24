/**
 * Forwards corpus-signed `IngestionAttestation`s to the kernel's durable
 * `auth.attestations` record (#1750), mirroring the two-phase pattern in
 * `packages/auth/src/emit-attestation.ts` — corpus reuses the same
 * `POST {AUTH_SERVICE_URL}/api/attestations/internal` route
 * (`apps/kernel/app/auth/api/attestations/internal/route.ts`) every other
 * service-to-service attestation write goes through, rather than inventing
 * a new kernel endpoint.
 *
 * Auth: that route checks `Authorization: Bearer ${ATTESTATION_INTERNAL_API_KEY}`
 * — note this is the *route's* own env var name, distinct from
 * `AUTH_INTERNAL_API_KEY` (which `emit-attestation.ts` sends, and which the
 * route does NOT check). Corpus sends `ATTESTATION_INTERNAL_API_KEY` so the
 * request actually authenticates; see the PR description for the
 * pre-existing `emit-attestation.ts` mismatch this surfaced.
 *
 * The key itself is vault-sourced (#2245) — see `attestation-key.ts` for
 * the fetch-at-boot contract (dynamic grant discovery, deprecated env
 * fallback, deferred ack). This module only reads the resolved value via
 * `getAttestationInternalApiKey()` and reports first use.
 *
 * The kernel route always re-signs the stored envelope with its own
 * `AUTH_PRIVATE_KEY` — it does not (and structurally cannot, since it never
 * sees the corpus private key) verify the corpus's own signature. The full
 * corpus-signed `IngestionAttestation` (including its own `signature` field)
 * rides inside `payload` so the independently-verifiable corpus signature
 * survives the round trip; `GET /corpus/:did/attestations/:id` is what lets
 * a caller check it without trusting the kernel's re-signature at all.
 */
import { createLogger } from '@imajin/logger';
import type { IngestionAttestation } from '../engine/types';
import { getAttestationInternalApiKey, markAttestationKeyUsedForForwarding } from './attestation-key';

const log = createLogger('corpus');

export interface ForwardResult {
  ok: boolean;
  kernelAttestationId?: string;
  error?: string;
}

interface InternalAttestationResponse {
  id?: string;
}

/**
 * POSTs `attestation` to the kernel's internal attestation endpoint as a
 * `corpus.ingested` fact. Never throws — every failure mode (missing env,
 * network error, non-2xx response) resolves to `{ ok: false, error }` so
 * callers can persist the outcome locally and retry later, per #1750's
 * "bounded retry on next ingest" requirement.
 */
export async function forwardIngestionAttestation(
  attestation: IngestionAttestation,
  corpusServiceDid: string,
): Promise<ForwardResult> {
  const authServiceUrl = process.env.AUTH_SERVICE_URL;
  const internalApiKey = getAttestationInternalApiKey();

  if (!authServiceUrl || !internalApiKey) {
    return { ok: false, error: 'AUTH_SERVICE_URL or ATTESTATION_INTERNAL_API_KEY not set — forward skipped' };
  }

  try {
    const res = await fetch(`${authServiceUrl}/api/attestations/internal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${internalApiKey}`,
      },
      body: JSON.stringify({
        issuer_did: corpusServiceDid,
        subject_did: attestation.corpusDid,
        type: 'corpus.ingested',
        context_id: attestation.source,
        context_type: 'corpus_source',
        payload: { ...attestation },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `kernel responded ${res.status}: ${text}` };
    }

    // First successful forward using the vault-sourced key sends its
    // deferred #2257 ack; a no-op under the deprecated env override or when
    // nothing was fetched (see attestation-key.ts).
    markAttestationKeyUsedForForwarding();

    const body: InternalAttestationResponse | null = await res.json().catch(() => null);
    return { ok: true, kernelAttestationId: body?.id };
  } catch (err) {
    log.warn({ err: String(err), attestationId: attestation.id }, 'Ingestion attestation forward failed');
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
