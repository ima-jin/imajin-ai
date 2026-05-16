import { NextRequest, NextResponse } from 'next/server';
import { db, identities, identityMembers } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth, generateKeypair } from '@imajin/auth';
import { didFromPublicKey } from '@/src/lib/auth/crypto';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

const HANDLE_REGEX = /^[a-z0-9_-]+$/;

interface AgentResponse {
  did: string;
  handle: string | null;
  displayName: string | null;
  name: string | null;
  createdAt: string | null;
  tier: string;
  status: 'online' | 'offline';
  role: string;
}

/**
 * GET /auth/api/agents
 * List all agents linked to the authenticated user.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity: caller } = authResult;

  try {
    const rows = await db
      .select({
        did: identities.id,
        handle: identities.handle,
        name: identities.name,
        createdAt: identities.createdAt,
        tier: identities.tier,
        role: identityMembers.role,
      })
      .from(identityMembers)
      .innerJoin(identities, eq(identityMembers.identityDid, identities.id))
      .where(
        and(
          eq(identityMembers.memberDid, caller.id),
          isNull(identityMembers.removedAt),
          eq(identities.subtype, 'agent'),
          eq(identities.scope, 'actor')
        )
      )
      .orderBy(identities.createdAt);

    const agents: AgentResponse[] = rows.map((row) => ({
      did: row.did,
      handle: row.handle,
      displayName: row.name,
      name: row.name,
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
      tier: row.tier,
      status: 'offline' as const, // placeholder until real status tracking
      role: row.role,
    }));

    return NextResponse.json({ agents });
  } catch (error) {
    log.error({ err: String(error) }, '[agents] List error');
    return NextResponse.json({ error: 'Failed to list agents' }, { status: 500 });
  }
}

/**
 * POST /auth/api/agents
 * Create a new agent identity linked to the authenticated user.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity: caller } = authResult;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { handle, displayName, bio } = body as {
    handle?: string;
    displayName?: string;
    bio?: string;
  };

  // Validate handle
  if (!handle || typeof handle !== 'string') {
    return NextResponse.json({ error: 'handle is required' }, { status: 400 });
  }
  if (handle.length < 3 || handle.length > 64) {
    return NextResponse.json({ error: 'Handle must be 3-64 characters' }, { status: 400 });
  }
  if (!HANDLE_REGEX.test(handle)) {
    return NextResponse.json(
      { error: 'Handle must be lowercase letters, numbers, underscores, or hyphens' },
      { status: 400 }
    );
  }

  // Validate display name
  const trimmedDisplayName = displayName?.trim().slice(0, 100) || null;

  try {
    // Check handle uniqueness
    const existing = await db
      .select({ id: identities.id })
      .from(identities)
      .where(eq(identities.handle, handle))
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json({ error: 'Handle already taken' }, { status: 409 });
    }

    // Generate Ed25519 keypair server-side
    const { privateKey, publicKey } = generateKeypair();
    const agentDid = didFromPublicKey(publicKey);

    // Build metadata
    const metadata: Record<string, unknown> = {};
    if (bio && typeof bio === 'string') {
      metadata.bio = bio.trim().slice(0, 500);
    }

    // Insert identity
    await db.insert(identities).values({
      id: agentDid,
      scope: 'actor',
      subtype: 'agent',
      publicKey,
      handle,
      name: trimmedDisplayName,
      tier: 'preliminary',
      metadata: Object.keys(metadata).length > 0 ? metadata : {},
    });

    // Link agent to owner
    await db.insert(identityMembers).values({
      identityDid: agentDid,
      memberDid: caller.id,
      role: 'owner',
      addedBy: caller.id,
    });

    // Reverse membership: agent is delegated to human
    await db.insert(identityMembers).values({
      identityDid: caller.id,
      memberDid: agentDid,
      role: 'agent',
      addedBy: caller.id,
    });

    return NextResponse.json(
      {
        did: agentDid,
        handle,
        displayName: trimmedDisplayName,
        name: trimmedDisplayName,
        scope: 'actor',
        subtype: 'agent',
        tier: 'preliminary',
        publicKey,
        keypair: {
          privateKey,
          publicKey,
        },
        createdAt: new Date().toISOString(),
      },
      { status: 201 }
    );
  } catch (error) {
    log.error({ err: String(error) }, '[agents] Create error');
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 });
  }
}
