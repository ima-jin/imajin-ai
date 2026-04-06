import { NextRequest, NextResponse } from 'next/server';
import { db, nodes } from '@/src/db';
import { eq, desc, and, or, sql } from 'drizzle-orm';

/**
 * GET /api/node/list
 * List all registered nodes
 * 
 * Query params:
 *   status - Filter by status (active, stale, all)
 *   service - Filter by service (auth, pay, profile, etc.)
 *   limit - Max results (default 100)
 *   offset - Pagination offset
 * 
 * Response:
 * {
 *   nodes: Node[],
 *   total: number,
 *   limit: number,
 *   offset: number
 * }
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    
    const status = searchParams.get('status') || 'active';
    const service = searchParams.get('service');
    const limit = Math.min(parseInt(searchParams.get('limit') || '100'), 500);
    const offset = parseInt(searchParams.get('offset') || '0');

    // Build conditions
    const conditions = [];

    // Status filter
    if (status === 'active') {
      conditions.push(eq(nodes.status, 'active'));
    } else if (status === 'stale') {
      conditions.push(or(eq(nodes.status, 'stale'), eq(nodes.status, 'unreachable')));
    } else if (status !== 'all') {
      conditions.push(eq(nodes.status, status));
    }

    // Service filter (JSON array contains)
    if (service) {
      conditions.push(sql`${nodes.services}::jsonb ? ${service}`);
    }

    // Execute query
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [nodeList, countResult] = await Promise.all([
      db
        .select({
          id: nodes.id,
          hostname: nodes.hostname,
          subdomain: nodes.subdomain,
          services: nodes.services,
          capabilities: nodes.capabilities,
          status: nodes.status,
          version: nodes.version,
          lastHeartbeat: nodes.lastHeartbeat,
          registeredAt: nodes.registeredAt,
        })
        .from(nodes)
        .where(whereClause)
        .orderBy(desc(nodes.lastHeartbeat))
        .limit(limit)
        .offset(offset),
      
      db
        .select({ count: sql<number>`count(*)` })
        .from(nodes)
        .where(whereClause),
    ]);

    const total = countResult[0]?.count || 0;

    return NextResponse.json({
      nodes: nodeList.map(node => ({
        ...node,
        lastHeartbeat: node.lastHeartbeat?.toISOString(),
        registeredAt: node.registeredAt?.toISOString(),
      })),
      total,
      limit,
      offset,
    });

  } catch (error) {
    console.error('List error:', error);
    return NextResponse.json(
      { error: 'Failed to list nodes' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/node/list/stats
 * Network statistics
 */
export async function HEAD(request: NextRequest) {
  try {
    const stats = await db
      .select({
        total: sql<number>`count(*)`,
        active: sql<number>`count(*) filter (where status = 'active')`,
        stale: sql<number>`count(*) filter (where status = 'stale')`,
        unreachable: sql<number>`count(*) filter (where status = 'unreachable')`,
      })
      .from(nodes);

    const headers = new Headers();
    headers.set('X-Total-Nodes', String(stats[0]?.total || 0));
    headers.set('X-Active-Nodes', String(stats[0]?.active || 0));
    headers.set('X-Stale-Nodes', String(stats[0]?.stale || 0));
    headers.set('X-Unreachable-Nodes', String(stats[0]?.unreachable || 0));

    return new NextResponse(null, { status: 200, headers });
  } catch (error) {
    return new NextResponse(null, { status: 500 });
  }
}
