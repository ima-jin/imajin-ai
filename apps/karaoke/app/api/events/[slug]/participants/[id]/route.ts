import { NextRequest, NextResponse } from 'next/server';
import { db, participants } from '@/db';
import { eq } from 'drizzle-orm';

// PATCH /api/events/[slug]/participants/[id] - Update participant status
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { status } = body;

    if (!status || !['waiting', 'active', 'complete', 'skipped'].includes(status)) {
      return NextResponse.json(
        { error: 'Invalid status. Must be: waiting, active, complete, or skipped' },
        { status: 400 }
      );
    }

    // Get current participant
    const [participant] = await db
      .select()
      .from(participants)
      .where(eq(participants.id, id));

    if (!participant) {
      return NextResponse.json({ error: 'Participant not found' }, { status: 404 });
    }

    const updateData: Record<string, unknown> = { status };
    const now = new Date();

    // Track turn timing
    if (status === 'active' && participant.status === 'waiting') {
      updateData.turnStart = now;
    } else if ((status === 'complete' || status === 'skipped') && participant.turnStart) {
      updateData.turnEnd = now;
    } else if (status === 'complete' && !participant.turnStart) {
      // If completing without ever being marked active, set both times
      updateData.turnStart = now;
      updateData.turnEnd = now;
    }

    const [updatedParticipant] = await db
      .update(participants)
      .set(updateData)
      .where(eq(participants.id, id))
      .returning();

    return NextResponse.json(updatedParticipant);
  } catch (error) {
    console.error('Error updating participant:', error);
    return NextResponse.json({ error: 'Failed to update participant' }, { status: 500 });
  }
}
