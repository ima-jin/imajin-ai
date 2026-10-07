import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { db, registryApps } from '@/src/db';
import { eq, desc, and } from 'drizzle-orm';
import { requireAuth, generateKeypair, isValidPublicKey, resolveActingDid } from '@imajin/auth';
import { didFromPublicKey } from '@/src/lib/auth/crypto';
import { validateAppDeclarations, DEPENDS_ON_OPERATOR_ONLY_ERROR } from '@/src/lib/kernel/app-declarations';
import { withLogger } from '@imajin/logger';

/** `[origin]` of an absolute URL, or `null` when it isn't one. */
function originOf(url: string): string[] | null {
  try {
    return [new URL(url).origin];
  } catch {
    return null;
  }
}

/**
 * Developer-supplied key (validated; the server never sees the private half), or a
 * server-generated keypair whose private key is returned once and never stored.
 */
function resolveAppKey(
  suppliedPublicKey: unknown,
): { error: string } | { publicKey: string; keypairResponse?: { privateKey: string; publicKey: string } } {
  if (typeof suppliedPublicKey === 'string' && suppliedPublicKey.trim()) {
    if (!isValidPublicKey(suppliedPublicKey)) return { error: 'Invalid Ed25519 public key' };
    return { publicKey: suppliedPublicKey.trim() };
  }
  const generated = generateKeypair();
  return { publicKey: generated.publicKey, keypairResponse: generated };
}

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

  // #2663: `dependsOn` grants an app's tokens another service's audience (e.g.
  // kernel media), so only an operator path may write it — the admin route, or
  // `apps.provision` where the operator approves the list on the /jin card.
  if (body.dependsOn !== undefined) {
    return NextResponse.json({ error: DEPENDS_ON_OPERATOR_ONLY_ERROR }, { status: 400 });
  }

  const { name, description, callbackUrl, homepageUrl, logoUrl, requestedScopes, providesScopes, publicKey: suppliedPublicKey } = body as {
    name?: string;
    description?: string;
    callbackUrl?: string;
    homepageUrl?: string;
    logoUrl?: string;
    requestedScopes?: string[];
    providesScopes?: string[];
    publicKey?: string;
  };

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  if (!callbackUrl || typeof callbackUrl !== 'string') {
    return NextResponse.json({ error: 'callbackUrl is required' }, { status: 400 });
  }

  const keyResult = resolveAppKey(suppliedPublicKey);
  if ('error' in keyResult) {
    return NextResponse.json({ error: keyResult.error }, { status: 400 });
  }
  const { publicKey, keypairResponse } = keyResult;

  // Derive DID from public key
  const appDid = didFromPublicKey(publicKey);

  // #1990: no ad-hoc scope strings — clamp to the declarative SCOPE_VOCABULARY
  // (#1253), the same clamp every scoped-token mint route already applies.
  // #2663: widened by the app's own declared `providesScopes`.
  const declarations = await validateAppDeclarations({ providesScopes, requestedScopes });
  if ('error' in declarations) {
    return NextResponse.json({ error: declarations.error }, { status: 400 });
  }
  const { requestedScopes: scopes, providesScopes: ownScopes } = declarations.ok;

  // #1990: self-service registration always yields a third_party app.
  // first_party is reserved for the admin surface (POST /api/admin/registry/apps).
  // allowedRedirectHosts seeds from callbackUrl's own origin — a developer can
  // register additional hosts later via the admin surface.
  const allowedRedirectHosts = originOf(callbackUrl);
  if (!allowedRedirectHosts) {
    return NextResponse.json({ error: 'callbackUrl must be an absolute URL' }, { status: 400 });
  }

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
    requestedScopes: scopes,
    providesScopes: ownScopes,
    tier: 'third_party',
    allowedRedirectHosts,
    // #1348: this surface only ever takes a single callbackUrl, so the
    // registered redirect_uris set is that one URI. Kept in sync with
    // callbackUrl so /oauth/authorize's exact-set match behaves identically
    // to the pre-#1348 single-callback comparison for these apps.
    redirectUris: [callbackUrl],
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
      providesScopes: registryApps.providesScopes,
      dependsOn: registryApps.dependsOn,
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
