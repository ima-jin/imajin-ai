import { and, eq, inArray, isNull } from 'drizzle-orm';
import { crypto as authCrypto } from '@imajin/auth';
import { db, identities } from '@/src/db';
import { getNodeDidFromConfig } from '@/src/lib/kernel/node-identity';
import { getPlatformDid } from '@/src/lib/kernel/connector-platform-did';
import { fetchPurposeCredential } from '@/src/lib/vault/purpose-credential';
import type { AttestationSigningIdentity } from '@/src/lib/auth/emit-mechanical-attestation';
import { DomainError } from './normalize';

/**
 * Bootstrap prerequisite: PLATFORM_DID must pin the existing @imajin business
 * identity; a mutable handle alone never selects the zone authority. That
 * identity must have a domain.issue vault grant to the configured node DID containing its
 * Ed25519 signing seed. It is NEVER the node's self-asserted identity. Issuance
 * fails closed if this org, grant, or matching key is unavailable.
 */
export async function getImajinOrganization(): Promise<{ id: string; publicKey: string }> {
  const platformDid = getPlatformDid();
  if (!platformDid) throw new DomainError('issuer_unavailable', 'Imajin organization DID is not configured', 503);
  const [org] = await db.select({ id: identities.id, publicKey: identities.publicKey }).from(identities)
    .where(and(eq(identities.id, platformDid), eq(identities.handle, 'imajin'), eq(identities.scope, 'business'),
      inArray(identities.tier, ['established', 'steward', 'operator']), isNull(identities.suspendedAt))).limit(1);
  if (!org || org.id !== platformDid) throw new DomainError('issuer_unavailable', 'Imajin organization identity is unavailable', 503);
  return org;
}

export async function domainSigningIdentity(organizationIssued: boolean): Promise<AttestationSigningIdentity> {
  const nodeDid = await getNodeDidFromConfig();
  if (!nodeDid) throw new DomainError('issuer_unavailable', 'Configured node identity is unavailable', 503);
  if (organizationIssued) {
    const org = await getImajinOrganization();
    const privateKey = await fetchPurposeCredential(org.id, nodeDid, 'domain.issue');
    assertMatchingKey(privateKey, org.publicKey);
    return { issuerDid: org.id, privateKey };
  }
  const [node] = await db.select({ publicKey: identities.publicKey }).from(identities)
    .where(and(eq(identities.id, nodeDid), isNull(identities.suspendedAt))).limit(1);
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!node || !privateKey) throw new DomainError('issuer_unavailable', 'Domain attestation signer is unavailable', 503);
  assertMatchingKey(privateKey, node.publicKey);
  return { issuerDid: nodeDid, privateKey };
}

function assertMatchingKey(privateKey: string, publicKey: string): void {
  try {
    if (authCrypto.getPublicKey(privateKey) === publicKey) return;
  } catch { /* Return a value-free configuration error. */ }
  throw new DomainError('issuer_unavailable', 'Domain attestation key does not match issuer identity', 503);
}
