import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { revalidatePath } from 'next/cache';

const log = createLogger('events');
import { db, events, ticketTypes } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { eq, and, asc, isNull } from 'drizzle-orm';
import { randomBytes } from 'crypto';

/**
 * GET /api/events/[id]/tiers - List public ticket tiers (excludes access-code-protected)
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
      .where(and(eq(ticketTypes.eventId, id), isNull(ticketTypes.accessCode)))
      .orderBy(asc(ticketTypes.sortOrder));

    return NextResponse.json({
      tiers: tiers.map(t => ({
        ...t,
        available: t.quantity !== null ? t.quantity - (t.sold || 0) : null,
      })),
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to list tiers');
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
  const did = identity.actingAs || identity.id;
  const { id } = await params;

  try {
    // Check authorization
    const orgCheck = await isEventOrganizer(id, did);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = await request.json();
    const { name, description, price, currency = 'USD', quantity, perks, sortOrder, requiresRegistration, registrationFormId, accessCode } = body;

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
      sortOrder: sortOrder ?? 0,
      requiresRegistration: requiresRegistration ?? false,
      registrationFormId: registrationFormId || null,
      accessCode: accessCode?.trim() || null,
    }).returning();

    revalidatePath(`/${id}`);
    return NextResponse.json({ tier }, { status: 201 });

  } catch (error) {
    log.error({ err: String(error) }, 'Failed to create tier');
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
  const did = identity.actingAs || identity.id;
  const { id } = await params;

  try {
    const orgCheck = await isEventOrganizer(id, did);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = await request.json();
    const { tierId, name, description, price, quantity, perks, sortOrder, requiresRegistration, registrationFormId, accessCode } = body;

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

    // Name, description, sort order, registration fields - freely editable
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (sortOrder !== undefined) updates.sortOrder = sortOrder;
    if (requiresRegistration !== undefined) updates.requiresRegistration = requiresRegistration;
    if (registrationFormId !== undefined) updates.registrationFormId = registrationFormId || null;
    if (accessCode !== undefined) updates.accessCode = accessCode?.trim() || null;

    // Price - freely editable if no tickets sold, can only decrease after sales
    if (price !== undefined) {
      const sold = tier.sold || 0;
      if (sold === 0) {
        updates.price = price;
      } else if (price > tier.price) {
        violations.push(`price can only decrease after tickets are sold (current: ${tier.price}, requested: ${price})`);
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

    // Perks - freely editable if no tickets sold, append-only after sales
    if (perks !== undefined) {
      const sold = tier.sold || 0;
      if (sold === 0) {
        // No tickets sold — free to edit
        updates.perks = perks;
      } else {
        // Tickets sold — can only add, not remove
        const currentPerks = (tier.perks as string[]) || [];
        const newPerks = perks as string[];
        const removedPerks = currentPerks.filter(p => !newPerks.includes(p));
        
        if (removedPerks.length > 0) {
          violations.push(`cannot remove perks after tickets are sold: ${removedPerks.join(', ')}`);
        } else {
          updates.perks = newPerks;
        }
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

    revalidatePath(`/${id}`);

    return NextResponse.json({
      tier: {
        ...updated,
        available: updated.quantity !== null ? updated.quantity - (updated.sold || 0) : null,
      },
    });

  } catch (error) {
    log.error({ err: String(error) }, 'Failed to update tier');
    return NextResponse.json({ error: 'Failed to update tier' }, { status: 500 });
  }
}


