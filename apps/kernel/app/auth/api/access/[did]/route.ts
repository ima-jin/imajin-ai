import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { getClient } from '@imajin/db';
import { corsHeaders } from '@imajin/config';
import { createHash } from 'node:crypto';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

const sql = getClient();

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/access/[did]
 * Checks whether the authenticated requester has access to the resource identified by the given DID.
 *
 * Supported DID namespaces:
 *   did:imajin:event:*  → ticket holder check via events schema
 *   did:imajin:dm:*     → party check (re-derive hash to confirm membership)
 *   did:imajin:group:*  → participant check via chat schema
 *
 * Returns: { allowed: boolean, role?: string, governance?: string }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);

  // --- Auth ---
  const cookieConfig = getSessionCookieOptions();
  const token = request.cookies.get(cookieConfig.name)?.value;
  if (!token) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: cors });
  }

  const session = await verifySessionToken(token);
  if (!session) {
    return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401, headers: cors });
  }

  const requesterDid = session.sub;
  const { did } = await params;
  const targetDid = decodeURIComponent(did);

  try {
    const isEventDid = targetDid.startsWith('did:imajin:event:') || targetDid.startsWith('did:imajin:evt_');
    const isChatDid = targetDid.startsWith('did:imajin:dm:') || targetDid.startsWith('did:imajin:group:');

    if (isEventDid || !isChatDid) {
      const result = await checkEventAccess(targetDid, requesterDid, cors);
      if (result) return result;
    }

    if (isChatDid) {
      return checkChatAccess(targetDid, requesterDid, cors);
    }

    return checkFallbackAccess(targetDid, requesterDid, cors);

  } catch (error) {
    log.error({ err: String(error) }, 'Access check error');
    return NextResponse.json({ error: 'Failed to check access' }, { status: 500, headers: cors });
  }
}

/** Check ticket-holder and organizer access for event DIDs. Returns null to fall through. */
async function checkEventAccess(
  targetDid: string,
  requesterDid: string,
  cors: HeadersInit,
): Promise<NextResponse | null> {
  const isEventDid = targetDid.startsWith('did:imajin:event:') || targetDid.startsWith('did:imajin:evt_');

  const rows = await sql`
    SELECT t.id FROM events.tickets t
    JOIN events.events e ON e.id = t.event_id
    WHERE e.did = ${targetDid} AND t.owner_did = ${requesterDid}
      AND t.status NOT IN ('cancelled', 'available')
    LIMIT 1
  `;
  if (rows.length > 0) {
    return NextResponse.json({ allowed: true, role: 'attendee', governance: 'ticket' }, { headers: cors });
  }

  const orgRows = await sql`
    SELECT id FROM events.events WHERE did = ${targetDid} AND creator_did = ${requesterDid} LIMIT 1
  `;
  if (orgRows.length > 0) {
    return NextResponse.json({ allowed: true, role: 'organizer', governance: 'owner' }, { headers: cors });
  }

  if (isEventDid) {
    return NextResponse.json({ allowed: false }, { headers: cors });
  }
  return null; // fall through to chat/fallback check
}

/** Check DM and group conversation access. */
async function checkChatAccess(
  targetDid: string,
  requesterDid: string,
  cors: HeadersInit,
): Promise<NextResponse> {
  const governance = targetDid.startsWith('did:imajin:dm:') ? 'dm' : 'group';

  const convRows = await sql`
    SELECT did, created_by FROM chat.conversations_v2 WHERE did = ${targetDid} LIMIT 1
  `;

  if (convRows.length === 0) {
    const allowed = governance === 'dm';
    return NextResponse.json(
      allowed ? { allowed: true, role: 'participant', governance } : { allowed: false },
      { headers: cors },
    );
  }

  if (governance === 'group') {
    return checkGroupAccess(targetDid, requesterDid, governance, convRows[0].created_by as string, cors);
  }

  return checkDmAccess(targetDid, requesterDid, governance, cors);
}

async function checkGroupAccess(
  targetDid: string,
  requesterDid: string,
  governance: string,
  createdBy: string,
  cors: HeadersInit,
): Promise<NextResponse> {
  const memberRows = await sql`
    SELECT role FROM chat.conversation_members
    WHERE conversation_did = ${targetDid} AND member_did = ${requesterDid} AND left_at IS NULL LIMIT 1
  `;
  if (memberRows.length > 0) {
    return NextResponse.json({ allowed: true, role: memberRows[0].role as string, governance }, { headers: cors });
  }
  if (createdBy === requesterDid) {
    return NextResponse.json({ allowed: true, role: 'owner', governance }, { headers: cors });
  }
  return NextResponse.json({ allowed: false }, { headers: cors });
}

async function checkDmAccess(
  targetDid: string,
  requesterDid: string,
  governance: string,
  cors: HeadersInit,
): Promise<NextResponse> {
  const readRows = await sql`
    SELECT conversation_did FROM chat.conversation_reads_v2
    WHERE conversation_did = ${targetDid} AND did = ${requesterDid} LIMIT 1
  `;
  if (readRows.length > 0) return NextResponse.json({ allowed: true, role: 'participant', governance }, { headers: cors });

  const msgRows = await sql`
    SELECT id FROM chat.messages_v2 WHERE conversation_did = ${targetDid} AND from_did = ${requesterDid} LIMIT 1
  `;
  if (msgRows.length > 0) return NextResponse.json({ allowed: true, role: 'participant', governance }, { headers: cors });

  const memberRows = await sql`
    SELECT role FROM chat.conversation_members
    WHERE conversation_did = ${targetDid} AND member_did = ${requesterDid} AND left_at IS NULL LIMIT 1
  `;
  if (memberRows.length > 0) return NextResponse.json({ allowed: true, role: memberRows[0].role as string, governance }, { headers: cors });

  const podRows = await sql`
    SELECT pm.role FROM connections.pods p
    JOIN connections.pod_members pm ON pm.pod_id = p.id
    WHERE p.conversation_did = ${targetDid} AND pm.did = ${requesterDid} AND pm.removed_at IS NULL LIMIT 1
  `;
  if (podRows.length > 0) return NextResponse.json({ allowed: true, role: podRows[0].role as string, governance }, { headers: cors });

  return NextResponse.json({ allowed: false }, { headers: cors });
}

/** Fallback: check conversation_members for any unrecognised DID. */
async function checkFallbackAccess(
  targetDid: string,
  requesterDid: string,
  cors: HeadersInit,
): Promise<NextResponse> {
  const memberRows = await sql`
    SELECT role FROM chat.conversation_members
    WHERE conversation_did = ${targetDid} AND member_did = ${requesterDid} AND left_at IS NULL LIMIT 1
  `;
  if (memberRows.length > 0) {
    return NextResponse.json({ allowed: true, role: memberRows[0].role as string, governance: 'member' }, { headers: cors });
  }

  const creatorRows = await sql`
    SELECT created_by FROM chat.conversations_v2
    WHERE did = ${targetDid} AND created_by = ${requesterDid} LIMIT 1
  `;
  if (creatorRows.length > 0) {
    return NextResponse.json({ allowed: true, role: 'owner', governance: 'member' }, { headers: cors });
  }

  return NextResponse.json({ allowed: false }, { headers: cors });
}
