import { getClient } from '@imajin/db';

const sql = getClient();

export interface AccessResult {
  allowed: boolean;
  role?: string;
  governance?: string;
}

/**
 * Check whether requesterDid has access to the resource identified by targetDid.
 * Mirrors the logic from app/auth/api/access/[did]/route.ts GET handler.
 *
 * Supported DID namespaces:
 *   did:imajin:event:*  → ticket holder check via events schema
 *   did:imajin:dm:*     → party check (re-derive hash to confirm membership)
 *   did:imajin:group:*  → participant check via chat schema
 */
export async function checkAccess(requesterDid: string, targetDid: string): Promise<AccessResult> {
  // --- Event DIDs ---
  const isEventDid =
    targetDid.startsWith('did:imajin:event:') || targetDid.startsWith('did:imajin:evt_');

  if (
    isEventDid ||
    (!targetDid.startsWith('did:imajin:dm:') && !targetDid.startsWith('did:imajin:group:'))
  ) {
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
      return { allowed: true, role: 'attendee', governance: 'ticket' };
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
      return { allowed: true, role: 'organizer', governance: 'owner' };
    }

    // If this was explicitly an event DID format, deny access
    if (isEventDid) {
      return { allowed: false };
    }

    // Otherwise fall through — might be a different DID type
  }

  // --- did:imajin:dm:* and did:imajin:group:* ---
  if (targetDid.startsWith('did:imajin:dm:') || targetDid.startsWith('did:imajin:group:')) {
    const governance = targetDid.startsWith('did:imajin:dm:') ? 'dm' : 'group';

    const convRows = await sql`
      SELECT did, created_by FROM chat.conversations_v2
      WHERE did = ${targetDid}
      LIMIT 1
    `;

    if (convRows.length === 0) {
      if (governance === 'dm') {
        return { allowed: true, role: 'participant', governance };
      }
      return { allowed: false };
    }

    if (governance === 'group') {
      const memberRows = await sql`
        SELECT role FROM chat.conversation_members
        WHERE conversation_did = ${targetDid}
          AND member_did = ${requesterDid}
          AND left_at IS NULL
        LIMIT 1
      `;

      if (memberRows.length > 0) {
        return { allowed: true, role: memberRows[0].role as string, governance };
      }

      if (convRows[0].created_by === requesterDid) {
        return { allowed: true, role: 'owner', governance };
      }

      return { allowed: false };
    }

    // DM: check participation history
    const readRows = await sql`
      SELECT conversation_did
      FROM chat.conversation_reads_v2
      WHERE conversation_did = ${targetDid}
        AND did = ${requesterDid}
      LIMIT 1
    `;

    if (readRows.length > 0) {
      return { allowed: true, role: 'participant', governance };
    }

    const msgRows = await sql`
      SELECT id FROM chat.messages_v2
      WHERE conversation_did = ${targetDid}
        AND from_did = ${requesterDid}
      LIMIT 1
    `;

    if (msgRows.length > 0) {
      return { allowed: true, role: 'participant', governance };
    }

    const memberRows = await sql`
      SELECT role FROM chat.conversation_members
      WHERE conversation_did = ${targetDid}
        AND member_did = ${requesterDid}
        AND left_at IS NULL
      LIMIT 1
    `;

    if (memberRows.length > 0) {
      return { allowed: true, role: memberRows[0].role as string, governance };
    }

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
      return { allowed: true, role: podRows[0].role as string, governance };
    }

    return { allowed: false };
  }

  // --- Fallback: check conversation_members for any DID ---
  const fallbackMemberRows = await sql`
    SELECT role FROM chat.conversation_members
    WHERE conversation_did = ${targetDid}
      AND member_did = ${requesterDid}
      AND left_at IS NULL
    LIMIT 1
  `;

  if (fallbackMemberRows.length > 0) {
    return { allowed: true, role: fallbackMemberRows[0].role as string, governance: 'member' };
  }

  const fallbackCreatorRows = await sql`
    SELECT created_by FROM chat.conversations_v2
    WHERE did = ${targetDid}
      AND created_by = ${requesterDid}
    LIMIT 1
  `;

  if (fallbackCreatorRows.length > 0) {
    return { allowed: true, role: 'owner', governance: 'member' };
  }

  return { allowed: false };
}
