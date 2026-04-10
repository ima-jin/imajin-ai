import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';
import { requireAuth } from '@imajin/auth';
import { db, nodes } from '@/src/db';
import { eq } from 'drizzle-orm';
import { haversineDistance } from '@/src/lib/registry/bump-correlation';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * GET /registry/api/bump/nodes?lat=...&lng=...
 * List active registered nodes, optionally sorted by proximity.
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const { searchParams } = new URL(request.url);
  const lat = searchParams.get('lat') ? parseFloat(searchParams.get('lat')!) : null;
  const lng = searchParams.get('lng') ? parseFloat(searchParams.get('lng')!) : null;

  try {
    const rows = await db
      .select({
        id: nodes.id,
        name: nodes.hostname,
        type: nodes.services,
        location: nodes.attestation,
      })
      .from(nodes)
      .where(eq(nodes.status, 'active'));

    type NodeRow = {
      id: string;
      name: string;
      type: unknown;
      location: unknown;
      distanceM?: number;
    };

    let result: NodeRow[] = rows.map((row) => {
      // Extract location from attestation if present
      const attestation = row.location as Record<string, unknown> | null;
      const nodeLoc = attestation?.location as { lat: number; lng: number } | undefined;
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        location: nodeLoc ?? null,
      };
    });

    // Sort by proximity if lat/lng provided
    if (lat !== null && lng !== null && !isNaN(lat) && !isNaN(lng)) {
      result = result
        .map((node) => {
          const loc = node.location as { lat: number; lng: number } | null;
          return {
            ...node,
            distanceM: loc ? haversineDistance(lat, lng, loc.lat, loc.lng) : Infinity,
          };
        })
        .sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
    }

    return NextResponse.json({ nodes: result }, { headers: cors });
  } catch (err) {
    console.error('[bump/nodes] error:', err);
    return NextResponse.json({ error: 'Failed to fetch nodes' }, { status: 500, headers: cors });
  }
}
