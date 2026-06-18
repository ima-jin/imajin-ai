import { createLogger } from '@imajin/logger';

const log = createLogger('bus:match:reach');

export interface ReachRings {
  /** 1-hop connections used as favourites proxy (no explicit favourites table yet). */
  favouritesSet: Set<string>;
  /** 2-hop connection set: direct connections + their direct connections. */
  oneDegreeSet: Set<string>;
}

/**
 * Resolve the reach rings for a DID. Computed once per engine run and reused
 * across all candidate pairs to avoid redundant DB round-trips.
 *
 * favourites: the epic defines these as an explicit list you set — not mutual.
 * Until a kernel.user_favourites table exists we use 1-hop connections as a
 * conservative proxy. This understates the favourites set (excluding people
 * you've favourited who aren't connections yet) but never over-reveals.
 *
 * one_degree: plain 2-hop connection membership. Both direct connections (1-hop)
 * and their direct connections (2-hop) admit the requester. Trust-weight
 * ranking is a v2 signal; gating here is binary membership only.
 */
export async function resolveReachRings(did: string): Promise<ReachRings> {
  try {
    const { getClient } = await import('@imajin/db');
    const sql = getClient();

    // 1-hop connections (direct).
    const directRows = await sql<{ other_did: string }[]>`
      SELECT CASE WHEN did_a = ${did} THEN did_b ELSE did_a END AS other_did
      FROM connections.connections
      WHERE (did_a = ${did} OR did_b = ${did})
        AND disconnected_at IS NULL
    `;
    const directSet = new Set(directRows.map((r) => r.other_did));

    // 2-hop connections (connections of connections, excluding self).
    const twoHopRows = await sql<{ other_did: string }[]>`
      WITH one_hop AS (
        SELECT CASE WHEN did_a = ${did} THEN did_b ELSE did_a END AS hop1
        FROM connections.connections
        WHERE (did_a = ${did} OR did_b = ${did}) AND disconnected_at IS NULL
      )
      SELECT DISTINCT
        CASE WHEN c.did_a = oh.hop1 THEN c.did_b ELSE c.did_a END AS other_did
      FROM one_hop oh
      JOIN connections.connections c
        ON (c.did_a = oh.hop1 OR c.did_b = oh.hop1)
      WHERE c.disconnected_at IS NULL
        AND CASE WHEN c.did_a = oh.hop1 THEN c.did_b ELSE c.did_a END != ${did}
    `;

    // one_degree = 1-hop ∪ 2-hop (i.e. within 2 hops).
    const oneDegreeSet = new Set<string>([
      ...directSet,
      ...twoHopRows.map((r) => r.other_did),
    ]);

    log.info(
      { did, favourites: directSet.size, oneDegree: oneDegreeSet.size },
      'Reach rings resolved'
    );

    return { favouritesSet: directSet, oneDegreeSet };
  } catch (err) {
    log.error({ err: String(err), did }, 'Failed to resolve reach rings — returning empty sets');
    // Fail-closed: empty sets → all reach checks fail → no matches.
    return { favouritesSet: new Set(), oneDegreeSet: new Set() };
  }
}

/**
 * Check whether `requester` admits `candidate` under `reach`.
 * Both sides must pass their own check for a match to proceed.
 */
export function admitsUnderReach(
  reach: string,
  requesterDid: string,
  candidateDid: string,
  rings: ReachRings
): boolean {
  switch (reach) {
    case 'favourites':
      return rings.favouritesSet.has(candidateDid);
    case 'one_degree':
      return rings.oneDegreeSet.has(candidateDid);
    case 'strangers':
      return true; // open — anyone admitted
    default:
      log.warn({ reach, requesterDid }, 'Unknown reach value — denying');
      return false;
  }
}
