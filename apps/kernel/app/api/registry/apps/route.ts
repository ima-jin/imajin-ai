import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { db, registryApps } from '@/src/db';
import { eq, desc, and } from 'drizzle-orm';
import { requireAuth, generateKeypair, isValidPublicKey, resolveActingDid } from '@imajin/auth';
import { didFromPublicKey } from '@/src/lib/auth/crypto';
import { withLogger } from '@imajin/logger';

// POST /api/registry/apps — register a new app (authenticated)
// Two modes:
//   1. Server-generated keypair (default): omit publicKey, server generates and returns keypair once
//   2. Developer-supplied key: include publicKey, server never sees private key
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

  const { name, description, callbackUrl, homepageUrl, logoUrl, requestedScopes, publicKey: suppliedPublicKey } = body as {
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

  let publicKey: string;
  let keypairResponse: { privateKey: string; publicKey: string } | undefined;

  if (suppliedPublicKey && typeof suppliedPublicKey === 'string' && suppliedPublicKey.trim()) {
    // Developer supplied their own key
    if (!isValidPublicKey(suppliedPublicKey)) {
      return NextResponse.json({ error: 'Invalid Ed25519 public key' }, { status: 400 });
    }
    publicKey = suppliedPublicKey.trim();
  } else {
    // Generate keypair server-side — return private key once
    const generated = generateKeypair();
    publicKey = generated.publicKey;
    keypairResponse = generated;
  }

  // Derive DID from public key
  const appDid = didFromPublicKey(publicKey);

  const [app] = await db.insert(registryApps).values({
    id: `app_${nanoid(16)}`,
    ownerDid: resolveActingDid(identity),
    name: name.trim(),
    description: typeof description === 'string' ? description.trim() || null : null,
    appDid,
    publicKey,
    callbackUrl,
    homepageUrl: typeof homepageUrl === 'string' ? homepageUrl || null : null,
    logoUrl: typeof logoUrl === 'string' ? logoUrl || null : null,
    requestedScopes: Array.isArray(requestedScopes) ? requestedScopes : [],
  }).returning();

  // Include keypair in response only when server-generated (shown once, never stored)
  const response: Record<string, unknown> = { ...app };
  if (keypairResponse) {
    response.keypair = keypairResponse;
  }

  return NextResponse.json(response, { status: 201 });
});

// GET /api/registry/apps — list active apps (public, paginated)
// ?owner=me — filter to apps owned by the authenticated user
export const GET = withLogger('kernel', async (request: NextRequest) => {
  const url = new URL(request.url);
  const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
  const offset = Math.max(Number.parseInt(url.searchParams.get('offset') ?? '0', 10), 0);
  const owner = url.searchParams.get('owner');

  let ownerDid: string | null = null;
  if (owner === 'me') {
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    ownerDid = resolveActingDid(authResult.identity);
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
