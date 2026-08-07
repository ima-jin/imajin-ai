import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');
import { requireAuth, resolveEffectiveDid } from '@imajin/auth';
import type { EffectiveDidResult, Identity } from '@imajin/auth';
import { lookupIdentity } from '@/src/lib/kernel/lookup';
import { jsonResponse, errorResponse } from '@/src/lib/kernel/utils';
import { readConversationMessages, sendConversationMessage } from '@/src/lib/chat/queries';

/**
 * GET /api/conversations/:id/messages
 * :id is a URL-encoded conversation DID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await resolveEffectiveDid(request, { scope: 'messages:read' });
  if (!auth.ok) {
    return errorResponse(auth.error, auth.status);
  }
  const requesterDid = auth.effectiveDid;

  const { id } = await params;
  const conversationDid = decodeURIComponent(id);

  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get('limit') || '50');
  const before = url.searchParams.get('before');

  try {
    const result = await readConversationMessages(requesterDid, conversationDid, limit, before);
    if (!result.ok) {
      return errorResponse(result.error, result.status);
    }
    return jsonResponse({
      messages: result.messages,
      hasMore: result.hasMore,
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to get messages');
    return errorResponse('Failed to get messages', 500);
  }
}

/**
 * POST /api/conversations/:id/messages - Send a message
 */
type SenderIdentity = { id: string; tier?: Identity['tier']; handle?: string | null };

/**
 * Hydrate the full sender identity (tier/handle) from a resolved auth result.
 * App path looks the DID up; session path reuses the authenticated identity.
 * Mirrors the resolveEffectiveDid result shape so callers branch once.
 */
async function hydrateSenderIdentity(
  request: NextRequest,
  auth: Extract<EffectiveDidResult, { ok: true }>,
): Promise<
  | { ok: true; identity: SenderIdentity }
  | { ok: false; status: number; error: string }
> {
  if (auth.via === 'app') {
    const lookedUp = await lookupIdentity(auth.effectiveDid);
    return {
      ok: true,
      identity: {
        id: auth.effectiveDid,
        tier: (lookedUp?.tier as Identity['tier']) ?? 'preliminary',
        handle: lookedUp?.handle ?? null,
      },
    };
  }

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return { ok: false, status: authResult.status, error: authResult.error };
  }
  return { ok: true, identity: authResult.identity };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await resolveEffectiveDid(request, { scope: 'messages:write' });
  if (!auth.ok) {
    return errorResponse(auth.error, auth.status);
  }
  const effectiveDid = auth.effectiveDid;

  const hydrated = await hydrateSenderIdentity(request, auth);
  if (!hydrated.ok) {
    return errorResponse(hydrated.error, hydrated.status);
  }
  const identity = hydrated.identity;

  const { id } = await params;
  const conversationDid = decodeURIComponent(id);

  try {
    const body = await request.json();
    const { content, contentType, replyToMessageId, mediaType, mediaPath, mediaAssetId, mediaMeta, conversationName, recipientDid } = body;

    const result = await sendConversationMessage({
      senderDid: effectiveDid,
      senderTier: identity.tier,
      senderHandle: identity.handle,
      // Dual attribution (#1673): non-null only when an agent composed this
      // under X-Acting-For delegation.
      composedBy: auth.composedBy,
      conversationDid,
      content,
      contentType,
      replyToMessageId,
      mediaType,
      mediaPath,
      mediaAssetId,
      mediaMeta,
      conversationName,
      recipientDid,
    });

    if (!result.ok) {
      // Preserve the structured capability-denied response shape.
      if (result.code) {
        return Response.json(
          { error: result.error, code: result.code, required: result.required },
          { status: result.status },
        );
      }
      return errorResponse(result.error, result.status);
    }

    return jsonResponse({ message: result.message }, 201);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to send message');
    return errorResponse('Failed to send message', 500);
  }
}
