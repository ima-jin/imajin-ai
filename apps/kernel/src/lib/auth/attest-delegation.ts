/**
 * App-delegated attestation grant capabilities (#2394): `attest:<appId>:<type>`.
 *
 * `packages/auth/src/grant-scopes.ts` owns the DB-free capability *shape*
 * (parseAttestDelegationCapability / buildAttestDelegationCapability). This
 * module is the DB-aware half: resolving whether a candidate capability
 * string names a live, active `registry.apps` (#1990) row and a known
 * attestation type, for `POST /auth/api/grants` issuance
 * (apps/kernel/src/lib/auth/grants.ts).
 *
 * Deliberately independent of apps/kernel/src/lib/kernel/app-registry.ts,
 * which pulls in `next/server` for its `appNotRegisteredResponse` helper —
 * this module is imported from grants.ts, a plain lib module with no
 * Next.js runtime dependency of its own.
 */
import { eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { ATTESTATION_TYPES, parseAttestDelegationCapability } from '@imajin/auth';
import { isRegisteredAttestationType } from './attestation-type-registry';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export interface AttestDelegationApp {
  id: string;
  appDid: string;
  status: string;
}

/**
 * Resolve the active (non-revoked) `registry.apps` row for `appId`, or null
 * when it does not exist, has been revoked, or the lookup itself fails
 * (fails closed, same convention as app-registry.ts's resolvers).
 */
export async function resolveActiveAttestDelegationApp(appId: string): Promise<AttestDelegationApp | null> {
  try {
    const [row] = await db
      .select({ id: registryApps.id, appDid: registryApps.appDid, status: registryApps.status })
      .from(registryApps)
      .where(eq(registryApps.id, appId))
      .limit(1);
    if (row?.status !== 'active') return null;
    return row;
  } catch (err) {
    log.error({ err: String(err), appId }, 'resolveActiveAttestDelegationApp: lookup failed');
    return null;
  }
}

async function isKnownAttestationType(type: string): Promise<boolean> {
  return (ATTESTATION_TYPES as readonly string[]).includes(type) || isRegisteredAttestationType(type);
}

/**
 * `appId` must resolve to an active app whose OWN did is exactly
 * `agentDid` — the grant's grantee. This is what stops a delegator from
 * being tricked into granting one app's capability slot to a different
 * app's DID.
 */
async function isValidAttestDelegationCapability(candidate: string, agentDid: string): Promise<boolean> {
  const parsed = parseAttestDelegationCapability(candidate);
  if (!parsed) return false;

  const app = await resolveActiveAttestDelegationApp(parsed.appId);
  if (!app || app.appDid !== agentDid) return false;

  return isKnownAttestationType(parsed.attestationType);
}

export interface AttestDelegationValidation {
  valid: string[];
  invalid: string[];
}

/**
 * Validate a batch of candidate `attest:<appId>:<type>` capabilities against
 * the live app registry and the attestation-type vocabulary (built-in
 * ATTESTATION_TYPES or a live attestation_type_registry entry, #1885), for
 * a grant whose grantee is `agentDid`.
 */
export async function validateAttestDelegationCapabilities(
  candidates: readonly string[],
  agentDid: string,
): Promise<AttestDelegationValidation> {
  const valid: string[] = [];
  const invalid: string[] = [];
  // Candidates are a short, caller-bounded list (grant issuance request
  // body) — sequential DB lookups keep this simple to reason about.
  for (const candidate of candidates) {
    if (await isValidAttestDelegationCapability(candidate, agentDid)) {
      valid.push(candidate);
    } else {
      invalid.push(candidate);
    }
  }
  return { valid, invalid };
}
