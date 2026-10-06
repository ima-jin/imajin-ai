import { NextRequest, NextResponse } from 'next/server';
import { db, registryApps } from '@/src/db';
import { eq } from 'drizzle-orm';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { validateAppDeclarations } from '@/src/lib/kernel/app-declarations';

// GET /api/registry/apps/:appId — app detail (public)
export async function GET(_request: NextRequest, props: { params: Promise<{ appId: string }> }) {
  const params = await props.params;
  const [app] = await db
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
      updatedAt: registryApps.updatedAt,
    })
    .from(registryApps)
    .where(eq(registryApps.id, params.appId));

  if (!app) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(app);
}

type AppUpdates = Partial<typeof registryApps.$inferInsert>;

/** The plain, unvalidated owner-editable fields of PATCH. */
function buildFieldUpdates(body: Record<string, unknown>): AppUpdates {
  const updates: AppUpdates = { updatedAt: new Date() };
  if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim();
  if (typeof body.description === 'string') updates.description = body.description || null;
  if (typeof body.callbackUrl === 'string' && body.callbackUrl) updates.callbackUrl = body.callbackUrl;
  if (typeof body.homepageUrl === 'string') updates.homepageUrl = body.homepageUrl || null;
  if (typeof body.logoUrl === 'string') updates.logoUrl = body.logoUrl || null;
  if (Array.isArray(body.requestedScopes)) updates.requestedScopes = body.requestedScopes;
  return updates;
}

/**
 * #2663: validate and collect `providesScopes` / `dependsOn` — only the ones the
 * request actually sent. Nothing is validated, and nothing returned, when
 * neither is present.
 */
async function buildDeclarationUpdates(
  body: Record<string, unknown>,
  slug: string | null,
): Promise<{ ok: Pick<AppUpdates, 'providesScopes' | 'dependsOn'> } | { error: string }> {
  if (body.providesScopes === undefined && body.dependsOn === undefined) return { ok: {} };

  const declarations = await validateAppDeclarations({
    providesScopes: body.providesScopes,
    dependsOn: body.dependsOn,
    slug,
  });
  if ('error' in declarations) return { error: declarations.error };

  const ok: Pick<AppUpdates, 'providesScopes' | 'dependsOn'> = {};
  if (body.providesScopes !== undefined) ok.providesScopes = declarations.ok.providesScopes;
  if (body.dependsOn !== undefined) ok.dependsOn = declarations.ok.dependsOn;
  return { ok };
}

// PATCH /api/registry/apps/:appId — update (owner only)
export async function PATCH(request: NextRequest, props: { params: Promise<{ appId: string }> }) {
  const params = await props.params;
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { identity } = authResult;

  const [existing] = await db
    .select({ id: registryApps.id, ownerDid: registryApps.ownerDid, slug: registryApps.slug })
    .from(registryApps)
    .where(eq(registryApps.id, params.appId));

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (existing.ownerDid !== resolveActingDid(identity)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const updates = buildFieldUpdates(body);

  // #2663: the app's own scopes and dependency list — same assignment model as
  // requestedScopes, validated the same way the register route validates them.
  const declarationUpdates = await buildDeclarationUpdates(body, existing.slug);
  if ('error' in declarationUpdates) {
    return NextResponse.json({ error: declarationUpdates.error }, { status: 400 });
  }
  Object.assign(updates, declarationUpdates.ok);

  const [updated] = await db
    .update(registryApps)
    .set(updates)
    .where(eq(registryApps.id, params.appId))
    .returning();

  return NextResponse.json(updated);
}

// DELETE /api/registry/apps/:appId — soft revoke (owner only)
export async function DELETE(request: NextRequest, props: { params: Promise<{ appId: string }> }) {
  const params = await props.params;
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { identity } = authResult;

  const [existing] = await db
    .select({ id: registryApps.id, ownerDid: registryApps.ownerDid })
    .from(registryApps)
    .where(eq(registryApps.id, params.appId));

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (existing.ownerDid !== resolveActingDid(identity)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await db
    .update(registryApps)
    .set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(registryApps.id, params.appId));

  return NextResponse.json({ ok: true });
}
