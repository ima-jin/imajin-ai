import { NextRequest, NextResponse } from 'next/server';
import { db, identities, storedKeys, identityMembers, profiles, attestations } from '@/src/db';
import { eq, and, isNull, count } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { generateKeypair } from '@imajin/auth';
import { didFromPublicKey, encryptPrivateKey } from '@/src/lib/auth/crypto';
import { emitAttestation } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

const MAX_STUBS_PER_ACTOR = 10;

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
}

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
    const [{ value: stubCount }] = await db
      .select({ value: count() })
      .from(identityMembers)
      .where(
        and(
          eq(identityMembers.memberDid, caller.id),
          eq(identityMembers.role, 'maintainer'),
          isNull(identityMembers.removedAt)
        )
      );
    if (stubCount >= MAX_STUBS_PER_ACTOR) {
      return NextResponse.json(
        { error: `Maximum of ${MAX_STUBS_PER_ACTOR} maintained places reached` },
        { status: 429 }
      );
    }

    // Check handle uniqueness
    if (handle) {
      const existing = await db
        .select({ id: identities.id })
        .from(identities)
        .where(eq(identities.handle, handle))
        .limit(1);
      if (existing.length > 0) {
        return NextResponse.json({ error: 'Handle already taken' }, { status: 409 });
      }
    }

    // Generate Ed25519 keypair server-side
    const { privateKey, publicKey } = generateKeypair();
    const stubDid = didFromPublicKey(publicKey);

    // Encrypt and store private key
    const { encryptedKey, salt } = await encryptPrivateKey(privateKey);
    const keyId = genId('key');

    const trimmedName = name.trim().slice(0, 100);

    // Store identity
    await db.insert(identities).values({
      id: stubDid,
      scope: 'business',
      subtype: (subtype as string) || null,
      publicKey,
      handle: handle || null,
      name: trimmedName,
      tier: 'preliminary',
    });

    // Store encrypted private key
    await db.insert(storedKeys).values({
      id: keyId,
      did: stubDid,
      encryptedKey,
      salt,
      keyDerivation: 'pbkdf2',
    });

    // Create profile
    const metadata: Record<string, string | number> = {};
    if (location) metadata.location = String(location).slice(0, 200);
    if (category) metadata.category = String(category).slice(0, 100);
    if (typeof lat === 'number' && typeof lon === 'number' && isFinite(lat) && isFinite(lon)) {
      metadata.lat = Math.round(lat * 1e6) / 1e6;  // ~11cm precision
      metadata.lon = Math.round(lon * 1e6) / 1e6;
    }

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
    });

    // Emit attestation (fire-and-forget)
    emitAttestation({
      issuer_did: caller.id,
      subject_did: stubDid,
      type: 'stub.created',
      context_id: stubDid,
      context_type: 'stub',
      payload: { name: trimmedName, handle: handle || null, category: category || null },
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
