import { NextRequest } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, corsHeaders, corsOptions } from '@/lib/utils';

const sql = getClient();
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

/**
 * OPTIONS /api/d/:did/members - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * POST /api/d/:did/members - Add a member to a conversation
 * Body: { memberDid: string, role?: string }
 * 
 * Used by events webhook to sync ticket holders into event chat.
 * Creates conversation if it doesn't exist (for event chats).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  const { did } = await params;

  try {
    const body = await request.json();
    const { memberDid, role = 'member' } = body;

    if (!memberDid) {
      return errorResponse('memberDid is required', 400, cors);
    }

    // Ensure conversation exists (upsert — event chats may not exist yet)
    await sql`
      INSERT INTO chat.conversations_v2 (did, type, name, created_at, updated_at)
      VALUES (${did}, 'group', '', NOW(), NOW())
      ON CONFLICT (did) DO NOTHING
    `;

    // Add member (idempotent)
    await sql`
      INSERT INTO chat.conversation_members (conversation_did, member_did, role, joined_at)
      VALUES (${did}, ${memberDid}, ${role}, NOW())
      ON CONFLICT (conversation_did, member_did) DO NOTHING
    `;

    return jsonResponse({ ok: true, did, memberDid, role }, 200, cors);
  } catch (error) {
    console.error('Failed to add member:', error);
    return errorResponse('Failed to add member', 500, cors);
  }
}

/**
 * GET /api/d/:did/members - Get members of a conversation via pod membership
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status, cors);
  }

  const { did } = await params;

  try {
    // Get members from chat.conversation_members
    const rows = await sql`
      SELECT member_did as did, role
      FROM chat.conversation_members
      WHERE conversation_did = ${did}
        AND left_at IS NULL
      ORDER BY role DESC, joined_at ASC
    `;

    // Resolve names via auth lookup
    const members = await Promise.all(
      rows.map(async (row: Record<string, string>) => {
        try {
          const res = await fetch(
            `${AUTH_SERVICE_URL}/api/lookup/${encodeURIComponent(row.did)}`
          );
          if (res.ok) {
            const data = await res.json();
            const identity = data.identity || data;
            return {
              did: row.did,
              role: row.role,
              name: identity.name || null,
              handle: identity.handle || null,
            };
          }
        } catch {}
        return { did: row.did, role: row.role, name: null, handle: null };
      })
    );

    return jsonResponse({ members, count: members.length }, 200, cors);
  } catch (error) {
    console.error('Failed to get members:', error);
    return errorResponse('Failed to get members', 500, cors);
  }
}
