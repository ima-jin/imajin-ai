import { NextRequest, NextResponse } from 'next/server';
import { db, profiles } from '@/src/db';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { eq, or } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { isValidAgentPricingManifest } from '@imajin/fair';

const log = createLogger('kernel');

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/profile/:id/pricing
 *
 * Returns the agent pricing manifest for a given DID or handle.
 * Public endpoint — anyone can see what an agent costs before interacting.
 *
 * 404 if the identity has no pricing or isn't an agent.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const cors = corsHeaders(request);

  try {
    const profile = await db.query.profiles.findFirst({
      where: (profiles, { eq, or }) =>
        or(eq(profiles.did, id), eq(profiles.handle, id)),
    });

    if (!profile) {
      return NextResponse.json(
        { error: 'Profile not found' },
        { status: 404, headers: cors }
      );
    }

    if (!profile.agentPricing || Object.keys(profile.agentPricing).length === 0) {
      return NextResponse.json(
        { error: 'No pricing configured for this agent' },
        { status: 404, headers: cors }
      );
    }

    if (!isValidAgentPricingManifest(profile.agentPricing)) {
      return NextResponse.json(
        { error: 'Stored pricing manifest is invalid' },
        { status: 500, headers: cors }
      );
    }

    return NextResponse.json(profile.agentPricing, { headers: cors });
  } catch (error) {
    log.error({ err: String(error), id }, 'Failed to fetch agent pricing');
    return NextResponse.json(
      { error: 'Failed to fetch agent pricing' },
      { status: 500, headers: cors }
    );
  }
}
