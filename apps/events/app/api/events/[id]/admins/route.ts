import { NextRequest, NextResponse } from 'next/server';
import { db, events, eventAdmins } from '@/src/db';
import { requireAuth } from '@/src/lib/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { eq, and } from 'drizzle-orm';

/**
 * GET /api/events/[id]/admins - List event admins
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  
  try {
    const admins = await db
      .select()
      .from(eventAdmins)
      .where(eq(eventAdmins.eventId, id));

    // Also get the creator (implicit owner)
    const [event] = await db
      .select({ creatorDid: events.creatorDid })
      .from(events)
      .where(eq(events.id, id))
      .limit(1);

    return NextResponse.json({ 
      creator: event?.creatorDid,
      admins 
    });
  } catch (error) {
    console.error('Failed to list admins:', error);
    return NextResponse.json({ error: 'Failed to list admins' }, { status: 500 });
  }
}

/**
 * POST /api/events/[id]/admins - Add an admin (requires owner/admin)
 */
export async function POST(
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
    // Check event exists and user is authorized
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, id))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Must be an organizer (creator, admin, or cohost) to add admins
    const orgCheck = await isEventOrganizer(id, identity.id);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = await request.json();
    const { did, role = 'admin' } = body;

    if (!did) {
      return NextResponse.json({ error: 'did is required' }, { status: 400 });
    }

    // Can't add yourself
    if (did === identity.id) {
      return NextResponse.json({ error: 'Cannot add yourself as admin' }, { status: 400 });
    }

    // Can't add the creator (they're already implicit owner)
    if (did === event.creatorDid) {
      return NextResponse.json({ error: 'Creator is already the owner' }, { status: 400 });
    }

    // Check if already an admin
    const [existing] = await db
      .select()
      .from(eventAdmins)
      .where(and(
        eq(eventAdmins.eventId, id),
        eq(eventAdmins.did, did)
      ))
      .limit(1);

    if (existing) {
      return NextResponse.json({ error: 'Already an admin' }, { status: 409 });
    }

    // Only creator can add owners
    if (role === 'owner' && !isCreator) {
      return NextResponse.json({ error: 'Only creator can add owners' }, { status: 403 });
    }

    const [admin] = await db.insert(eventAdmins).values({
      eventId: id,
      did,
      role,
      addedBy: identity.id,
    }).returning();

    return NextResponse.json({ admin }, { status: 201 });

  } catch (error) {
    console.error('Failed to add admin:', error);
    return NextResponse.json({ error: 'Failed to add admin' }, { status: 500 });
  }
}

/**
 * DELETE /api/events/[id]/admins - Remove an admin
 */
export async function DELETE(
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
    const { searchParams } = new URL(request.url);
    const did = searchParams.get('did');

    if (!did) {
      return NextResponse.json({ error: 'did is required' }, { status: 400 });
    }

    // Check event and authorization
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, id))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Admins/cohosts can remove themselves, organizers can remove anyone
    const isSelf = did === identity.id;
    const orgCheck = await isEventOrganizer(id, identity.id);
    
    if (!orgCheck.authorized && !isSelf) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const result = await db
      .delete(eventAdmins)
      .where(and(
        eq(eventAdmins.eventId, id),
        eq(eventAdmins.did, did)
      ))
      .returning();

    if (result.length === 0) {
      return NextResponse.json({ error: 'Admin not found' }, { status: 404 });
    }

    return NextResponse.json({ message: 'Admin removed' });

  } catch (error) {
    console.error('Failed to remove admin:', error);
    return NextResponse.json({ error: 'Failed to remove admin' }, { status: 500 });
  }
}
