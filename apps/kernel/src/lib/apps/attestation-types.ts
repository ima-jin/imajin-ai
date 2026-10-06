/**
 * App-namespaced attestation-type seeding (#2375, 2026-09-26 refinement).
 *
 * Attestation types an app declares are namespaced `<slug>/<type>` (e.g.
 * `dykil/survey-response`) and owned by the app DID whose slug it carries.
 * This module is the SEEDING half only — `apps.provision`'s optional
 * `attestationTypes: string[]` param — reusing the EXISTING registry-as-data
 * mechanism (`registerAttestationType`, #1885) with `handle: slug` and
 * `registeredByDid: appDid` rather than a parallel table. Ongoing
 * self-service registration by the app's own app-auth (updating/adding
 * types after provisioning) rides the same `registerAttestationType`
 * function via `POST /auth/api/attestations/types` and is unchanged by
 * this module — see the PR description's DECISION card on whether that
 * route's `requireEstablishedDID` gate should also accept app-auth calls.
 */
import { registerAttestationType, type RegisterAttestationTypeResult } from '@/src/lib/auth/attestation-type-registry';
import { forEachSequential } from '@/src/lib/async/sequential';

export interface AttestationTypeSeedOutcome {
  type: string;
  ok: boolean;
  error?: string;
}

/**
 * Split `type` into `{prefix, localName}` on the first `/`, or null when
 * `type` carries no namespace separator at all.
 */
function splitNamespacedType(type: string): { prefix: string; localName: string } | null {
  const separatorIndex = type.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === type.length - 1) return null;
  return { prefix: type.slice(0, separatorIndex), localName: type.slice(separatorIndex + 1) };
}

/**
 * Seed one namespaced attestation type for a freshly (or already)
 * provisioned app. Refuses (never throws) any type whose prefix is not
 * EXACTLY `slug` — this is the "refused outside the app's own slug prefix"
 * rule from the 2026-09-26 refinement, enforced here independent of
 * `registerAttestationType`'s own reserved-namespace check.
 */
async function seedOne(appDid: string, slug: string, type: string): Promise<AttestationTypeSeedOutcome> {
  const split = splitNamespacedType(type);
  if (!split) {
    return { type, ok: false, error: `'${type}' must be namespaced as '${slug}/<type>'` };
  }
  if (split.prefix !== slug) {
    return { type, ok: false, error: `'${type}' is outside the '${slug}/' namespace this app owns — refused` };
  }

  const result: RegisterAttestationTypeResult = await registerAttestationType({
    registeredByDid: appDid,
    handle: slug,
    localName: split.localName,
  });
  if (!result.ok) {
    return { type, ok: false, error: result.error };
  }
  return { type, ok: true };
}

/**
 * Seed every requested attestation type for `slug`/`appDid`, one at a
 * time. Partial success is expected and reported per-type — a single
 * refused/duplicate type must never fail the rest of the provisioning
 * pipeline, since the attestation-types step is optional and additive.
 */
export async function seedAttestationTypes(
  appDid: string,
  slug: string,
  types: readonly string[],
): Promise<AttestationTypeSeedOutcome[]> {
  const outcomes: AttestationTypeSeedOutcome[] = [];
  // Sequential on purpose: registry writes happen in declaration order, so outcomes line up with `types`.
  await forEachSequential(types, async (type) => {
    outcomes.push(await seedOne(appDid, slug, type));
  });
  return outcomes;
}
