import { NextRequest, NextResponse } from 'next/server';
import { db, identities, storedKeys, identityMembers, profiles } from '@/src/db';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { generateKeypair } from '@imajin/auth';
import { didFromPublicKey, encryptPrivateKey } from '@/src/lib/auth/crypto';
import { emitAttestation } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

const VALID_SCOPES = ['business', 'community', 'family'] as const;
type GroupScope = typeof VALID_SCOPES[number];

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
}

/**
 * POST /api/groups
 * Create a group identity (org, community, or family).
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

  const { scope, name, handle, description, subtype, category, location, lat, lon } = body as {
    scope?: string;
    name?: string;
    handle?: string;
    description?: string;
    subtype?: string;
    category?: string;
    location?: string;
    lat?: number;
    lon?: number;
  };

  if (!scope || !VALID_SCOPES.includes(scope as GroupScope)) {
    return NextResponse.json(
      { error: `scope required: ${VALID_SCOPES.join(', ')}` },
      { status: 400 }
    );
  }
  if (!name || typeof name !== 'string') {
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  }
  if (handle && !/^[a-z0-9_]{3,30}$/.test(handle)) {
    return NextResponse.json(
      { error: 'Handle must be 3-30 lowercase letters, numbers, or underscores' },
      { status: 400 }
    );
  }

  try {
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

    const validatedScope = scope as GroupScope;

    // Generate Ed25519 keypair server-side
    const { privateKey, publicKey } = generateKeypair();
    const groupDid = didFromPublicKey(publicKey);

    // Encrypt and store private key
    const { encryptedKey, salt } = await encryptPrivateKey(privateKey);
    const keyId = genId('key');

    // Store identity
    await db.insert(identities).values({
      id: groupDid,
      scope: validatedScope,
      subtype: subtype || null,
      publicKey,
      handle: handle || null,
      name: name.trim().slice(0, 100),
      tier: 'preliminary',
    });

    // Store encrypted private key
    await db.insert(storedKeys).values({
      id: keyId,
      did: groupDid,
      encryptedKey,
      salt,
      keyDerivation: 'pbkdf2',
    });

    // Add creator as owner
    await db.insert(identityMembers).values({
      identityDid: groupDid,
      memberDid: caller.id,
      role: 'owner',
      addedBy: caller.id,
    });

    // Create profile (fire-and-forget)
    try {
      const trimmedName = name.trim().slice(0, 100);
      const metadata: Record<string, string | number> = {};
      if (location) metadata.location = String(location).slice(0, 200);
      if (category) metadata.category = String(category).slice(0, 100);
      if (typeof lat === 'number' && typeof lon === 'number' && isFinite(lat) && isFinite(lon)) {
        metadata.lat = Math.round(lat * 1e6) / 1e6;
        metadata.lon = Math.round(lon * 1e6) / 1e6;
      }

      // Server-side geocoding fallback: if no coords from client but location text is present, query Nominatim
      let resolvedLat = lat;
      let resolvedLon = lon;
      if (!resolvedLat && !resolvedLon && location) {
        try {
          const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
          const geoRes = await fetch(geoUrl, {
            headers: { 'User-Agent': 'Imajin/1.0 (https://imajin.ai)' },
          });
          if (geoRes.ok) {
            const geoData = await geoRes.json() as Array<{ lat: string; lon: string }>;
            if (geoData.length > 0) {
              resolvedLat = parseFloat(geoData[0].lat);
              resolvedLon = parseFloat(geoData[0].lon);
            }
          }
        } catch (err) {
          log.error({ err: String(err) }, '[groups] Nominatim geocode failed (non-fatal)');
        }
      }
      if (resolvedLat != null) metadata.lat = String(resolvedLat);
      if (resolvedLon != null) metadata.lon = String(resolvedLon);

      await db.insert(profiles).values({
        did: groupDid,
        displayName: trimmedName,
        handle: handle || null,
        bio: description || null,
        metadata,
      }).onConflictDoNothing();
    } catch (err) {
      log.error({ err: String(err) }, '[groups] Profile creation failed (non-fatal)');
    }

    // Emit attestation (fire-and-forget)
    emitAttestation({
      issuer_did: caller.id,
      subject_did: groupDid,
      type: 'group.created',
      context_id: groupDid,
      context_type: 'group',
      payload: { scope, name: name.trim(), handle: handle || null },
    }).catch((err) => log.error({ err: String(err) }, '[groups] Attestation failed (non-fatal)'));

    return NextResponse.json({ did: groupDid, scope, handle: handle || null, name: name.trim() }, { status: 201 });
  } catch (error) {
    log.error({ err: String(error) }, '[groups] Create error');
    return NextResponse.json({ error: 'Failed to create group' }, { status: 500 });
  }
}

/**
 * GET /api/groups
 * List groups the caller controls.
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
        groupDid: identityMembers.identityDid,
        role: identityMembers.role,
        scope: identities.scope,
        name: identities.name,
        handle: identities.handle,
      })
      .from(identityMembers)
      .innerJoin(identities, eq(identityMembers.identityDid, identities.id))
      .where(
        and(
          eq(identityMembers.memberDid, caller.id),
          isNull(identityMembers.removedAt),
          inArray(identityMembers.role, ['owner', 'admin'])
        )
      );

    return NextResponse.json(rows);
  } catch (error) {
    log.error({ err: String(error) }, '[groups] List error');
    return NextResponse.json({ error: 'Failed to list groups' }, { status: 500 });
  }
}
