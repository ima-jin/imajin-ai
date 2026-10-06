/**
 * Shared auth preamble for kernel service-to-service routes gated on the
 * `ATTESTATION_INTERNAL_API_KEY` Bearer token (#1999 — extracted to fix a
 * SonarCloud duplicated-lines finding).
 *
 * `POST /api/attestations/internal`, `POST /api/attestations/chain-emit`,
 * `POST /api/eligibility/evaluate`, `POST /api/apps/validate`,
 * `POST /api/credentials/resolve`, `POST /api/identity/:did/contact`, and
 * `GET /api/groups/:groupDid/controllers/:controllerDid` each started with
 * the identical four-line Bearer-token check. Factored out once rather than
 * repeated a further time.
 *
 * ## Vault-sourced (#2245 — second target of the #2241 epic)
 * The key itself is no longer a hand-set env var: the kernel self-provisions
 * and self-grants it via `getInternalSecret` (see `internal-secret.ts`'s
 * docblock for the full generate/fetch/concurrency contract), and
 * separately grants the SAME value to corpus (`grantInternalSecretTo`,
 * `shared-internal-secret.ts`) so it can forward ingestion attestations
 * here. The vault is the ONLY source (#2353 step 4): the deprecated
 * `process.env.ATTESTATION_INTERNAL_API_KEY` fallback has been removed now
 * that every caller (corpus and every userspace service via
 * `packages/auth/src/internal-post.ts`) fetches the value from the vault.
 * A request with no vault value to compare against is rejected (401).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { getInternalSecret } from '../vault/internal-secret';

const log = createLogger('kernel');

/**
 * Purpose label for the vault-generated, self-provisioned
 * `ATTESTATION_INTERNAL_API_KEY` (#2245) — see `getInternalSecret` and
 * `grantInternalSecretTo`. Also referenced (as a literal, apps/corpus
 * cannot import apps/kernel internals) by
 * `apps/corpus/src/lib/attestation-key.ts` and
 * `scripts/grant-attestation-internal-api-key.ts`; keep all three in sync.
 */
export const ATTESTATION_INTERNAL_API_KEY_PURPOSE = 'kernel.attestation-internal-api-key';

/**
 * Verify the request's `Authorization: Bearer <key>` header against the
 * vault-sourced `ATTESTATION_INTERNAL_API_KEY` (vault-only — see this
 * module's docblock).
 *
 * Returns a ready-to-return 401 `NextResponse` (same shape every caller used
 * before this extraction: `{ error: 'Unauthorized' }`) when the caller's key
 * doesn't match, or the vault value could not be resolved (fail closed), or
 * `null` when the caller is authorized.
 *
 * Usage:
 *   const authError = await requireInternalApiKey(request);
 *   if (authError) return authError;
 */
export async function requireInternalApiKey(request: NextRequest): Promise<NextResponse | null> {
  const authHeader = request.headers.get('authorization');
  const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  if (!apiKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let expectedKey: string | null = null;
  try {
    expectedKey = await getInternalSecret(ATTESTATION_INTERNAL_API_KEY_PURPOSE);
  } catch (err) {
    // Fail closed on a vault hiccup, and say so loudly — there is no env
    // fallback to fall back to (#2353 step 4).
    log.error({ err: String(err) }, 'requireInternalApiKey: getInternalSecret failed — rejecting (no env fallback)');
  }

  if (expectedKey && apiKey === expectedKey) {
    return null;
  }

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
