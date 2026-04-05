import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, getSessionCookieOptions } from '@/lib/jwt';
import { getClient } from '@imajin/db';
import { corsHeaders } from '@imajin/config';
import { createHash } from 'crypto';

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
    // --- Event DIDs ---
    // Match both did:imajin:event:* (namespace format) and did:imajin:evt_* (actual DB format)
    const isEventDid = targetDid.startsWith('did:imajin:event:') || targetDid.startsWith('did:imajin:evt_');

    // Also check the DB directly for any DID that isn't dm/group — it might be an event
    if (isEventDid || (!targetDid.startsWith('did:imajin:dm:') && !targetDid.startsWith('did:imajin:group:'))) {
      // Try event access: ticket holder check
      const rows = await sql`
        SELECT t.id, t.status, e.id as event_id, e.creator_did
        FROM events.tickets t
        JOIN events.events e ON e.id = t.event_id
        WHERE e.did = ${targetDid}
          AND t.owner_did = ${requesterDid}
          AND t.status NOT IN ('cancelled', 'available')
        LIMIT 1
      `;

      if (rows.length > 0) {
        return NextResponse.json(
          { allowed: true, role: 'attendee', governance: 'ticket' },
          { headers: cors }
        );
      }

      // Check if requester is the event creator (organizer access)
      const orgRows = await sql`
        SELECT id, creator_did
        FROM events.events
        WHERE did = ${targetDid}
          AND creator_did = ${requesterDid}
        LIMIT 1
      `;

      if (orgRows.length > 0) {
        return NextResponse.json(
          { allowed: true, role: 'organizer', governance: 'owner' },
          { headers: cors }
        );
      }

      // If this was explicitly an event DID format, deny access
      if (isEventDid) {
        return NextResponse.json({ allowed: false }, { headers: cors });
      }

      // Otherwise fall through — might be a different DID type
    }

    // --- did:imajin:dm:* and did:imajin:group:* ---
    // DM DIDs are deterministic (derived from sorted member DIDs), so possessing
    // the DID is proof of membership. Group DIDs are random UUIDs, so membership
    // must be verified explicitly via conversation_members or created_by.
    if (targetDid.startsWith('did:imajin:dm:') || targetDid.startsWith('did:imajin:group:')) {
      const governance = targetDid.startsWith('did:imajin:dm:') ? 'dm' : 'group';

      // Fetch conversation (include created_by for group creator check)
      const convRows = await sql`
        SELECT did, created_by FROM chat.conversations_v2
        WHERE did = ${targetDid}
        LIMIT 1
      `;

      // Conversation doesn't exist yet.
      // DMs: deterministic DID is proof of membership — allow so the first message auto-creates.
      // Groups: random UUID DID provides no proof of membership — deny.
      if (convRows.length === 0) {
        if (governance === 'dm') {
          return NextResponse.json(
            { allowed: true, role: 'participant', governance },
            { headers: cors }
          );
        }
        return NextResponse.json({ allowed: false }, { headers: cors });
      }

      // --- Group access: members and creator only ---
      // Check these exclusively — do NOT fall through to read/message history,
      // which would make access self-granting (visiting and sending a message
      // would pass the 'has sent messages' check).
      if (governance === 'group') {
        const memberRows = await sql`
          SELECT role FROM chat.conversation_members
          WHERE conversation_did = ${targetDid}
            AND member_did = ${requesterDid}
            AND left_at IS NULL
          LIMIT 1
        `;

        if (memberRows.length > 0) {
          return NextResponse.json(
            { allowed: true, role: memberRows[0].role as string, governance },
            { headers: cors }
          );
        }

        // Creator always has access
        if (convRows[0].created_by === requesterDid) {
          return NextResponse.json(
            { allowed: true, role: 'owner', governance },
            { headers: cors }
          );
        }

        return NextResponse.json({ allowed: false }, { headers: cors });
      }

      // --- DM access: check participation history ---
      // 1. Check conversation_reads_v2 (marks who has viewed/sent)
      const readRows = await sql`
        SELECT conversation_did
        FROM chat.conversation_reads_v2
        WHERE conversation_did = ${targetDid}
          AND did = ${requesterDid}
        LIMIT 1
      `;

      if (readRows.length > 0) {
        return NextResponse.json(
          { allowed: true, role: 'participant', governance },
          { headers: cors }
        );
      }

      // 2. Check if requester has sent any messages in this conversation
      const msgRows = await sql`
        SELECT id FROM chat.messages_v2
        WHERE conversation_did = ${targetDid}
          AND from_did = ${requesterDid}
        LIMIT 1
      `;

      if (msgRows.length > 0) {
        return NextResponse.json(
          { allowed: true, role: 'participant', governance },
          { headers: cors }
        );
      }

      // 3. Check conversation_members
      const memberRows = await sql`
        SELECT role FROM chat.conversation_members
        WHERE conversation_did = ${targetDid}
          AND member_did = ${requesterDid}
          AND left_at IS NULL
        LIMIT 1
      `;

      if (memberRows.length > 0) {
        return NextResponse.json(
          { allowed: true, role: memberRows[0].role as string, governance },
          { headers: cors }
        );
      }

      // 4. Check pod membership (conversation_did on pods)
      const podRows = await sql`
        SELECT pm.role
        FROM connections.pods p
        JOIN connections.pod_members pm ON pm.pod_id = p.id
        WHERE p.conversation_did = ${targetDid}
          AND pm.did = ${requesterDid}
          AND pm.removed_at IS NULL
        LIMIT 1
      `;

      if (podRows.length > 0) {
        return NextResponse.json(
          { allowed: true, role: podRows[0].role as string, governance },
          { headers: cors }
        );
      }

      return NextResponse.json({ allowed: false }, { headers: cors });
    }

    // --- Fallback: check conversation_members for any DID ---
    // Event DIDs that don't match evt_* or event:* patterns still get conversations
    const fallbackMemberRows = await sql`
      SELECT role FROM chat.conversation_members
      WHERE conversation_did = ${targetDid}
        AND member_did = ${requesterDid}
        AND left_at IS NULL
      LIMIT 1
    `;

    if (fallbackMemberRows.length > 0) {
      return NextResponse.json(
        { allowed: true, role: fallbackMemberRows[0].role as string, governance: 'member' },
        { headers: cors }
      );
    }

    // Check if requester is conversation creator
    const fallbackCreatorRows = await sql`
      SELECT created_by FROM chat.conversations_v2
      WHERE did = ${targetDid}
        AND created_by = ${requesterDid}
      LIMIT 1
    `;

    if (fallbackCreatorRows.length > 0) {
      return NextResponse.json(
        { allowed: true, role: 'owner', governance: 'member' },
        { headers: cors }
      );
    }

    // Unknown DID namespace or no access
    return NextResponse.json(
      { allowed: false },
      { headers: cors }
    );

  } catch (error) {
    console.error('Access check error:', error);
    return NextResponse.json(
      { error: 'Failed to check access' },
      { status: 500, headers: cors }
    );
  }
}
