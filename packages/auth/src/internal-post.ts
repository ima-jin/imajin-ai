import { getInternalApiKey, internalApiKeyUnavailableError, markInternalApiKeyUsed } from './internal-api-key';

let deprecatedKeyWarned = false;

/**
 * Resolves the shared secret used to authenticate every packages/auth
 * service-to-service call to the kernel's `ATTESTATION_INTERNAL_API_KEY`-gated
 * routes (`/api/attestations/internal`, `/api/attestations/chain-emit`,
 * `/api/eligibility/evaluate`, `/api/identity/:did/contact`).
 *
 * The value is vault-sourced (#2353): it is the key the service fetched at
 * boot via `bootstrapInternalApiKey()` (see `./internal-api-key`), never a
 * `process.env` read. `AUTH_INTERNAL_API_KEY` is still accepted as a
 * deprecated fallback for one release (#2037: the two names had drifted
 * apart, so this file once sent a key neither route ever checked and every
 * mechanical attestation forward was silently rejected). Warns once per
 * process — not once per call — so a misconfigured deployment shows up
 * without spamming the logs.
 */
export async function resolveInternalApiKey(): Promise<string | undefined> {
  const canonical = await getInternalApiKey();
  if (canonical) return canonical;

  const legacy = process.env.AUTH_INTERNAL_API_KEY;
  if (legacy && !deprecatedKeyWarned) {
    deprecatedKeyWarned = true;
    console.warn(
      '[auth] AUTH_INTERNAL_API_KEY is deprecated for attestation forwarding (#2037) — the vault-sourced ATTESTATION_INTERNAL_API_KEY (bootstrapInternalApiKey) is the supported source. This fallback will be removed in a future release.',
    );
  }
  return legacy;
}

export interface InternalPostOutcome<T> {
  /** Mirrors `Response.ok` — true for a 2xx status. */
  ok: boolean;
  status: number;
  /** Parsed JSON body, or `null` if parsing failed or the body was empty. */
  data: T | null;
}

/**
 * Shared service-to-service POST transport (#2058) used by every
 * packages/auth client of the kernel's internal-key-gated routes —
 * `evaluateEligibility`, `backfillContactEmail`, `emitAttestation`.
 * Extracted to fix a SonarCloud duplicated-lines finding: `evaluateEligibility`
 * (#1999) and `emitAttestation` (#1820/#2037) each hand-rolled this same
 * AUTH_SERVICE_URL + Bearer-token POST boilerplate, and `backfillContactEmail`
 * (#2058) would have made it a third near-identical copy.
 *
 * Resolves `AUTH_SERVICE_URL` and the internal API key, then performs the
 * POST with a `Content-Type: application/json` body and a
 * `Authorization: Bearer <key>` header.
 *
 * Returns `null` when the service isn't configured (no `AUTH_SERVICE_URL`)
 * — callers log their own "skipped" message in that case, same as before
 * this extraction. Fails closed (#2353): when `AUTH_SERVICE_URL` is set but no
 * internal API key was resolved, throws `InternalApiKeyUnavailableError`
 * (naming the purpose and the operator grant command) instead of returning
 * `null` or ever sending an empty `Authorization` header. Otherwise returns
 * `{ ok, status, data }`: `ok` mirrors `Response.ok` and `data` is the
 * parsed JSON body (or `null` if parsing failed or there was no body), so
 * each caller can log its own rejection message and apply any
 * caller-specific side effect (e.g. `emitAttestation`'s failure counter).
 *
 * Deliberately does not catch fetch/network errors (or the missing-key
 * error above) itself — those propagate so each caller can log its own error message with its own
 * context, exactly as each did before this extraction.
 */
export async function postInternal<T>(path: string, body: unknown): Promise<InternalPostOutcome<T> | null> {
  const authServiceUrl = process.env.AUTH_SERVICE_URL;
  if (!authServiceUrl) return null;

  const internalApiKey = await resolveInternalApiKey();
  if (!internalApiKey) throw internalApiKeyUnavailableError();

  const res = await fetch(`${authServiceUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${internalApiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (res.ok) markInternalApiKeyUsed();

  const data = (await res.json().catch(() => null)) as T | null;
  return { ok: res.ok, status: res.status, data };
}
