import { NextRequest } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse, generateId } from '@/src/lib/kernel/utils';
import { corsOptions, corsHeaders } from "@/src/lib/kernel/cors";
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

const sql = getClient();

/**
 * POST /chat/api/d/[did]/replay
 * Replay attestation chain into chat timeline — backfill missing system messages.
 * Admin or group owner only.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  try {
    const session = await requireAuth(request);
    if (!session) return errorResponse('Unauthorized', 401, cors);

    const { did } = await params;
    const effectiveDid = session.actingAs || session.id;

    // Check if user is owner/admin of this conversation
    const [membership] = await sql`
      SELECT role FROM chat.conversation_members
      WHERE conversation_did = ${did} AND member_did = ${effectiveDid} AND left_at IS NULL
    `;
    if (!membership || !['owner', 'admin'].includes(membership.role as string)) {
      return errorResponse('Only group owner or admin can replay chain', 403, cors);
    }

    // Attestation event types that map to system messages
    const eventMap: Record<string, string> = {
      'group.member.added': 'member_added',
      'group.member.removed': 'member_removed',
      'group.member.left': 'member_left',
    };
    const attestationTypes = Object.keys(eventMap);

    // Fetch all relevant attestations for this conversation
    const attestations = await sql`
      SELECT id, issuer_did, subject_did, type, issued_at, payload
      FROM auth.attestations
      WHERE context_id = ${did}
        AND context_type = 'chat.group'
        AND type = ANY(${attestationTypes})
        AND revoked_at IS NULL
      ORDER BY issued_at ASC
    `;

    // Fetch all existing system messages for this conversation
    const existingMessages = await sql`
      SELECT id, content, created_at
      FROM chat.messages_v2
      WHERE conversation_did = ${did}
        AND content_type = 'application/json'
        AND content->>'type' = 'system'
      ORDER BY created_at ASC
    `;

    // Index existing messages by a composite key for matching
    const existingSet = new Set(
      existingMessages.map((m: any) => {
        const c = typeof m.content === 'string' ? JSON.parse(m.content) : m.content;
        // Match on event + actorDid + targetDid (timestamp can drift slightly)
        return `${c.event}:${c.actorDid}:${c.targetDid || ''}`;
      })
    );

    const now = new Date().toISOString();
    let backfilled = 0;
    let alreadyExists = 0;
    const backfilledEntries: Array<{ attestationId: string; event: string; occurredAt: string }> = [];

    for (const att of attestations) {
      const event = eventMap[att.type as string];
      if (!event) continue;

      const actorDid = att.issuer_did as string;
      const targetDid = att.subject_did as string;
      const key = `${event}:${actorDid}:${targetDid}`;

      if (existingSet.has(key)) {
        alreadyExists++;
        continue;
      }

      // Insert backfilled system message
      const msgId = generateId('msg');
      const content = JSON.stringify({
        type: 'system',
        event,
        actorDid,
        targetDid: event === 'member_left' ? undefined : targetDid,
        occurredAt: (att.issued_at as Date).toISOString(),
        recordedAt: now,
        attestationId: att.id,
      });

      await sql`
        INSERT INTO chat.messages_v2 (id, conversation_did, from_did, content, content_type, created_at)
        VALUES (${msgId}, ${did}, ${actorDid}, ${content}::jsonb, 'application/json', ${att.issued_at})
      `;

      backfilled++;
      backfilledEntries.push({
        attestationId: att.id as string,
        event,
        occurredAt: (att.issued_at as Date).toISOString(),
      });

      // Add to set so we don't duplicate within this run
      existingSet.add(key);
    }

    // Validation: find orphaned system messages (no matching attestation)
    const attestationKeys = new Set(
      attestations.map((a: any) => {
        const event = eventMap[a.type as string];
        return `${event}:${a.issuer_did}:${a.subject_did}`;
      })
    );

    const orphanedMessages = existingMessages.filter((m: any) => {
      const c = typeof m.content === 'string' ? JSON.parse(m.content) : m.content;
      const key = `${c.event}:${c.actorDid}:${c.targetDid || ''}`;
      return !attestationKeys.has(key);
    });

    const result = {
      conversationDid: did,
      attestationsFound: attestations.length,
      systemMessagesExisting: existingMessages.length,
      backfilled,
      alreadyMatched: alreadyExists,
      orphanedMessages: orphanedMessages.length,
      backfilledEntries,
      ...(orphanedMessages.length > 0 && {
        orphanedDetails: orphanedMessages.map((m: any) => ({
          messageId: m.id,
          content: typeof m.content === 'string' ? JSON.parse(m.content) : m.content,
          createdAt: m.created_at,
        })),
      }),
    };

    log.info({ did, backfilled, orphaned: orphanedMessages.length }, 'Chain replay completed');

    return jsonResponse(result, 200, cors);
  } catch (err) {
    log.error({ err: String(err) }, 'Chain replay error');
    return errorResponse('Internal server error', 500, cors);
  }
}

/**
 * OPTIONS — CORS preflight
 */
export function OPTIONS(request: NextRequest) {
  return new Response(null, { status: 204, headers: corsOptions(request) });
}
