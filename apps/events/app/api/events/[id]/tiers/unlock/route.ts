import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { db, ticketTypes } from '@/src/db';
import { eq, and, asc, sql } from 'drizzle-orm';

const log = createLogger('events');

export const dynamic = 'force-dynamic';

/**
 * GET /api/events/[id]/tiers/unlock?code=XXXX
 *
 * Returns ticket types matching the given access code (case-insensitive).
 * No auth required. Used to reveal hidden/staff/VIP ticket tiers.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code')?.trim();

  if (!code) {
    return NextResponse.json({ error: 'Missing code parameter' }, { status: 400 });
  }

  try {
    // Case-insensitive match using LOWER()
    const tiers = await db
      .select()
      .from(ticketTypes)
      .where(
        and(
          eq(ticketTypes.eventId, id),
          sql`LOWER(${ticketTypes.accessCode}) = LOWER(${code})`
        )
      )
      .orderBy(asc(ticketTypes.sortOrder));

    if (tiers.length === 0) {
      return NextResponse.json({ error: 'Invalid access code' }, { status: 404 });
    }

    return NextResponse.json({
      tiers: tiers.map(t => ({
        ...t,
        available: t.quantity !== null ? t.quantity - (t.sold || 0) : null,
      })),
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to unlock tiers');
    return NextResponse.json({ error: 'Failed to unlock tiers' }, { status: 500 });
  }
}
