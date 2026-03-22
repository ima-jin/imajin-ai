import { NextRequest, NextResponse } from 'next/server';
import { db, assets, assetReferences } from '@/src/db';
import { eq } from 'drizzle-orm';

/**
 * POST /api/assets/{id}/references
 * Register a service entity reference to an asset.
 * Body: { service: string, entityType: string, entityId: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const internalApiKey = process.env.AUTH_INTERNAL_API_KEY;
  const authHeader = request.headers.get('authorization');
  if (!internalApiKey || authHeader !== `Bearer ${internalApiKey}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [asset] = await db.select({ id: assets.id }).from(assets).where(eq(assets.id, id)).limit(1);
  if (!asset) {
    return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const { service, entityType, entityId } = body;
  if (!service || !entityType || !entityId) {
    return NextResponse.json({ error: 'service, entityType, and entityId are required' }, { status: 400 });
  }

  const refId = `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [ref] = await db
    .insert(assetReferences)
    .values({ id: refId, assetId: id, service, entityType, entityId })
    .onConflictDoNothing()
    .returning();

  return NextResponse.json({ ok: true, reference: ref ?? null }, { status: 201 });
}
