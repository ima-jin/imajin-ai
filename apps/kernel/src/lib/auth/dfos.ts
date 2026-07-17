import { hexToMultibase } from '@imajin/auth';
import { verifyChain, createSigner } from '@imajin/dfos';
import { signContentOperation, dagCborCanonicalEncode } from '@metalabel/dfos-protocol';
import { db, identities, identityChains, credentials } from '@/src/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { verifyChainLog } from './chain-providers';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

const REGISTRY_URL = process.env.REGISTRY_URL;

/**
 * Ingest a DFOS chain log into the relay.
 * Submits all JWS tokens to REGISTRY_URL/relay/operations.
 * Non-fatal — returns false on any error.
 */
export async function ingestToRelay(chainLog: string[]): Promise<boolean> {
  if (!REGISTRY_URL) {
    log.warn({}, 'REGISTRY_URL not set — skipping relay ingest');
    return false;
  }
  try {
    const res = await fetch(`${REGISTRY_URL}/relay/operations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations: chainLog }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.error({ status: res.status, text }, 'relay ingest failed');
      return false;
    }
    return true;
  } catch (err) {
    log.error({ err: String(err) }, 'relay ingest error');
    return false;
  }
}

/**
 * Check if a DFOS identity chain exists on the relay.
 * Returns false on any error or missing REGISTRY_URL.
 */
export async function checkRelayChain(dfosDid: string): Promise<boolean> {
  if (!REGISTRY_URL) return false;
  try {
    const res = await fetch(
      `${REGISTRY_URL}/relay/identities/${encodeURIComponent(dfosDid)}`
    );
    return res.ok;
  } catch {
    return false;
  }
}

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
      log.error({ error: result.error }, 'chain verification failed');
      return null;
    }

    // 2. Verify the DID matches what the client claims
    if (result.did !== chain.did) {
      log.error({ chainDid: result.did, claimedDid: chain.did }, 'DID mismatch');
      return null;
    }

    // 3. Verify the chain's public key matches the identity's public key
    const expectedMultibase = hexToMultibase(expectedPublicKeyHex);
    if (result.publicKeyMultibase !== expectedMultibase) {
      log.error({}, 'key mismatch: chain key does not match identity public key');
      return null;
    }

    return {
      did: result.did,
      log: chain.log,
      headCid: chain.operationCID,
    };
  } catch (err) {
    log.error({ err: String(err) }, 'chain verification failed');
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

  const credId = `cred_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

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

  // Also ingest into the relay so it enters the gossip network
  ingestToRelay(chain.log).catch(err =>
    log.error({ imajinDid, err: String(err) }, 'relay ingest failed after storing chain')
  );

  return true;
}

/**
 * Check whether an identity has a DFOS chain stored locally.
 * Lighter than getChainByImajinDid — only selects the DID column.
 */
export async function hasDfosChain(imajinDid: string): Promise<boolean> {
  const [row] = await db
    .select({ did: identityChains.did })
    .from(identityChains)
    .where(eq(identityChains.did, imajinDid))
    .limit(1);
  return !!row;
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
      scope: identities.scope,
      subtype: identities.subtype,
      tier: identities.tier,
    })
    .from(identities)
    .where(eq(identities.id, chain.did))
    .limit(1);

  if (!identity) return null;

  return {
    imajinDid: identity.id,
    dfosDid: chain.dfosDid,
    scope: identity.scope,
    subtype: identity.subtype,
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

/**
 * Emit an attestation as a DFOS content chain genesis entry.
 *
 * Uses the node's DFOS DID (looked up from identity_chains via getNodeDid())
 * and AUTH_PRIVATE_KEY to sign a content chain genesis operation, then ingests
 * it into the local relay. The DB remains the operational store — the chain
 * provides the verifiable, portable proof.
 *
 * Non-fatal: returns false (with a logged warning) if the node has no DFOS
 * chain or if any step fails. Never throws.
 *
 * Bilateral note: per-party chains (issuer/subject each owning their own
 * content chain) require custodial UCAN authorization and are deferred.
 * For now, one genesis entry per attestation is signed by the node DID.
 */
export async function createAttestationEntry(params: {
  issuer_did: string;
  subject_did: string;
  type: string;
  context_id: string | null | undefined;
  context_type: string | null | undefined;
  payload: Record<string, unknown> | null | undefined;
  issued_at: Date;
}): Promise<boolean> {
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) {
    log.warn({}, 'createAttestationEntry: AUTH_PRIVATE_KEY not set — skipping chain entry');
    return false;
  }

  const nodeDid = await getNodeDid();
  if (!nodeDid) {
    log.warn({}, 'createAttestationEntry: no node DID — skipping chain entry');
    return false;
  }

  const chain = await getChainByImajinDid(nodeDid);
  if (!chain) {
    log.warn(
      { nodeDid },
      'createAttestationEntry: node has no DFOS identity chain — skipping chain entry',
    );
    return false;
  }

  try {
    const verified = await verifyChain(chain.log as string[]);
    const keyId = verified.authKeys[0]?.id;
    if (!keyId) {
      log.warn({ dfosDid: chain.dfosDid }, 'createAttestationEntry: no auth keys in chain');
      return false;
    }

    const kid = `${chain.dfosDid}#${keyId}`;
    const signer = createSigner(privateKey);

    // Build the attestation content document (schema from issue #640)
    const content = {
      $schema: 'imajin:attestation:v1',
      issuer: params.issuer_did,
      subject: params.subject_did,
      type: params.type,
      context: (params.context_id != null)
        ? { id: params.context_id, type: params.context_type ?? null }
        : null,
      payload: params.payload ?? null,
      timestamp: params.issued_at.toISOString(),
    };

    // Compute document CID from canonical DAG-CBOR encoding
    const block = await dagCborCanonicalEncode(content);
    const documentCID = block.cid.toString();

    // Sign a content chain genesis operation (node DID is the creator)
    const { jwsToken } = await signContentOperation({
      operation: {
        version: 1,
        type: 'create',
        did: chain.dfosDid,
        documentCID,
        baseDocumentCID: null,
        createdAt: params.issued_at.toISOString(),
      },
      signer,
      kid,
    });

    // TODO(#640): upload attestation bytes as blob to relay so documents are
    // retrievable via getDocuments(). For now the chain entry proves existence.

    const ok = await ingestToRelay([jwsToken]);
    if (!ok) {
      log.warn({ type: params.type }, 'createAttestationEntry: relay ingest failed');
    }
    return ok;
  } catch (err) {
    log.error({ err: String(err), type: params.type }, 'createAttestationEntry: error');
    return false;
  }
}
