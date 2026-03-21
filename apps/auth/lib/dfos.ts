import { verifyChain } from '@imajin/dfos';
import { hexToMultibase } from '@imajin/auth';
import { db, identityChains, credentials } from '@/src/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';

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
    // 1. Verify the chain is cryptographically valid
    const verified = await verifyChain(chain.log);

    // 2. Verify the DID matches what the client claims
    if (verified.did !== chain.did) {
      console.error('[dfos] DID mismatch:', verified.did, '!==', chain.did);
      return null;
    }

    // 3. Verify the chain's public key matches the identity's public key
    const expectedMultibase = hexToMultibase(expectedPublicKeyHex);
    const chainKey = verified.controllerKeys[0]?.publicKeyMultibase;
    if (chainKey !== expectedMultibase) {
      console.error('[dfos] Key mismatch: chain key does not match identity public key');
      return null;
    }

    // 4. Verify chain is not deleted
    if (verified.isDeleted) {
      console.error('[dfos] Chain is deleted');
      return null;
    }

    return {
      did: verified.did,
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
