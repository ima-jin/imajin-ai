import { NextRequest, NextResponse } from 'next/server';
import { db, events, ticketTypes, eventAdmins } from '@/src/db';
import { requireAuth } from '@/src/lib/auth';
import { eq, and } from 'drizzle-orm';
import { randomBytes } from 'crypto';

/**
 * GET /api/events/[id]/tiers - List ticket tiers
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  
  try {
    const tiers = await db
      .select()
      .from(ticketTypes)
      .where(eq(ticketTypes.eventId, id));

    return NextResponse.json({
      tiers: tiers.map(t => ({
        ...t,
        available: t.quantity !== null ? t.quantity - (t.sold || 0) : null,
      })),
    });
  } catch (error) {
    console.error('Failed to list tiers:', error);
    return NextResponse.json({ error: 'Failed to list tiers' }, { status: 500 });
  }
}

/**
 * POST /api/events/[id]/tiers - Create a new tier
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
    // Check authorization
    const authorized = await isEventAdmin(id, identity.id);
    if (!authorized) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = await request.json();
    const { name, description, price, currency = 'USD', quantity, perks } = body;

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (price === undefined || price < 0) {
      return NextResponse.json({ error: 'price must be >= 0' }, { status: 400 });
    }

    const tierId = `tkt_type_${randomBytes(8).toString('hex')}`;

    const [tier] = await db.insert(ticketTypes).values({
      id: tierId,
      eventId: id,
      name,
      description,
      price,
      currency,
      quantity,
      perks: perks || [],
    }).returning();

    return NextResponse.json({ tier }, { status: 201 });

  } catch (error) {
    console.error('Failed to create tier:', error);
    return NextResponse.json({ error: 'Failed to create tier' }, { status: 500 });
  }
}

/**
 * PUT /api/events/[id]/tiers - Update a tier (append-only rules)
 */
export async function PUT(
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
    const authorized = await isEventAdmin(id, identity.id);
    if (!authorized) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = await request.json();
    const { tierId, name, description, price, quantity, perks } = body;

    if (!tierId) {
      return NextResponse.json({ error: 'tierId is required' }, { status: 400 });
    }

    // Get current tier
    const [tier] = await db
      .select()
      .from(ticketTypes)
      .where(and(
        eq(ticketTypes.id, tierId),
        eq(ticketTypes.eventId, id)
      ))
      .limit(1);

    if (!tier) {
      return NextResponse.json({ error: 'Tier not found' }, { status: 404 });
    }

    const updates: Record<string, any> = {};
    const violations: string[] = [];

    // Name and description - freely editable
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;

    // Price - can only decrease (or stay same)
    if (price !== undefined) {
      if (price > tier.price) {
        violations.push(`price can only decrease (current: ${tier.price}, requested: ${price})`);
      } else {
        updates.price = price;
      }
    }

    // Quantity - can increase, or decrease to >= sold
    if (quantity !== undefined) {
      const sold = tier.sold || 0;
      if (quantity !== null && quantity < sold) {
        violations.push(`quantity cannot be less than sold count (sold: ${sold}, requested: ${quantity})`);
      } else {
        updates.quantity = quantity;
      }
    }

    // Perks - can only add, not remove
    if (perks !== undefined) {
      const currentPerks = (tier.perks as string[]) || [];
      const newPerks = perks as string[];
      const removedPerks = currentPerks.filter(p => !newPerks.includes(p));
      
      if (removedPerks.length > 0) {
        violations.push(`cannot remove perks: ${removedPerks.join(', ')}`);
      } else {
        updates.perks = newPerks;
      }
    }

    if (violations.length > 0) {
      return NextResponse.json({
        error: 'Append-only policy violation',
        violations,
      }, { status: 400 });
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ tier, message: 'No changes' });
    }

    const [updated] = await db
      .update(ticketTypes)
      .set(updates)
      .where(eq(ticketTypes.id, tierId))
      .returning();

    return NextResponse.json({
      tier: {
        ...updated,
        available: updated.quantity !== null ? updated.quantity - (updated.sold || 0) : null,
      },
    });

  } catch (error) {
    console.error('Failed to update tier:', error);
    return NextResponse.json({ error: 'Failed to update tier' }, { status: 500 });
  }
}

// Helper to check if user is creator or admin
async function isEventAdmin(eventId: string, did: string): Promise<boolean> {
  const [event] = await db
    .select({ creatorDid: events.creatorDid })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event) return false;
  if (event.creatorDid === did) return true;

  const [admin] = await db
    .select()
    .from(eventAdmins)
    .where(and(
      eq(eventAdmins.eventId, eventId),
      eq(eventAdmins.did, did)
    ))
    .limit(1);

  return !!admin;
}
