import { getClient } from '@imajin/db';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');
const sql = getClient();

/**
 * Minimal public node metadata backing GET /registry/api/node/self (#2000).
 * Mirrors the subset of relay.relay_config the registry exposes publicly —
 * never the private config (profile artifact JWS, etc).
 */
export interface NodeSelfInfo {
  /** This node's own DID (did:imajin:...). */
  did: string;
  /** DID of the human/entity operating this node, if configured. */
  nodeOperatorDid: string | null;
  /** Node fee, in basis points, applied to .fair settlements on this node. */
  nodeFeeBps: number | null;
  /** Buyer credit, in basis points, applied to .fair settlements on this node. */
  buyerCreditBps: number | null;
}

interface RelayConfigRow {
  imajinDid: string | null;
  nodeOperatorDid: string | null;
  nodeFeeBps: number | null;
  buyerCreditBps: number | null;
}

let cachedRow: RelayConfigRow | null | undefined;

/** Reads relay.relay_config's singleton row once per process, caching the result (including misses). */
async function loadRelayConfigRow(): Promise<RelayConfigRow | null> {
  if (cachedRow !== undefined) return cachedRow;

  try {
    const [row] = await sql`
      SELECT imajin_did, node_operator_did, node_fee_bps, buyer_credit_bps
      FROM relay.relay_config
      WHERE id = 'singleton'
      LIMIT 1
    `;
    cachedRow = row
      ? {
          imajinDid: (row.imajin_did as string | null) ?? null,
          nodeOperatorDid: (row.node_operator_did as string | null) ?? null,
          nodeFeeBps: (row.node_fee_bps as number | null) ?? null,
          buyerCreditBps: (row.buyer_credit_bps as number | null) ?? null,
        }
      : null;
  } catch (err) {
    log.warn({ err: String(err) }, 'could not read relay.relay_config');
    cachedRow = null;
  }

  return cachedRow;
}

/** Where {@link resolveNodeDid} found the node DID. */
export type NodeDidSource = 'relay_config' | 'RELAY_DID' | 'none';

/**
 * Resolves this node's DID and says where it came from.
 *
 * `relay_config` is `relay.relay_config.imajin_did` — the node's own
 * did:imajin identity (see `scripts/bootstrap-node-identity.ts`). `RELAY_DID`
 * is a last-resort fallback to the DFOS **relay's** identity env var, a
 * different identity with a different key. Anything that must act on the node
 * identity specifically (the key rotation ceremony, #2081) has to tell the two
 * apart rather than treat them as interchangeable.
 */
export async function resolveNodeDid(): Promise<{ did: string; source: NodeDidSource }> {
  const row = await loadRelayConfigRow();
  if (row?.imajinDid) return { did: row.imajinDid, source: 'relay_config' };

  const fallback = process.env.RELAY_DID;
  if (fallback) return { did: fallback, source: 'RELAY_DID' };

  log.warn({}, 'no node DID found in relay.relay_config or RELAY_DID env');
  return { did: '', source: 'none' };
}

/**
 * Returns this node's did:imajin DID.
 * Reads relay.relay_config.imajin_did from DB (cached for process lifetime).
 * Falls back to RELAY_DID env var, then empty string with a warning.
 * Use {@link resolveNodeDid} when the source matters.
 */
export async function getNodeDid(): Promise<string> {
  return (await resolveNodeDid()).did;
}

/**
 * Returns the minimal public node metadata for GET /registry/api/node/self.
 * Returns null when the node's own DID cannot be resolved (relay_config
 * singleton row missing/unreadable AND no RELAY_DID fallback) — callers
 * should treat that as "not configured yet" (e.g. 503), not "not found".
 */
export async function getNodeSelfInfo(): Promise<NodeSelfInfo | null> {
  const did = await getNodeDid();
  if (!did) return null;

  const row = await loadRelayConfigRow();
  return {
    did,
    nodeOperatorDid: row?.nodeOperatorDid ?? null,
    nodeFeeBps: row?.nodeFeeBps ?? null,
    buyerCreditBps: row?.buyerCreditBps ?? null,
  };
}
