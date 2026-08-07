import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { db, events } from '@/src/db';
import { requireAuth , resolveActingDid } from '@imajin/auth';

const log = createLogger('events');
import { eq } from 'drizzle-orm';
import { getClient } from '@imajin/db';
import { resolveCoHostDid } from '@/src/lib/cohost-helpers';

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
 * GET /api/events/[id]/cohosts — list cohosts for an event
 */
export async function GET(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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
    log.error({ err: String(error) }, 'Failed to list cohosts');
    return NextResponse.json({ error: 'Failed to list cohosts' }, { status: 500 });
  }
}

/**
 * POST /api/events/[id]/cohosts — add a cohost (owner only)
 * Body: { handle: string }
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const did = resolveActingDid(identity);
  const { id } = params;

  try {
    const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Only owner can add cohosts
    if (event.creatorDid !== did) {
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
    const resolvedCoHost = await resolveCoHostDid(didParam, handle);
    if ('error' in resolvedCoHost) {
      return NextResponse.json({ error: resolvedCoHost.error }, { status: resolvedCoHost.status });
    }
    const { coHostDid, profileData } = resolvedCoHost;

    // Can't add yourself
    if (coHostDid === did) {
      return NextResponse.json({ error: 'Cannot add yourself as cohost' }, { status: 400 });
    }

    // Can't add the existing owner
    if (coHostDid === event.creatorDid) {
      return NextResponse.json({ error: 'Event creator is already the owner' }, { status: 400 });
    }

    // Add to pod as cohost
    await sql`
      INSERT INTO connections.pod_members (pod_id, did, role, added_by, joined_at)
      VALUES (${event.podId}, ${coHostDid}, 'cohost', ${did}, NOW())
      ON CONFLICT (pod_id, did) DO NOTHING
    `;

    // Also add cohost to event chat as admin
    const CHAT_URL = process.env.CHAT_SERVICE_URL || process.env.CHAT_URL;
    if (CHAT_URL && event.did) {
      try {
        await fetch(`${CHAT_URL}/api/d/${encodeURIComponent(event.did)}/members`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberDid: coHostDid, role: 'admin' }),
        });
        log.info({ coHostDid, eventDid: event.did }, 'Added cohost to event chat');
      } catch (chatError) {
        log.warn({ err: String(chatError) }, 'Cohost chat sync failed (non-fatal)');
      }
    }

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
    log.error({ err: String(error) }, 'Failed to add cohost');
    return NextResponse.json({ error: 'Failed to add cohost' }, { status: 500 });
  }
}
