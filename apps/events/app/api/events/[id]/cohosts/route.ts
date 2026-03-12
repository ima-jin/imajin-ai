import { NextRequest, NextResponse } from 'next/server';
import { db, events } from '@/src/db';
import { requireAuth } from '@/src/lib/auth';
import { eq } from 'drizzle-orm';
import { getClient } from '@imajin/db';

const sql = getClient();

const PROFILE_SERVICE_URL = process.env.PROFILE_SERVICE_URL || 'http://localhost:3005';
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
 * GET /api/events/[id]/cohosts — list cohosts for an event
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;

  try {
    const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    if (!event.podId) {
      return NextResponse.json({ cohosts: [] });
    }

    const rows = await sql`
      SELECT did, role, added_by, joined_at
      FROM connections.pod_members
      WHERE pod_id = ${event.podId} AND role = 'cohost'
      ORDER BY joined_at ASC
    `;

    const cohosts = await Promise.all(
      rows.map(async (row) => {
        const profile = await resolveProfile(row.did as string);
        return {
          ...profile,
          role: 'cohost',
          addedAt: row.joined_at,
        };
      })
    );

    return NextResponse.json({ cohosts });
  } catch (error) {
    console.error('Failed to list cohosts:', error);
    return NextResponse.json({ error: 'Failed to list cohosts' }, { status: 500 });
  }
}

/**
 * POST /api/events/[id]/cohosts — add a cohost (owner only)
 * Body: { handle: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const { id } = params;

  try {
    const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Only owner can add cohosts
    if (event.creatorDid !== identity.id) {
      return NextResponse.json({ error: 'Only the event owner can add cohosts' }, { status: 403 });
    }

    if (!event.podId) {
      return NextResponse.json({ error: 'Event pod not initialized' }, { status: 500 });
    }

    const body = await request.json();
    const { handle, did: didParam } = body;

    if (!didParam && !handle) {
      return NextResponse.json({ error: 'did or handle is required' }, { status: 400 });
    }

    // Look up DID from handle via profile service (or use did directly)
    let coHostDid: string;
    let profileData: { name?: string; handle?: string; avatar?: string; avatarUrl?: string } = {};

    if (didParam && typeof didParam === 'string') {
      coHostDid = didParam;
      // Resolve profile for the DID
      try {
        const profile = await resolveProfile(coHostDid);
        profileData = { name: profile.name || undefined, handle: profile.handle || undefined, avatar: profile.avatar || undefined };
      } catch {}
    } else {
      if (typeof handle !== 'string') {
        return NextResponse.json({ error: 'handle must be a string' }, { status: 400 });
      }
      try {
        const res = await fetch(
          `${PROFILE_SERVICE_URL}/api/profile/by-handle/${encodeURIComponent(handle.replace(/^@/, ''))}`,
          { cache: 'no-store' }
        );
        if (!res.ok) {
          return NextResponse.json({ error: 'Handle not found' }, { status: 404 });
        }
        const data = await res.json();
        coHostDid = data.did;
        profileData = data;
        if (!coHostDid) {
          return NextResponse.json({ error: 'Could not resolve DID for handle' }, { status: 404 });
        }
      } catch {
        return NextResponse.json({ error: 'Failed to look up handle' }, { status: 502 });
      }
    }

    // Can't add yourself
    if (coHostDid === identity.id) {
      return NextResponse.json({ error: 'Cannot add yourself as cohost' }, { status: 400 });
    }

    // Can't add the existing owner
    if (coHostDid === event.creatorDid) {
      return NextResponse.json({ error: 'Event creator is already the owner' }, { status: 400 });
    }

    // Add to pod as cohost
    await sql`
      INSERT INTO connections.pod_members (pod_id, did, role, added_by, joined_at)
      VALUES (${event.podId}, ${coHostDid}, 'cohost', ${identity.id}, NOW())
      ON CONFLICT (pod_id, did) DO NOTHING
    `;

    const cohost = {
      did: coHostDid,
      name: profileData.name || null,
      handle: profileData.handle || (handle ? handle.replace(/^@/, '') : null),
      avatar: profileData.avatarUrl || profileData.avatar || null,
      role: 'cohost',
      addedAt: new Date().toISOString(),
    };

    return NextResponse.json({ cohost }, { status: 201 });
  } catch (error) {
    console.error('Failed to add cohost:', error);
    return NextResponse.json({ error: 'Failed to add cohost' }, { status: 500 });
  }
}
