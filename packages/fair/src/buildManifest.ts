import type { FairEntry } from './types';
import {
  PROTOCOL_FEE_BPS,
  PROTOCOL_DID,
  NODE_FEE_MIN_BPS,
  NODE_FEE_MAX_BPS,
  NODE_FEE_DEFAULT_BPS,
  BUYER_CREDIT_MIN_BPS,
  BUYER_CREDIT_MAX_BPS,
  BUYER_CREDIT_DEFAULT_BPS,
} from './constants';

export interface FairFeeManifest {
  version: string;
  chain: FairEntry[];
  distributions: FairEntry[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function bpsToShare(bps: number): number {
  return bps / 10000;
}

/**
 * Build a .fair fee manifest for a piece of content.
 *
 * Fee cascade order:
 *   1. Protocol fee (fixed, governance-controlled)
 *   2. Node fee (operator-configurable within bounds)
 *   3. Buyer credit (operator-configurable within bounds)
 *   4. Scope fee (optional, only when content is created inside a scope/group)
 *   5. Seller share (remainder)
 */
export function buildFairManifest(params: {
  creatorDid: string;
  contentDid: string;
  scopeDid?: string | null;
  contentType: string;
  collaborators?: Array<{ did: string; role: string; share: number }>;
  nodeFeeBps?: number;
  buyerCreditBps?: number;
  nodeOperatorDid?: string;
  scopeFeeBps?: number | null;
}): FairFeeManifest {
  const {
    creatorDid,
    scopeDid,
    collaborators,
    nodeOperatorDid,
  } = params;

  // Protocol fee: always fixed
  const protocolShare = bpsToShare(PROTOCOL_FEE_BPS);

  // Node fee: clamped to operator bounds
  const nodeFeeBps = params.nodeFeeBps != null
    ? clamp(params.nodeFeeBps, NODE_FEE_MIN_BPS, NODE_FEE_MAX_BPS)
    : NODE_FEE_DEFAULT_BPS;
  const nodeShare = bpsToShare(nodeFeeBps);

  // Buyer credit: clamped to operator bounds
  const buyerCreditBps = params.buyerCreditBps != null
    ? clamp(params.buyerCreditBps, BUYER_CREDIT_MIN_BPS, BUYER_CREDIT_MAX_BPS)
    : BUYER_CREDIT_DEFAULT_BPS;
  const buyerCreditShare = bpsToShare(buyerCreditBps);

  // Scope fee: only when scopeDid AND scopeFeeBps are both provided
  const hasScopeFee = !!(scopeDid && params.scopeFeeBps != null);
  const scopeShare = hasScopeFee ? bpsToShare(params.scopeFeeBps!) : 0;

  // Seller gets the remainder
  const sellerShare =
    1 - protocolShare - nodeShare - buyerCreditShare - scopeShare;

  const chain: FairEntry[] = [
    { did: PROTOCOL_DID, role: 'protocol', share: protocolShare },
    { did: nodeOperatorDid || 'NODE_PLACEHOLDER', role: 'node', share: nodeShare },
    { did: 'BUYER_PLACEHOLDER', role: 'buyer_credit', share: buyerCreditShare },
  ];

  if (hasScopeFee) {
    chain.push({ did: scopeDid!, role: 'scope', share: scopeShare });
  }

  chain.push({ did: creatorDid, role: 'seller', share: sellerShare });

  const distributions: FairEntry[] =
    collaborators && collaborators.length > 0
      ? collaborators.map((c) => ({ did: c.did, role: c.role, share: c.share }))
      : [{ did: creatorDid, role: 'creator', share: 1.0 }];

  return {
    version: '0.3.0',
    chain,
    distributions,
  };
}
