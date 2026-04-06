import { NextRequest, NextResponse } from 'next/server';
import { db, identities, storedKeys, groupIdentities, groupControllers, profiles } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { generateKeypair } from '@imajin/auth';
import { didFromPublicKey } from '@/src/lib/auth/crypto';
import { emitAttestation } from '@imajin/auth';

const VALID_SCOPES = ['org', 'community', 'family'] as const;
type GroupScope = typeof VALID_SCOPES[number];

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
}

async function encryptPrivateKey(privateKeyHex: string): Promise<{ encryptedKey: string; salt: string }> {
  const secret = process.env.GROUP_KEY_ENCRYPTION_SECRET;
  if (!secret) throw new Error('GROUP_KEY_ENCRYPTION_SECRET not set');

  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = Buffer.from(saltBytes).toString('base64');

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  const derivedKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(privateKeyHex);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, derivedKey, plaintext);

  // Prepend IV to ciphertext
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return { encryptedKey: Buffer.from(combined).toString('base64'), salt };
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

  const { scope, name, handle, description } = body as {
    scope?: string;
    name?: string;
    handle?: string;
    description?: string;
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

    // Generate Ed25519 keypair server-side
    const { privateKey, publicKey } = generateKeypair();
    const groupDid = didFromPublicKey(publicKey);

    // Encrypt and store private key
    const { encryptedKey, salt } = await encryptPrivateKey(privateKey);
    const keyId = genId('key');

    // Store identity
    await db.insert(identities).values({
      id: groupDid,
      type: scope,  // 'org' | 'community' | 'family'
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

    // Store group identity record
    await db.insert(groupIdentities).values({
      groupDid,
      scope: scope as GroupScope,
      createdBy: caller.id,
    });

    // Add creator as owner
    await db.insert(groupControllers).values({
      groupDid,
      controllerDid: caller.id,
      role: 'owner',
      addedBy: caller.id,
    });

    // Create profile (fire-and-forget)
    try {
      await db.insert(profiles).values({
        did: groupDid,
        displayName: name.trim().slice(0, 100),
        handle: handle || null,
        bio: description || null,
        displayType: scope,
      }).onConflictDoNothing();
    } catch (err) {
      console.error('[groups] Profile creation failed (non-fatal):', err);
    }

    // Emit attestation (fire-and-forget)
    emitAttestation({
      issuer_did: caller.id,
      subject_did: groupDid,
      type: 'group.created',
      context_id: groupDid,
      context_type: 'group',
      payload: { scope, name: name.trim(), handle: handle || null },
    }).catch((err) => console.error('[groups] Attestation failed (non-fatal):', err));

    return NextResponse.json({ did: groupDid, scope, handle: handle || null, name: name.trim() }, { status: 201 });
  } catch (error) {
    console.error('[groups] Create error:', error);
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
        groupDid: groupControllers.groupDid,
        role: groupControllers.role,
        scope: groupIdentities.scope,
        name: identities.name,
        handle: identities.handle,
      })
      .from(groupControllers)
      .innerJoin(groupIdentities, eq(groupControllers.groupDid, groupIdentities.groupDid))
      .innerJoin(identities, eq(groupControllers.groupDid, identities.id))
      .where(
        and(
          eq(groupControllers.controllerDid, caller.id),
          isNull(groupControllers.removedAt)
        )
      );

    return NextResponse.json(rows);
  } catch (error) {
    console.error('[groups] List error:', error);
    return NextResponse.json({ error: 'Failed to list groups' }, { status: 500 });
  }
}
