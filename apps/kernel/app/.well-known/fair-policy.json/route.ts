import { NextResponse } from 'next/server';
import {
  PROTOCOL_FEE_BPS,
  PROTOCOL_DID,
  NODE_FEE_DEFAULT_BPS,
  BUYER_CREDIT_DEFAULT_BPS,
  SCOPE_FEE_DEFAULT_BPS,
} from '@imajin/fair';

/**
 * /.well-known/fair-policy.json — RFC-32 §3.3
 *
 * Serves this node's .fair attribution policy as machine-readable JSON.
 * Agents read this before transacting; .fair manifests on every subsequent
 * transaction enforce these terms; the chain proves compliance.
 *
 * Fee cascade (basis points → percentage):
 *   1% MJN protocol + 0.5% node + 0.25% buyer credit + 0.25% scope
 *
 * Community distribution of protocol fees:
 *   10% foundation · 10% developers · 80% community
 *
 * Related: RFC-32 (Agent Protocol Interoperability), RFC-01 (.fair Attribution)
 * Epic: #965 · Issue: #967
 */

/** Foundation split of the collected protocol fee (10%). */
const FOUNDATION_SHARE = 0.10;
/** Developer pool split of the collected protocol fee (10%). */
const DEVELOPER_SHARE = 0.10;
/** Community remainder split of the collected protocol fee (80%). */
const COMMUNITY_SHARE = 0.80;

function bpsToRate(bps: number): number {
  return bps / 10000;
}

export function GET() {
  const domain = process.env.NEXT_PUBLIC_DOMAIN ?? 'imajin.ai';
  const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX ?? 'https://';

  const policy = {
    version: '1.0.0',
    node: `${prefix}${domain}`,
    fees: {
      mjn: {
        rateBps: PROTOCOL_FEE_BPS,
        rate: bpsToRate(PROTOCOL_FEE_BPS),
        description: 'MJN protocol fee — governance-controlled, fixed',
        recipient: PROTOCOL_DID,
      },
      node: {
        rateBps: NODE_FEE_DEFAULT_BPS,
        rate: bpsToRate(NODE_FEE_DEFAULT_BPS),
        description: 'Node operator fee — configurable within protocol bounds',
      },
      buyer: {
        rateBps: BUYER_CREDIT_DEFAULT_BPS,
        rate: bpsToRate(BUYER_CREDIT_DEFAULT_BPS),
        description: 'Buyer credit — returned to buyer as attribution share',
      },
      scope: {
        rateBps: SCOPE_FEE_DEFAULT_BPS,
        rate: bpsToRate(SCOPE_FEE_DEFAULT_BPS),
        description: 'Scope/group fee — only applied when content is created inside a scope',
      },
    },
    policy: {
      foundation: {
        share: FOUNDATION_SHARE,
        recipient: PROTOCOL_DID,
        description: 'Imajin Foundation — protocol maintenance and governance',
      },
      developers: {
        share: DEVELOPER_SHARE,
        recipient: 'did:imajin:DEV_POOL',
        description: 'Developer pool — contributors and ecosystem growth',
      },
      community: {
        share: COMMUNITY_SHARE,
        recipient: 'did:imajin:COMMUNITY_POOL',
        description: 'Community remainder — creators, curators, and participants',
      },
    },
    settlement: {
      methods: ['stripe', 'mjnx', 'usdc-base', 'usdc-solana'],
      minimum: { amount: '0.01', currency: 'USD' },
    },
    attribution: {
      required: true,
      manifest_format: 'fair-v1',
      chain_inclusion: true,
    },
  };

  return NextResponse.json(policy, {
    headers: {
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
