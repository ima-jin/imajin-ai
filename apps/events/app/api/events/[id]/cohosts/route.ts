import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { db, events } from '@/src/db';
import { requireAuth , resolveActingDid } from '@imajin/auth';

const log = createLogger('events');
import { eq } from 'drizzle-orm';
import { resolveCoHostDid } from '@/src/lib/cohost-helpers';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const CONNECTIONS_SERVICE_URL = process.env.CONNECTIONS_SERVICE_URL || 'http://localhost:3003';

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

interface PodMemberRow {
  podId: string;
  did: string;
  role: string;
  addedBy: string | null;
  joinedAt: string;
  removedAt: string | null;
}

/**
 * Fetch a pod's current (non-removed) members via the kernel connections
 * service's `GET /api/pods/{id}` (#2155) — replaces the raw
 * `connections.pod_members` read this route used to run directly. Forwards
 * the caller's session cookie, since the kernel route requires cookieAuth.
 * Fails soft (empty list) on an unreachable service or non-2xx response,
 * matching this route's existing fail-soft posture for profile lookups.
 */
async function fetchPodMembers(podId: string, cookie: string): Promise<PodMemberRow[]> {
  try {
    const res = await fetch(`${CONNECTIONS_SERVICE_URL}/api/pods/${encodeURIComponent(podId)}`, {
      headers: { cookie },
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const data = await res.json();
    const members = (data.members ?? []) as PodMemberRow[];
    return members.filter((member) => !member.removedAt);
  } catch {
    return [];
  }
}

type AddPodMemberResult = { ok: true; member: PodMemberRow } | { ok: false; status: number; error: string };

/**
 * Add a pod member via the kernel connections service's
 * `POST /api/pods/{id}/members` (#2155) — replaces the raw
 * `INSERT INTO connections.pod_members` this route used to run directly.
 * Forwards the caller's session cookie so the kernel's owner-only chain-
 * verified check applies exactly as before (only the event owner could
 * reach this far in the route already).
 */
async function addPodMember(podId: string, did: string, cookie: string): Promise<AddPodMemberResult> {
  try {
    const res = await fetch(`${CONNECTIONS_SERVICE_URL}/api/pods/${encodeURIComponent(podId)}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ did, role: 'cohost' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: res.status, error: typeof data.error === 'string' ? data.error : 'Failed to add cohost' };
    }
    return { ok: true, member: data.member as PodMemberRow };
  } catch {
    return { ok: false, status: 502, error: 'Failed to reach connections service' };
  }
}

/**
 * GET /api/events/[id]/cohosts — list cohosts for an event
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
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

    const cookie = request.headers.get('cookie') || '';
    const members = (await fetchPodMembers(event.podId, cookie))
      .filter((member) => member.role === 'cohost')
      .sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime());

    const cohosts = await Promise.all(
      members.map(async (member) => {
        const profile = await resolveProfile(member.did);
        return {
          ...profile,
          role: 'cohost',
          addedAt: member.joinedAt,
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

    // Add to pod as cohost. The kernel's addPodMember route is a plain
    // insert with no ON CONFLICT handling, unlike the raw upsert this route
    // used to run — so an already-a-member add is checked for explicitly
    // first to keep the same idempotent "re-adding an existing cohost is a
    // no-op success" behavior instead of surfacing the kernel's insert error.
    const cookie = request.headers.get('cookie') || '';
    const existingMembers = await fetchPodMembers(event.podId, cookie);
    const existingMember = existingMembers.find((member) => member.did === coHostDid);

    let addedAt: string;
    if (existingMember) {
      addedAt = existingMember.joinedAt;
    } else {
      const addResult = await addPodMember(event.podId, coHostDid, cookie);
      if (!addResult.ok) {
        return NextResponse.json({ error: addResult.error }, { status: addResult.status });
      }
      addedAt = addResult.member.joinedAt;
    }

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
      addedAt,
    };

    return NextResponse.json({ cohost }, { status: 201 });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to add cohost');
    return NextResponse.json({ error: 'Failed to add cohost' }, { status: 500 });
  }
}
