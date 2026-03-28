import { db, events } from '@/src/db';
import { eq } from 'drizzle-orm';
import { getClient } from '@imajin/db';

const sql = getClient();

/**
 * Check if a DID is an organizer of an event.
 * An organizer is: the creator or a cohost (via pod_members).
 *
 * Returns { authorized: true, role } or { authorized: false }.
 */
export async function isEventOrganizer(
  eventId: string,
  did: string
): Promise<{ authorized: true; role: 'creator' | 'cohost' } | { authorized: false }> {
  const [event] = await db
    .select({ creatorDid: events.creatorDid, podId: events.podId })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event) return { authorized: false };

  if (event.creatorDid === did) {
    return { authorized: true, role: 'creator' };
  }

  if (event.podId) {
    const cohostRows = await sql`
      SELECT did FROM connections.pod_members
      WHERE pod_id = ${event.podId} AND did = ${did} AND role IN ('owner', 'cohost') AND removed_at IS NULL
      LIMIT 1
    `;
    if (cohostRows.length > 0) {
      return { authorized: true, role: 'cohost' };
    }
  }

  return { authorized: false };
}
