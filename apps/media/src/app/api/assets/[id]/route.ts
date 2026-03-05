import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { db } from '@/db';
import { assets, deliveryLogs } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const [asset] = await db
    .select()
    .from(assets)
    .where(eq(assets.id, params.id))
    .limit(1);

  if (!asset) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const granted = asset.ownerDid === auth.identity.id;

  await db.insert(deliveryLogs).values({
    id: `dl_${Date.now()}`,
    assetId: asset.id,
    requesterDid: auth.identity.id,
    granted,
    ruleMatched: granted ? 'owner' : 'denied',
  });

  if (!granted) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json({ asset });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const [asset] = await db
    .select()
    .from(assets)
    .where(eq(assets.id, params.id))
    .limit(1);

  if (!asset) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (asset.ownerDid !== auth.identity.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await db.delete(assets).where(eq(assets.id, params.id));

  return NextResponse.json({ ok: true });
}
