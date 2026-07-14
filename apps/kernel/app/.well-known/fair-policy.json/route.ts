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
 * Declares the per-transaction fee cascade only — post-collection protocol
 * distribution (governance/treasury split) is a separate governance surface.
 *
 * Fee cascade (basis points → percentage):
 *   1% MJN protocol + 0.5% node + 0.25% buyer credit + 0.25% scope
 *
 * Related: RFC-32 (Agent Protocol Interoperability), RFC-01 (.fair Attribution)
 * Epic: #965 · Issue: #967
 */

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
