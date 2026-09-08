import { NextRequest, NextResponse } from 'next/server';
import { db, identityMembers, profiles } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import {
  buildStubMetadata,
  checkStubQuota,
  createStubIdentity,
  isStubHandleTaken,
  MAX_STUBS_PER_ACTOR,
} from '@/src/lib/profile/stubs';

const log = createLogger('kernel');

/**
 * POST /api/stubs
 * Create a stub business identity.
 * Only actor-scoped identities (humans) can create stubs.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity: caller } = authResult;

  // Only actors can create stubs
  if (caller.scope !== 'actor') {
    return NextResponse.json({ error: 'Only actor identities can create stubs' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { name, subtype, handle, location, category, lat, lon } = body as {
    name?: string;
    subtype?: string;
    handle?: string;
    location?: string;
    category?: string;
    lat?: number;
    lon?: number;
  };

  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  }
  if (handle && !/^[a-z0-9_]{3,30}$/.test(handle)) {
    return NextResponse.json(
      { error: 'Handle must be 3-30 lowercase letters, numbers, or underscores' },
      { status: 400 }
    );
  }

  try {
    // Rate limit: max MAX_STUBS_PER_ACTOR stubs per actor
    const quotaExceeded = await checkStubQuota(caller.id);
    if (quotaExceeded) {
      return NextResponse.json(
        { error: `Maximum of ${MAX_STUBS_PER_ACTOR} maintained places reached` },
        { status: 429 }
      );
    }

    // Check handle uniqueness
    if (handle && await isStubHandleTaken(handle)) {
      return NextResponse.json({ error: 'Handle already taken' }, { status: 409 });
    }

    const trimmedName = name.trim().slice(0, 100);

    // Generate keypair, encrypt + store the private key, and create the identity row.
    const { stubDid } = await createStubIdentity({ subtype: subtype as string, handle, trimmedName });

    // Build profile metadata (location/category text + resolved coordinates).
    const metadata = await buildStubMetadata({ location, category, lat, lon, log });

    await db.insert(profiles).values({
      did: stubDid,
      displayName: trimmedName,
      handle: handle || null,
      metadata,
      claimStatus: 'unclaimed',
    }).onConflictDoNothing();

    // Add creator as maintainer (not owner — no act-as)
    await db.insert(identityMembers).values({
      identityDid: stubDid,
      memberDid: caller.id,
      role: 'maintainer',
      addedBy: caller.id,
      addedVia: 'direct',
    });

    // Emit attestation (fire-and-forget)
    publish('stub.created', {
      issuer: caller.id,
      subject: stubDid,
      scope: 'profile',
      payload: { name: trimmedName, handle: handle || null, category: category || null, context_id: stubDid, context_type: 'stub' },
    }).catch((err) => log.error({ err: String(err) }, '[stubs] Attestation failed (non-fatal)'));

    return NextResponse.json(
      { did: stubDid, name: trimmedName, handle: handle || null, scope: 'business', claimStatus: 'unclaimed' },
      { status: 201 }
    );
  } catch (error) {
    log.error({ err: String(error) }, '[stubs] Create error');
    return NextResponse.json({ error: 'Failed to create stub' }, { status: 500 });
  }
}
