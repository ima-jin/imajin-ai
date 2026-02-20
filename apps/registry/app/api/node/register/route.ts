import { NextRequest, NextResponse } from 'next/server';
import { db, nodes, approvedBuilds } from '@/src/db';
import { eq } from 'drizzle-orm';
import { 
  verify, 
  canonicalize, 
  NODE_REGISTRATION_TTL, 
  NODE_GRACE_PERIOD,
  type NodeAttestation,
} from '@/lib/auth';
import { provisionSubdomain, isHostnameAvailable } from '@/lib/cloudflare';
import { randomBytes } from 'crypto';

/**
 * POST /api/node/register
 * Register a new node in the network
 * 
 * Request:
 * {
 *   attestation: NodeAttestation
 * }
 * 
 * Response:
 * {
 *   status: "verified" | "pending" | "rejected",
 *   subdomain?: string,
 *   expiresAt?: number,
 *   error?: string,
 *   hint?: string
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { attestation } = body as { attestation: NodeAttestation };

    // 1. Validate attestation structure
    if (!attestation || !attestation.nodeId || !attestation.publicKey || 
        !attestation.buildHash || !attestation.hostname || !attestation.signature) {
      return NextResponse.json(
        { status: 'rejected', error: 'Invalid attestation structure' },
        { status: 400 }
      );
    }

    // 2. Validate hostname format (alphanumeric, hyphens, 3-32 chars)
    const hostnameRegex = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
    if (!hostnameRegex.test(attestation.hostname)) {
      return NextResponse.json(
        { 
          status: 'rejected', 
          error: 'Invalid hostname format',
          hint: 'Hostname must be 3-32 characters, lowercase alphanumeric and hyphens, cannot start/end with hyphen'
        },
        { status: 400 }
      );
    }

    // 3. Reserved hostnames
    const reserved = ['www', 'api', 'registry', 'auth', 'pay', 'admin', 'gateway', 'mail', 'smtp'];
    if (reserved.includes(attestation.hostname)) {
      return NextResponse.json(
        { status: 'rejected', error: 'Hostname is reserved' },
        { status: 400 }
      );
    }

    // 4. Verify signature
    const { signature, ...attestationWithoutSig } = attestation;
    const canonical = canonicalize(attestationWithoutSig);
    const signatureValid = await verify(
      { 
        from: attestation.nodeId, 
        type: 'agent', 
        timestamp: attestation.timestamp, 
        payload: attestationWithoutSig, 
        signature 
      },
      attestation.publicKey,
      { skipTimestampCheck: true } // Attestation timestamps can be older
    );

    if (!signatureValid.valid) {
      return NextResponse.json(
        { status: 'rejected', error: 'Invalid signature', hint: signatureValid.error },
        { status: 401 }
      );
    }

    // 5. Verify build hash against approved builds
    const [approvedBuild] = await db
      .select()
      .from(approvedBuilds)
      .where(eq(approvedBuilds.buildHash, attestation.buildHash))
      .limit(1);

    if (!approvedBuild) {
      return NextResponse.json(
        { 
          status: 'rejected', 
          error: 'Unknown build hash',
          hint: 'Must run official release or approved fork. Check https://github.com/ima-jin/imajin-ai/releases'
        },
        { status: 403 }
      );
    }

    if (approvedBuild.deprecated) {
      return NextResponse.json(
        { 
          status: 'rejected', 
          error: 'Build version deprecated',
          hint: `Please upgrade to a newer version. Your version: ${attestation.version}`
        },
        { status: 403 }
      );
    }

    // 6. Check if node already registered (renewal)
    const [existingNode] = await db
      .select()
      .from(nodes)
      .where(eq(nodes.id, attestation.nodeId))
      .limit(1);

    const now = Date.now();
    const expiresAt = new Date(now + NODE_REGISTRATION_TTL);
    const graceExpiresAt = new Date(now + NODE_REGISTRATION_TTL + NODE_GRACE_PERIOD);

    if (existingNode) {
      // Renewal - same node, maybe different hostname
      if (existingNode.hostname !== attestation.hostname) {
        // Hostname change - check new one is available
        const available = await isHostnameAvailable(attestation.hostname);
        if (!available) {
          return NextResponse.json(
            { status: 'rejected', error: 'Hostname already taken' },
            { status: 409 }
          );
        }
        // TODO: Remove old subdomain, provision new one
      }

      // Update registration
      await db
        .update(nodes)
        .set({
          hostname: attestation.hostname,
          subdomain: `${attestation.hostname}.imajin.ai`,
          services: attestation.services,
          capabilities: attestation.capabilities,
          buildHash: attestation.buildHash,
          version: attestation.version,
          sourceCommit: attestation.sourceCommit,
          attestation,
          status: 'active',
          expiresAt,
          lastHeartbeat: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(nodes.id, attestation.nodeId));

      return NextResponse.json({
        status: 'verified',
        subdomain: `${attestation.hostname}.imajin.ai`,
        expiresAt: expiresAt.getTime(),
        renewed: true,
      });
    }

    // 7. New registration - check hostname availability
    const hostnameAvailable = await isHostnameAvailable(attestation.hostname);
    if (!hostnameAvailable) {
      return NextResponse.json(
        { status: 'rejected', error: 'Hostname already taken' },
        { status: 409 }
      );
    }

    // Also check database (might not be provisioned yet)
    const [existingHostname] = await db
      .select()
      .from(nodes)
      .where(eq(nodes.hostname, attestation.hostname))
      .limit(1);

    if (existingHostname) {
      // Check if in grace period and same owner
      if (existingHostname.id === attestation.nodeId) {
        // Same node reclaiming - allow
      } else if (existingHostname.status === 'expired' && 
                 Date.now() < new Date(existingHostname.expiresAt).getTime() + NODE_GRACE_PERIOD) {
        return NextResponse.json(
          { 
            status: 'rejected', 
            error: 'Hostname in grace period',
            hint: 'Previous owner can still reclaim this hostname'
          },
          { status: 409 }
        );
      }
    }

    // 8. Provision subdomain
    let recordId: string;
    try {
      const result = await provisionSubdomain(attestation.hostname, attestation.nodeId);
      recordId = result.recordId;
    } catch (error) {
      console.error('Failed to provision subdomain:', error);
      return NextResponse.json(
        { status: 'rejected', error: 'Failed to provision subdomain' },
        { status: 500 }
      );
    }

    // 9. Store registration
    await db.insert(nodes).values({
      id: attestation.nodeId,
      publicKey: attestation.publicKey,
      hostname: attestation.hostname,
      subdomain: `${attestation.hostname}.imajin.ai`,
      services: attestation.services,
      capabilities: attestation.capabilities,
      status: 'active',
      buildHash: attestation.buildHash,
      version: attestation.version,
      sourceCommit: attestation.sourceCommit,
      lastHeartbeat: new Date(),
      verifiedAt: new Date(),
      expiresAt,
      attestation,
    });

    return NextResponse.json({
      status: 'verified',
      subdomain: `${attestation.hostname}.imajin.ai`,
      expiresAt: expiresAt.getTime(),
    }, { status: 201 });

  } catch (error) {
    console.error('Registration error:', error);
    return NextResponse.json(
      { status: 'rejected', error: 'Failed to process registration' },
      { status: 500 }
    );
  }
}
