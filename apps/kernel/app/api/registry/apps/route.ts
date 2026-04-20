import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { db, registryApps } from '@/src/db';
import { eq, desc, and } from 'drizzle-orm';
import { requireAuth, isValidPublicKey } from '@imajin/auth';
import { didFromPublicKey, publicKeyFromDid } from '@/src/lib/auth/crypto';
import { withLogger } from '@imajin/logger';

// POST /api/registry/apps — register a new app (authenticated)
// Developer generates their own keypair locally and submits publicKey.
// The server never sees or generates the private key.
export const POST = withLogger('kernel', async (request: NextRequest) => {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { identity } = authResult;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { name, description, callbackUrl, homepageUrl, logoUrl, requestedScopes, publicKey } = body as {
    name?: string;
    description?: string;
    callbackUrl?: string;
    homepageUrl?: string;
    logoUrl?: string;
    requestedScopes?: string[];
    publicKey?: string;
  };

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  if (!callbackUrl || typeof callbackUrl !== 'string') {
    return NextResponse.json({ error: 'callbackUrl is required' }, { status: 400 });
  }
  if (!publicKey || typeof publicKey !== 'string') {
    return NextResponse.json({ error: 'publicKey is required — generate an Ed25519 keypair locally and submit the public key' }, { status: 400 });
  }
  if (!isValidPublicKey(publicKey)) {
    return NextResponse.json({ error: 'Invalid Ed25519 public key' }, { status: 400 });
  }

  // Derive DID from the submitted public key — same as human identity creation
  const appDid = didFromPublicKey(publicKey);

  const [app] = await db.insert(registryApps).values({
    id: `app_${nanoid(16)}`,
    ownerDid: identity.id,
    name: name.trim(),
    description: typeof description === 'string' ? description.trim() || null : null,
    appDid,
    publicKey,
    callbackUrl,
    homepageUrl: typeof homepageUrl === 'string' ? homepageUrl || null : null,
    logoUrl: typeof logoUrl === 'string' ? logoUrl || null : null,
    requestedScopes: Array.isArray(requestedScopes) ? requestedScopes : [],
  }).returning();

  return NextResponse.json(app, { status: 201 });
});

// GET /api/registry/apps — list active apps (public, paginated)
// ?owner=me — filter to apps owned by the authenticated user
export const GET = withLogger('kernel', async (request: NextRequest) => {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10), 0);
  const owner = url.searchParams.get('owner');

  let ownerDid: string | null = null;
  if (owner === 'me') {
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    ownerDid = authResult.identity.id;
  }

  const whereClause = ownerDid
    ? and(eq(registryApps.ownerDid, ownerDid))
    : eq(registryApps.status, 'active');

  const apps = await db
    .select({
      id: registryApps.id,
      ownerDid: registryApps.ownerDid,
      name: registryApps.name,
      description: registryApps.description,
      appDid: registryApps.appDid,
      publicKey: registryApps.publicKey,
      callbackUrl: registryApps.callbackUrl,
      homepageUrl: registryApps.homepageUrl,
      logoUrl: registryApps.logoUrl,
      requestedScopes: registryApps.requestedScopes,
      status: registryApps.status,
      createdAt: registryApps.createdAt,
    })
    .from(registryApps)
    .where(whereClause)
    .orderBy(desc(registryApps.createdAt))
    .limit(limit)
    .offset(offset);

  return NextResponse.json({ apps, limit, offset });
});
