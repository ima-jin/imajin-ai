import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { eq, desc } from 'drizzle-orm';
import { db, invites } from '../../../src/db/index';
import { generateId } from '../../../src/lib/id';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';

async function getSession(request: NextRequest) {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      headers: { Cookie: request.headers.get('cookie') || '' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession(request);
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const code = randomBytes(12).toString('hex');
  const id = generateId('inv_');

  const [invite] = await db.insert(invites).values({
    id,
    code,
    fromDid: session.did,
    fromHandle: session.handle || null,
    toEmail: body.toEmail || null,
    toPhone: body.toPhone || null,
    note: body.note || null,
    maxUses: body.maxUses || 1,
  }).returning();

  const inviteUrl = `${SERVICE_PREFIX}connections.${DOMAIN}/invite/${session.did}/${code}`;

  return NextResponse.json({ invite, url: inviteUrl }, { status: 201 });
}

export async function GET(request: NextRequest) {
  const session = await getSession(request);
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const results = await db
    .select()
    .from(invites)
    .where(eq(invites.fromDid, session.did))
    .orderBy(desc(invites.createdAt));

  const now = Date.now();
  const withDaysAgo = results.map((inv) => ({
    ...inv,
    daysAgo: inv.createdAt ? Math.floor((now - new Date(inv.createdAt).getTime()) / 86400000) : 0,
    url: `${SERVICE_PREFIX}connections.${DOMAIN}/invite/${inv.fromDid}/${inv.code}`,
  }));

  return NextResponse.json({ invites: withDaysAgo });
}
