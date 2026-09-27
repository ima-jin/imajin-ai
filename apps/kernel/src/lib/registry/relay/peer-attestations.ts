/**
 * Dark-forest admission gate for `Authorization: DFOS <proof>` relay writes
 * (#2132 ruling, 2026-09-26): a cryptographically valid proof alone never
 * admits a peer DID — it must additionally hold a live (unrevoked,
 * unexpired) `relay.peer` attestation issued by this node's own identity.
 * The allow-list is expressed as this attestation, not a config file.
 *
 * Operator admit/revoke path: `scripts/relay-peer-admit.ts` /
 * `scripts/relay-peer-revoke.ts` call {@link admitRelayPeer} /
 * {@link revokeRelayPeer} directly.
 */
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { db, attestations } from '@/src/db';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { emitMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/** Attestation type gating DFOS-authenticated relay writes — see packages/auth/src/types/attestation.ts. */
export const RELAY_PEER_ATTESTATION_TYPE = 'relay.peer' as const;

/**
 * Cache TTL for admission checks. #2132 acceptance requires "revoking the
 * peer attestation denies the next write within the cache TTL" — short
 * enough that a revoke takes effect promptly, long enough to spare a DB
 * round trip on every relay write from an already-admitted peer.
 */
export const RELAY_PEER_ATTESTATION_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  attested: boolean;
  expiresAtMs: number;
}

const cache = new Map<string, CacheEntry>();

/** Test-only: clear the in-memory admission cache between test cases. */
export function resetRelayPeerAttestationCacheForTests(): void {
  cache.clear();
}

async function queryLiveAttestation(did: string, nodeDid: string): Promise<boolean> {
  const now = new Date();
  const [row] = await db
    .select({ id: attestations.id })
    .from(attestations)
    .where(
      and(
        eq(attestations.subjectDid, did),
        eq(attestations.issuerDid, nodeDid),
        eq(attestations.type, RELAY_PEER_ATTESTATION_TYPE),
        isNull(attestations.revokedAt),
        or(isNull(attestations.expiresAt), gt(attestations.expiresAt, now)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * True when `did` holds an unrevoked, unexpired `relay.peer` attestation
 * issued by this node — the admission gate for DFOS-scheme relay writes.
 * Cached for {@link RELAY_PEER_ATTESTATION_CACHE_TTL_MS}; a node with no
 * resolvable DID of its own (not yet bootstrapped) never admits anyone.
 */
export async function isRelayPeerAttested(did: string): Promise<boolean> {
  const now = Date.now();
  const cached = cache.get(did);
  if (cached && cached.expiresAtMs > now) {
    return cached.attested;
  }

  const nodeDid = await getNodeDid();
  const attested = nodeDid ? await queryLiveAttestation(did, nodeDid) : false;
  cache.set(did, { attested, expiresAtMs: now + RELAY_PEER_ATTESTATION_CACHE_TTL_MS });
  return attested;
}

export interface AdmitRelayPeerResult {
  ok: boolean;
  attestationId?: string;
  error?: string;
}

/** Admit a DFOS peer DID — mints the `relay.peer` attestation gating its writes. */
export async function admitRelayPeer(did: string): Promise<AdmitRelayPeerResult> {
  const attestationId = await emitMechanicalAttestation({
    subjectDid: did,
    type: RELAY_PEER_ATTESTATION_TYPE,
    contextId: null,
    contextType: null,
    payload: {},
  });
  if (!attestationId) {
    log.error({ did }, '[relay] failed to mint relay.peer attestation');
    return { ok: false, error: 'attestation_mint_failed' };
  }
  cache.delete(did);
  return { ok: true, attestationId };
}

export interface RevokeRelayPeerResult {
  ok: boolean;
  revokedCount: number;
  error?: string;
}

/** Revoke every live `relay.peer` attestation this node has issued for `did`. */
export async function revokeRelayPeer(did: string): Promise<RevokeRelayPeerResult> {
  const nodeDid = await getNodeDid();
  if (!nodeDid) {
    return { ok: false, revokedCount: 0, error: 'node_did_unresolved' };
  }

  const revoked = await db
    .update(attestations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(attestations.subjectDid, did),
        eq(attestations.issuerDid, nodeDid),
        eq(attestations.type, RELAY_PEER_ATTESTATION_TYPE),
        isNull(attestations.revokedAt),
      ),
    )
    .returning({ id: attestations.id });

  cache.delete(did);
  return { ok: true, revokedCount: revoked.length };
}
