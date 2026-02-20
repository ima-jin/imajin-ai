import { NextRequest, NextResponse } from 'next/server';
import { db, nodes, heartbeats } from '@/src/db';
import { eq } from 'drizzle-orm';
import { 
  verify, 
  NODE_HEARTBEAT_INTERVAL,
  NODE_STALE_THRESHOLD,
  NODE_UNREACHABLE_THRESHOLD,
  NODE_REGISTRATION_TTL,
  type NodeHeartbeat,
} from '@/lib/auth';
import { randomBytes } from 'crypto';

/**
 * POST /api/node/heartbeat
 * Node liveness ping
 * 
 * Request:
 * {
 *   nodeId: string,
 *   timestamp: number,
 *   buildHash: string,
 *   version: string,
 *   health: NodeHealth,
 *   signature: string
 * }
 * 
 * Response:
 * {
 *   ack: boolean,
 *   nextHeartbeat: number,
 *   actions?: HeartbeatAction[]
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const heartbeat = await request.json() as NodeHeartbeat;

    // 1. Validate required fields
    if (!heartbeat.nodeId || !heartbeat.timestamp || !heartbeat.signature) {
      return NextResponse.json(
        { ack: false, error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // 2. Find the node
    const [node] = await db
      .select()
      .from(nodes)
      .where(eq(nodes.id, heartbeat.nodeId))
      .limit(1);

    if (!node) {
      return NextResponse.json(
        { ack: false, error: 'Node not found' },
        { status: 404 }
      );
    }

    // 3. Verify signature
    const { signature, ...heartbeatWithoutSig } = heartbeat;
    const signatureValid = await verify(
      {
        from: heartbeat.nodeId,
        type: 'agent',
        timestamp: heartbeat.timestamp,
        payload: heartbeatWithoutSig,
        signature,
      },
      node.publicKey,
      { maxAge: 5 * 60 * 1000 } // 5 minute tolerance
    );

    if (!signatureValid.valid) {
      return NextResponse.json(
        { ack: false, error: 'Invalid signature' },
        { status: 401 }
      );
    }

    // 4. Check if node is expired
    if (node.status === 'expired' || node.status === 'revoked') {
      return NextResponse.json(
        { 
          ack: false, 
          error: 'Node registration expired or revoked',
          actions: [{ type: 'renew', expiresIn: 0 }]
        },
        { status: 403 }
      );
    }

    // 5. Build actions
    const actions: any[] = [];
    const now = Date.now();

    // Check if build hash changed (unexpected)
    if (heartbeat.buildHash !== node.buildHash) {
      actions.push({ 
        type: 'reattest', 
        reason: 'Build hash mismatch - please re-register with new attestation' 
      });
    }

    // Check if approaching expiry
    const expiresIn = new Date(node.expiresAt).getTime() - now;
    if (expiresIn < 7 * 24 * 60 * 60 * 1000) { // Less than 7 days
      actions.push({ 
        type: 'renew', 
        expiresIn: Math.floor(expiresIn / 1000) 
      });
    }

    // TODO: Check for available upgrades
    // const latestVersion = await getLatestVersion();
    // if (heartbeat.version !== latestVersion) {
    //   actions.push({ type: 'upgrade', targetVersion: latestVersion, reason: 'New version available' });
    // }

    // 6. Update node status
    await db
      .update(nodes)
      .set({
        lastHeartbeat: new Date(),
        status: 'active',
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, heartbeat.nodeId));

    // 7. Record heartbeat (optional, for analytics)
    await db.insert(heartbeats).values({
      id: `hb_${randomBytes(16).toString('hex')}`,
      nodeId: heartbeat.nodeId,
      buildHash: heartbeat.buildHash,
      version: heartbeat.version,
      health: heartbeat.health,
      signature: heartbeat.signature,
    });

    // 8. Return response
    return NextResponse.json({
      ack: true,
      nextHeartbeat: now + NODE_HEARTBEAT_INTERVAL,
      actions: actions.length > 0 ? actions : undefined,
    });

  } catch (error) {
    console.error('Heartbeat error:', error);
    return NextResponse.json(
      { ack: false, error: 'Failed to process heartbeat' },
      { status: 500 }
    );
  }
}
