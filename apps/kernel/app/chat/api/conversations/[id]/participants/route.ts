import { NextRequest } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/src/lib/kernel/utils';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

async function verifyAccess(did: string, cookieHeader: string | null): Promise<boolean> {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/access/${encodeURIComponent(did)}`, {
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * GET /api/conversations/:id/participants
 * :id is a URL-encoded conversation DID.
 * Returns members by proxying to the auth service access/members endpoint.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { id } = await params;
  const conversationDid = decodeURIComponent(id);

  const hasAccess = await verifyAccess(conversationDid, request.headers.get('Cookie'));
  if (!hasAccess) {
    return errorResponse('Conversation not found or access denied', 404);
  }

  try {
    // Proxy to auth service members endpoint
    const cookieHeader = request.headers.get('Cookie');
    const res = await fetch(
      `${AUTH_SERVICE_URL}/api/access/${encodeURIComponent(conversationDid)}/members`,
      { headers: cookieHeader ? { Cookie: cookieHeader } : {} }
    );

    if (res.ok) {
      const data = await res.json();
      return jsonResponse({ participants: data.members || data });
    }

    // Auth service doesn't support members endpoint — return access granted but no list
    return jsonResponse({ participants: [] });
  } catch (error) {
    console.error('Failed to list participants:', error);
    return errorResponse('Failed to list participants', 500);
  }
}

/**
 * POST /api/conversations/:id/participants - Add a member
 * Delegates to the /api/d/:did/members endpoint pattern.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { id } = await params;
  const conversationDid = decodeURIComponent(id);

  const hasAccess = await verifyAccess(conversationDid, request.headers.get('Cookie'));
  if (!hasAccess) {
    return errorResponse('Access denied', 403);
  }

  try {
    const cookieHeader = request.headers.get('Cookie');
    const body = await request.json();

    const res = await fetch(
      `${AUTH_SERVICE_URL}/api/access/${encodeURIComponent(conversationDid)}/members`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        body: JSON.stringify(body),
      }
    );

    if (res.ok) {
      const data = await res.json();
      return jsonResponse(data, 201);
    }

    return errorResponse('Failed to add participant', res.status);
  } catch (error) {
    console.error('Failed to add participant:', error);
    return errorResponse('Failed to add participant', 500);
  }
}
