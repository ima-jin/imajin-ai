/**
 * GET /api/trust/distance?from={did}&to={did}
 *
 * Internal endpoint for querying trust distance between two DIDs.
 * Authenticated via Bearer token (TRUST_INTERNAL_API_KEY).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from "@/src/db";
import { trustDistance } from "@imajin/trust-graph";;

export async function GET(request: NextRequest) {
  // Internal API key auth
  const apiKey = request.headers.get('authorization')?.replace('Bearer ', '');
  const expectedKey = process.env.TRUST_INTERNAL_API_KEY;

  if (!expectedKey || apiKey !== expectedKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  if (!from || !to) {
    return NextResponse.json({ error: 'from and to query params required' }, { status: 400 });
  }

  const distance = await trustDistance(db, from, to);

  return NextResponse.json({
    from,
    to,
    distance,
    connected: distance !== -1,
  });
}
