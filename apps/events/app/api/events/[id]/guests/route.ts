import { NextRequest, NextResponse } from 'next/server';
import { db, events } from '@/src/db';
import { requireAuth } from '@/src/lib/auth';
import { eq } from 'drizzle-orm';
import { getClient } from '@imajin/db';

const sql = getClient();

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

async function resolveProfile(did: string): Promise<{ did: string; name: string | null; handle: string | null; avatar: string | null }> {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/lookup/${encodeURIComponent(did)}`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const identity = data.identity || data;
      return {
        did,
        name: identity.name || null,
        handle: identity.handle || null,
        avatar: identity.avatar || identity.avatarUrl || null,
      };
    }
  } catch {}
  return { did, name: null, handle: null, avatar: null };
}

/**
 * GET /api/events/[id]/guests — list all tickets with profile info (owner or cohost)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const { id } = await params;

  try {
    const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    const isOwner = event.creatorDid === identity.id;
    let isCohost = false;

    if (!isOwner && event.podId) {
      const rows = await sql`
        SELECT role FROM connections.pod_members
        WHERE pod_id = ${event.podId} AND did = ${identity.id} AND role IN ('owner', 'cohost')
        LIMIT 1
      `;
      isCohost = rows.length > 0;
    }

    if (!isOwner && !isCohost) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const ticketRows = await sql`
      SELECT t.id, t.status, t.owner_did, t.price_paid, t.currency, t.purchased_at, t.used_at,
             tt.name as ticket_type
      FROM events.tickets t
      JOIN events.ticket_types tt ON t.ticket_type_id = tt.id
      WHERE t.event_id = ${id}
      ORDER BY t.purchased_at DESC
    `;

    // Batch-resolve unique DIDs
    const uniqueDids = [...new Set(ticketRows.map((t: any) => t.owner_did).filter(Boolean))] as string[];
    const profileMap = new Map<string, { name: string | null; handle: string | null; avatar: string | null }>();

    await Promise.all(
      uniqueDids.map(async (did) => {
        const profile = await resolveProfile(did);
        profileMap.set(did, { name: profile.name, handle: profile.handle, avatar: profile.avatar });
      })
    );

    const guests = ticketRows.map((t: any) => {
      const profile = t.owner_did ? profileMap.get(t.owner_did) ?? null : null;
      return {
        id: t.id,
        status: t.status,
        ownerDid: t.owner_did,
        pricePaid: t.price_paid,
        currency: t.currency,
        purchasedAt: t.purchased_at,
        usedAt: t.used_at,
        ticketType: t.ticket_type,
        profile,
      };
    });

    return NextResponse.json({ guests, isOwner });
  } catch (error) {
    console.error('Failed to fetch guests:', error);
    return NextResponse.json({ error: 'Failed to fetch guests' }, { status: 500 });
  }
}
