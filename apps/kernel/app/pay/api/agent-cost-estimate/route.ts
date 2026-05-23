/**
 * POST /api/agent-cost-estimate
 *
 * Calculate the estimated cost of interacting with an agent.
 * Public endpoint — anyone can estimate before interacting.
 *
 * Request:
 * {
 *   agentDid: "did:imajin:...",
 *   tokensIn: 3000,
 *   tokensOut: 500,
 *   includeSessionInit: true
 * }
 *
 * Response:
 * {
 *   baseCost: 0.045,
 *   fees: [
 *     { role: "protocol", name: "Protocol Fee", amount: 0.00045 },
 *     { role: "node", name: "Node Fee", amount: 0.000225 },
 *     { role: "buyer_credit", name: "Buyer Credit", amount: 0.000113 },
 *     { role: "scope", name: "Scope Fee", amount: 0.000114 }
 *   ],
 *   totalCost: 0.045902,
 *   currency: "MJNx"
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, profiles } from '@/src/db';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import {
  calculateAgentInteractionCost,
  isValidAgentPricingManifest,
} from '@imajin/fair';
import type { AgentPricingManifest } from '@imajin/fair';

const log = createLogger('kernel');

interface EstimateBody {
  agentDid: string;
  tokensIn: number;
  tokensOut: number;
  includeSessionInit?: boolean;
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  try {
    const body: EstimateBody = await request.json();

    // Validate required fields
    if (typeof body.agentDid !== 'string' || !body.agentDid.startsWith('did:')) {
      return NextResponse.json(
        { error: 'agentDid must be a valid DID string' },
        { status: 400, headers: cors }
      );
    }

    if (typeof body.tokensIn !== 'number' || body.tokensIn < 0) {
      return NextResponse.json(
        { error: 'tokensIn must be a non-negative number' },
        { status: 400, headers: cors }
      );
    }

    if (typeof body.tokensOut !== 'number' || body.tokensOut < 0) {
      return NextResponse.json(
        { error: 'tokensOut must be a non-negative number' },
        { status: 400, headers: cors }
      );
    }

    // Look up agent pricing from profile
    const profile = await db.query.profiles.findFirst({
      where: eq(profiles.did, body.agentDid),
    });

    if (!profile?.agentPricing || Object.keys(profile.agentPricing).length === 0) {
      // Agent has no pricing — free to interact
      return NextResponse.json({
        baseCost: 0,
        fees: [],
        totalCost: 0,
        currency: 'MJNx',
      }, { headers: cors });
    }

    if (!isValidAgentPricingManifest(profile.agentPricing)) {
      return NextResponse.json(
        { error: 'Stored pricing manifest is invalid' },
        { status: 500, headers: cors }
      );
    }

    const manifest = profile.agentPricing as AgentPricingManifest;

    const estimate = calculateAgentInteractionCost({
      manifest,
      tokensIn: body.tokensIn,
      tokensOut: body.tokensOut,
      includeSessionInit: body.includeSessionInit ?? false,
    });

    return NextResponse.json(estimate, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Agent cost estimate error');
    return NextResponse.json(
      { error: 'Failed to calculate cost estimate' },
      { status: 500, headers: cors }
    );
  }
}
