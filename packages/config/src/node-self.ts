import { getServiceUrl } from './services';

/**
 * Minimal public node metadata returned by GET /registry/api/node/self.
 * Mirrors the subset of `relay.relay_config` the registry service exposes
 * publicly — never the private config (profile artifact JWS, etc).
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

function registryBaseUrl(): string {
  // Like every other `*_SERVICE_URL`, this includes the service's path
  // prefix (`/registry`) — callers append only the endpoint path
  // (`/api/node/self`). See #2046: omitting the prefix here caused
  // `getNodeSelf()` to bake `/registry` into the fetch path instead,
  // which double-prefixed to `/registry/registry/api/...` for anyone
  // who set REGISTRY_SERVICE_URL following the established convention.
  if (process.env.REGISTRY_SERVICE_URL) return process.env.REGISTRY_SERVICE_URL;
  const mode = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
  const base = getServiceUrl('registry', mode) ?? 'http://localhost:3000';
  return `${base}/registry`;
}

/**
 * Fetch this node's public identity + .fair fee config from the registry
 * service (`GET /registry/api/node/self`, #2000).
 *
 * Replaces raw `relay.relay_config` SQL reads that were duplicated across
 * coffee, learn, events, and market (audit item 8 of #1983). Returns null on
 * any failure — network error, non-2xx response (e.g. 503 when the node
 * identity hasn't been bootstrapped yet) — so callers can fall back to
 * defaults exactly as they did when the raw SQL row was missing. A non-2xx
 * response is logged with the URL actually hit (no secrets) so a
 * misconfigured REGISTRY_SERVICE_URL prefix is visible instead of failing
 * silently (#2046).
 */
export async function getNodeSelf(): Promise<NodeSelfInfo | null> {
  const url = `${registryBaseUrl()}/api/node/self`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[config] getNodeSelf: registry returned ${res.status} for ${url} — check REGISTRY_SERVICE_URL`);
      return null;
    }
    return (await res.json()) as NodeSelfInfo;
  } catch (err) {
    console.warn(`[config] getNodeSelf: fetch failed for ${url} — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
