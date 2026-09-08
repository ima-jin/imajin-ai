import { getClient } from '@imajin/db';

const sql = getClient();

export interface AccessResult {
  allowed: boolean;
  role?: string;
  governance?: string;
}

// Try event access: ticket holder or organizer. Returns undefined to signal
// "no event-based access found" so the caller can decide whether to fall
// through to other DID-type checks or deny outright.
async function checkEventAccess(requesterDid: string, targetDid: string): Promise<AccessResult | undefined> {
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

  return undefined;
}

async function checkGroupConversationAccess(
  requesterDid: string,
  targetDid: string,
  createdBy: string,
): Promise<AccessResult> {
  const memberRows = await sql`
    SELECT role FROM chat.conversation_members
    WHERE conversation_did = ${targetDid}
      AND member_did = ${requesterDid}
      AND left_at IS NULL
    LIMIT 1
  `;

  if (memberRows.length > 0) {
    return { allowed: true, role: memberRows[0].role as string, governance: 'group' };
  }

  if (createdBy === requesterDid) {
    return { allowed: true, role: 'owner', governance: 'group' };
  }

  return { allowed: false };
}

async function checkDmConversationAccess(requesterDid: string, targetDid: string): Promise<AccessResult> {
  // DM: check participation history
  const readRows = await sql`
    SELECT conversation_did
    FROM chat.conversation_reads_v2
    WHERE conversation_did = ${targetDid}
      AND did = ${requesterDid}
    LIMIT 1
  `;

  if (readRows.length > 0) {
    return { allowed: true, role: 'participant', governance: 'dm' };
  }

  const msgRows = await sql`
    SELECT id FROM chat.messages_v2
    WHERE conversation_did = ${targetDid}
      AND from_did = ${requesterDid}
    LIMIT 1
  `;

  if (msgRows.length > 0) {
    return { allowed: true, role: 'participant', governance: 'dm' };
  }

  const memberRows = await sql`
    SELECT role FROM chat.conversation_members
    WHERE conversation_did = ${targetDid}
      AND member_did = ${requesterDid}
      AND left_at IS NULL
    LIMIT 1
  `;

  if (memberRows.length > 0) {
    return { allowed: true, role: memberRows[0].role as string, governance: 'dm' };
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
    return { allowed: true, role: podRows[0].role as string, governance: 'dm' };
  }

  return { allowed: false };
}

// --- did:imajin:dm:* and did:imajin:group:* ---
async function checkConversationAccess(requesterDid: string, targetDid: string): Promise<AccessResult> {
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
    return checkGroupConversationAccess(requesterDid, targetDid, convRows[0].created_by as string);
  }

  return checkDmConversationAccess(requesterDid, targetDid);
}

// --- Fallback: check conversation_members for any DID ---
async function checkFallbackAccess(requesterDid: string, targetDid: string): Promise<AccessResult> {
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
  const isConversationDid =
    targetDid.startsWith('did:imajin:dm:') || targetDid.startsWith('did:imajin:group:');

  if (isEventDid || !isConversationDid) {
    // Try event access; if this was explicitly an event DID format and no
    // event access was found, deny outright. Otherwise fall through — this
    // might be a different DID type.
    const eventResult = await checkEventAccess(requesterDid, targetDid);
    if (eventResult) return eventResult;
    if (isEventDid) return { allowed: false };
  }

  if (isConversationDid) {
    return checkConversationAccess(requesterDid, targetDid);
  }

  return checkFallbackAccess(requesterDid, targetDid);
}
