import { NextRequest, NextResponse } from 'next/server';
import { db, nodes } from '@/src/db';
import { eq, or } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * GET /api/node/resolve/:did
 * Resolve a DID (chain DID or node DID) to a node endpoint.
 * This is "DNS for DIDs" — given any DID, find the node.
 *
 * Accepts:
 * - did:imajin:xxx  — node's own DID (id column)
 * - did:dfos:xxx    — chain-native DID (chain_did column)
 *
 * Returns:
 * { node: { hostname, subdomain, status, services } }
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  try {
    const { did } = await params;
    const decodedDid = decodeURIComponent(did);

    if (!decodedDid) {
      return NextResponse.json(
        { error: 'DID is required' },
        { status: 400 }
      );
    }

    // Resolve by node DID or chain DID
    const [node] = await db
      .select({
        hostname: nodes.hostname,
        subdomain: nodes.subdomain,
        status: nodes.status,
        services: nodes.services,
        chainDid: nodes.chainDid,
        id: nodes.id,
      })
      .from(nodes)
      .where(
        or(
          eq(nodes.id, decodedDid),
          eq(nodes.chainDid, decodedDid)
        )
      )
      .limit(1);

    if (!node) {
      return NextResponse.json(
        { error: 'No node found for this DID' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      node: {
        hostname: node.hostname,
        subdomain: node.subdomain,
        status: node.status,
        services: node.services,
      },
    });
  } catch (error) {
    log.error({ err: String(error) }, '[resolve] Error');
    return NextResponse.json(
      { error: 'Internal error' },
      { status: 500 }
    );
  }
}
