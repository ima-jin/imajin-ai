import { NextRequest, NextResponse } from 'next/server';
import { db, nodes } from '@/src/db';
import { eq, or } from 'drizzle-orm';

/**
 * GET /api/node/lookup/:id
 * Look up a node by DID or hostname
 * 
 * Examples:
 *   /api/node/lookup/did:imajin:abc123
 *   /api/node/lookup/jin
 *   /api/node/lookup/jin.imajin.ai
 * 
 * Response:
 * {
 *   id: string,
 *   hostname: string,
 *   subdomain: string,
 *   services: string[],
 *   status: string,
 *   version: string,
 *   lastHeartbeat: string,
 *   registeredAt: string
 * }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    
    if (!id) {
      return NextResponse.json(
        { error: 'ID required' },
        { status: 400 }
      );
    }

    // Clean up the lookup value
    let lookupId = decodeURIComponent(id);
    
    // If it's a full subdomain, extract hostname
    if (lookupId.endsWith('.imajin.ai')) {
      lookupId = lookupId.replace('.imajin.ai', '');
    }

    // Find by DID or hostname
    const [node] = await db
      .select({
        id: nodes.id,
        publicKey: nodes.publicKey,
        hostname: nodes.hostname,
        subdomain: nodes.subdomain,
        services: nodes.services,
        capabilities: nodes.capabilities,
        status: nodes.status,
        version: nodes.version,
        lastHeartbeat: nodes.lastHeartbeat,
        registeredAt: nodes.registeredAt,
        expiresAt: nodes.expiresAt,
      })
      .from(nodes)
      .where(
        or(
          eq(nodes.id, lookupId),
          eq(nodes.hostname, lookupId)
        )
      )
      .limit(1);

    if (!node) {
      return NextResponse.json(
        { error: 'Node not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ...node,
      lastHeartbeat: node.lastHeartbeat?.toISOString(),
      registeredAt: node.registeredAt?.toISOString(),
      expiresAt: node.expiresAt?.toISOString(),
    });

  } catch (error) {
    console.error('Lookup error:', error);
    return NextResponse.json(
      { error: 'Failed to look up node' },
      { status: 500 }
    );
  }
}
