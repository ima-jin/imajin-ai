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
  { params }: { params: { did: string } }
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
  const targetDid = decodeURIComponent(params.did);

  try {
    // --- did:imajin:event:* ---
    if (targetDid.startsWith('did:imajin:event:')) {
      const eventSlug = targetDid.slice('did:imajin:event:'.length);

      const rows = await sql`
        SELECT t.id, t.status, e.id as event_id, e.created_by
        FROM events.tickets t
        JOIN events.events e ON e.id = t.event_id
        WHERE (e.id = ${eventSlug} OR e.did = ${targetDid})
          AND t.attendee_did = ${requesterDid}
          AND t.status NOT IN ('cancelled', 'refunded')
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
        SELECT id, created_by
        FROM events.events
        WHERE (id = ${eventSlug} OR did = ${targetDid})
          AND created_by = ${requesterDid}
        LIMIT 1
      `;

      if (orgRows.length > 0) {
        return NextResponse.json(
          { allowed: true, role: 'organizer', governance: 'owner' },
          { headers: cors }
        );
      }

      return NextResponse.json({ allowed: false }, { headers: cors });
    }

    // --- did:imajin:dm:* ---
    if (targetDid.startsWith('did:imajin:dm:')) {
      const targetHash = targetDid.slice('did:imajin:dm:'.length);

      // Re-derive: requester must be one of the two parties.
      // We look up the conversation and check participants.
      // Since the hash is derived from sorted DIDs, we can verify by checking
      // the chat schema for participants of this conversation.
      const rows = await sql`
        SELECT conversation_did
        FROM chat.conversation_reads_v2
        WHERE conversation_did = ${targetDid}
          AND did = ${requesterDid}
        LIMIT 1
      `;

      if (rows.length > 0) {
        return NextResponse.json(
          { allowed: true, role: 'participant', governance: 'dm' },
          { headers: cors }
        );
      }

      // Fall back: check legacy participants table by re-deriving hash with known counterpart
      // This handles the case where the conversation exists but reads haven't been written yet.
      // We check if any two-party combo including requesterDid yields the target hash.
      const participantRows = await sql`
        SELECT p.did
        FROM chat.participants p
        JOIN chat.conversations c ON c.id = p.conversation_id
        WHERE c.type = 'direct'
          AND p.conversation_id IN (
            SELECT conversation_id FROM chat.participants WHERE did = ${requesterDid}
          )
      `;

      for (const row of participantRows) {
        if (row.did !== requesterDid) {
          const sorted = [requesterDid, row.did].sort();
          const derived = sha256hex(sorted.join(':')).slice(0, 16);
          if (derived === targetHash) {
            return NextResponse.json(
              { allowed: true, role: 'participant', governance: 'dm' },
              { headers: cors }
            );
          }
        }
      }

      return NextResponse.json({ allowed: false }, { headers: cors });
    }

    // --- did:imajin:group:* ---
    if (targetDid.startsWith('did:imajin:group:')) {
      // Check v2 reads table first
      const readsRows = await sql`
        SELECT conversation_did
        FROM chat.conversation_reads_v2
        WHERE conversation_did = ${targetDid}
          AND did = ${requesterDid}
        LIMIT 1
      `;

      if (readsRows.length > 0) {
        return NextResponse.json(
          { allowed: true, role: 'member', governance: 'group' },
          { headers: cors }
        );
      }

      // Check conversations_v2 — if requester is creator
      const convRows = await sql`
        SELECT did, created_by
        FROM chat.conversations_v2
        WHERE did = ${targetDid}
          AND created_by = ${requesterDid}
        LIMIT 1
      `;

      if (convRows.length > 0) {
        return NextResponse.json(
          { allowed: true, role: 'owner', governance: 'group' },
          { headers: cors }
        );
      }

      return NextResponse.json({ allowed: false }, { headers: cors });
    }

    // Unknown DID namespace
    return NextResponse.json(
      { error: 'Unsupported DID namespace' },
      { status: 400, headers: cors }
    );

  } catch (error) {
    console.error('Access check error:', error);
    return NextResponse.json(
      { error: 'Failed to check access' },
      { status: 500, headers: cors }
    );
  }
}
