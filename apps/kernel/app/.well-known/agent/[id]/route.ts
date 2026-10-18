import { NextRequest, NextResponse } from 'next/server';
import { agentCardUrl } from '@/src/lib/http/node-url';
import { createLogger } from '@imajin/logger';
import { resolveReachDiscovery } from '@/src/lib/auth/reach-discovery';

export const dynamic = 'force-dynamic';

const log = createLogger('kernel');

/**
 * GET /.well-known/agent/:id — additive 0.1 unified reach card (#2596).
 * A DID, handle or @handle resolves to the same live transports.
 * This is discovery, never a second authorization or delivery surface.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const card = await resolveReachDiscovery(id);
    if (!card) {
      return NextResponse.json(
        { error: 'Principal not found', onboarding: agentCardUrl() },
        { status: 404, headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } },
      );
    }


    return NextResponse.json(card, {
      headers: {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    log.error({ err: String(error) }, '[.well-known/agent] Error resolving principal agent card');
    return NextResponse.json(
      { error: 'Failed to resolve principal agent card' },
      { status: 500, headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } },
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
    },
  });
}
