import { hexToMultibase } from '@imajin/auth';
import { db, identities, identityChains, credentials } from '@/src/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { verifyChainLog } from './chain-providers';

interface DfosChainPayload {
  did: string;
  log: string[];
  operationCID: string;
}

/**
 * Verify a client-submitted DFOS chain and ensure its key matches
 * the identity's public key.
 *
 * Returns the verified chain data or null if invalid.
 */
export async function verifyClientChain(
  chain: DfosChainPayload,
  expectedPublicKeyHex: string
): Promise<{ did: string; log: string[]; headCid: string } | null> {
  try {
    // 1. Verify the chain is cryptographically valid via provider abstraction
    const result = await verifyChainLog(chain.log);

    if (!result.valid) {
      console.error('[dfos] Chain verification failed:', result.error);
      return null;
    }

    // 2. Verify the DID matches what the client claims
    if (result.did !== chain.did) {
      console.error('[dfos] DID mismatch:', result.did, '!==', chain.did);
      return null;
    }

    // 3. Verify the chain's public key matches the identity's public key
    const expectedMultibase = hexToMultibase(expectedPublicKeyHex);
    if (result.publicKeyMultibase !== expectedMultibase) {
      console.error('[dfos] Key mismatch: chain key does not match identity public key');
      return null;
    }

    return {
      did: result.did,
      log: chain.log,
      headCid: chain.operationCID,
    };
  } catch (err) {
    console.error('[dfos] Chain verification failed:', err);
    return null;
  }
}

/**
 * Store a verified DFOS chain for an identity.
 * Idempotent — skips if chain already exists.
 */
export async function storeDfosChain(
  imajinDid: string,
  chain: { did: string; log: string[]; headCid: string }
): Promise<boolean> {
  // Check if already bridged
  const existing = await db
    .select()
    .from(identityChains)
    .where(eq(identityChains.did, imajinDid))
    .limit(1);

  if (existing.length > 0) {
    return false; // Already has a chain
  }

  const credId = `cred_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  // Store chain + credential
  await db.insert(identityChains).values({
    did: imajinDid,
    dfosDid: chain.did,
    log: chain.log,
    headCid: chain.headCid,
    keyCount: 1,
  });

  await db.insert(credentials).values({
    id: credId,
    did: imajinDid,
    type: 'dfos',
    value: chain.did,
    verifiedAt: new Date(),
  });

  return true;
}

/**
 * Look up a DFOS chain by Imajin DID.
 * Returns the full chain record or null.
 */
export async function getChainByImajinDid(imajinDid: string) {
  const [chain] = await db
    .select()
    .from(identityChains)
    .where(eq(identityChains.did, imajinDid))
    .limit(1);
  return chain ?? null;
}

/**
 * Look up an Imajin identity by its DFOS DID.
 * Returns { imajinDid, dfosDid, type, tier } or null.
 */
export async function getIdentityByDfosDid(dfosDid: string) {
  const [chain] = await db
    .select()
    .from(identityChains)
    .where(eq(identityChains.dfosDid, dfosDid))
    .limit(1);

  if (!chain) return null;

  const [identity] = await db
    .select({
      id: identities.id,
      type: identities.type,
      tier: identities.tier,
    })
    .from(identities)
    .where(eq(identities.id, chain.did))
    .limit(1);

  if (!identity) return null;

  return {
    imajinDid: identity.id,
    dfosDid: chain.dfosDid,
    type: identity.type,
    tier: identity.tier,
  };
}

/**
 * Check all identity chains for consistency with DB public keys.
 * Returns a list of mismatches. For admin/scripts use.
 */
export async function checkAllChainConsistency(): Promise<Array<{
  did: string;
  dfosDid: string;
  issue: string;
}>> {
  const chains = await db.select().from(identityChains);
  const issues: Array<{ did: string; dfosDid: string; issue: string }> = [];

  for (const chain of chains) {
    try {
      const result = await verifyChainLog(chain.log as string[]);

      if (!result.valid) {
        issues.push({ did: chain.did, dfosDid: chain.dfosDid, issue: result.error || 'Verification failed' });
        continue;
      }

      const [identity] = await db
        .select({ publicKey: identities.publicKey })
        .from(identities)
        .where(eq(identities.id, chain.did))
        .limit(1);

      if (!identity) {
        issues.push({ did: chain.did, dfosDid: chain.dfosDid, issue: 'Identity missing from DB' });
        continue;
      }

      const dbMultibase = hexToMultibase(identity.publicKey);
      const chainMultibase = result.publicKeyMultibase;

      if (dbMultibase !== chainMultibase) {
        issues.push({
          did: chain.did,
          dfosDid: chain.dfosDid,
          issue: `Key mismatch: DB=${dbMultibase.slice(0, 12)}... Chain=${chainMultibase?.slice(0, 12)}...`,
        });
      }
    } catch (err: unknown) {
      issues.push({
        did: chain.did,
        dfosDid: chain.dfosDid,
        issue: `Verification error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return issues;
}
