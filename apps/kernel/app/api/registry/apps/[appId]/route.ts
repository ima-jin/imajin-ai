import { NextRequest, NextResponse } from 'next/server';
import { db, registryApps } from '@/src/db';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';

// GET /api/registry/apps/:appId — app detail (public, privateKey excluded)
export async function GET(
  _request: NextRequest,
  { params }: { params: { appId: string } }
) {
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

// PATCH /api/registry/apps/:appId — update (owner only)
export async function PATCH(
  request: NextRequest,
  { params }: { params: { appId: string } }
) {
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
  if (existing.ownerDid !== identity.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const updates: Partial<typeof registryApps.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim();
  if (typeof body.description === 'string') updates.description = body.description || null;
  if (typeof body.callbackUrl === 'string' && body.callbackUrl) updates.callbackUrl = body.callbackUrl;
  if (typeof body.homepageUrl === 'string') updates.homepageUrl = body.homepageUrl || null;
  if (typeof body.logoUrl === 'string') updates.logoUrl = body.logoUrl || null;
  if (Array.isArray(body.requestedScopes)) updates.requestedScopes = body.requestedScopes;

  const [updated] = await db
    .update(registryApps)
    .set(updates)
    .where(eq(registryApps.id, params.appId))
    .returning();

  // Strip privateKey from response
  const { privateKey: _pk, ...safeApp } = updated;
  return NextResponse.json(safeApp);
}

// DELETE /api/registry/apps/:appId — soft revoke (owner only)
export async function DELETE(
  request: NextRequest,
  { params }: { params: { appId: string } }
) {
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
  if (existing.ownerDid !== identity.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await db
    .update(registryApps)
    .set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(registryApps.id, params.appId));

  return NextResponse.json({ ok: true });
}
