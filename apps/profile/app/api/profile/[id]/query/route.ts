/**
 * POST /api/profile/:did/query
 *
 * Trust-scoped inference endpoint. Queries a presence profile using
 * the Vercel AI SDK with trust-distance-filtered tools.
 *
 * Body: { message: string, conversationId?: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, profiles, queryLogs } from '@/db';
import { requireAuth } from '@/lib/auth';
import { eq } from 'drizzle-orm';
import { generateText } from 'ai';
import { resolveModel, calculateCost, createPresenceTools } from '@imajin/llm';
import { nanoid } from 'nanoid';

const CONNECTIONS_URL = process.env.CONNECTIONS_URL!;
const TRUST_INTERNAL_API_KEY = process.env.TRUST_INTERNAL_API_KEY!;
const MEDIA_URL = process.env.MEDIA_SERVICE_URL!;
const MEDIA_INTERNAL_API_KEY = process.env.MEDIA_INTERNAL_API_KEY!;

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: targetDid } = await params;

  // 1. Auth: get requester DID
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const requesterDid = authResult.identity.id;

  // 2. Look up target profile, check inference_enabled
  const profile = await db.query.profiles.findFirst({
    where: (profiles, { eq, or }) =>
      or(eq(profiles.did, targetDid), eq(profiles.handle, targetDid)),
  });

  if (!profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
  }

  if (!profile.inferenceEnabled) {
    return NextResponse.json({ error: 'Inference not enabled for this profile' }, { status: 403 });
  }

  const resolvedTargetDid = profile.did;
  const isSelf = requesterDid === resolvedTargetDid;

  // 3. Check trust distance (skip for self-query)
  let trustDistance = 0;
  if (!isSelf) {
    const trustRes = await fetch(
      `${CONNECTIONS_URL}/api/trust/distance?from=${encodeURIComponent(requesterDid)}&to=${encodeURIComponent(resolvedTargetDid)}`,
      { headers: { Authorization: `Bearer ${TRUST_INTERNAL_API_KEY}` } }
    );

    if (!trustRes.ok) {
      return NextResponse.json({ error: 'Failed to check trust distance' }, { status: 502 });
    }

    const trustData = await trustRes.json();
    if (!trustData.connected) {
      return NextResponse.json({ error: 'Not connected to this profile' }, { status: 403 });
    }
    if (trustData.distance > 2) {
      return NextResponse.json({ error: 'Too far in trust graph to query this profile' }, { status: 403 });
    }
    trustDistance = trustData.distance;
  }

  // 4. Fetch presence data from media service
  let presenceData: { config?: Record<string, unknown>; soul?: string; context?: string } = {};
  try {
    const presenceRes = await fetch(
      `${MEDIA_URL}/api/presence/${encodeURIComponent(resolvedTargetDid)}`,
      { headers: { Authorization: `Bearer ${MEDIA_INTERNAL_API_KEY}` } }
    );
    if (presenceRes.ok) {
      presenceData = await presenceRes.json();
    }
  } catch {
    // Non-fatal: proceed with defaults
  }

  // 5. Resolve model from presence config
  const presenceConfig = (presenceData.config ?? {}) as {
    model?: string;
    provider?: string;
    temperature?: number;
  };
  const { model, modelId } = resolveModel(presenceConfig);

  // 6. Build system prompt from soul.md + context.md
  const soulMd = presenceData.soul ?? '';
  const contextMd = presenceData.context ?? '';
  const systemPrompt = [soulMd, contextMd].filter(Boolean).join('\n\n') ||
    `You are the presence of ${profile.displayName}. Answer questions helpfully and authentically.`;

  // 7. Parse request body
  let body: { message: string; conversationId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.message || typeof body.message !== 'string') {
    return NextResponse.json({ error: 'message required' }, { status: 400 });
  }

  // 8. Create trust-scoped tools
  const tools = createPresenceTools({
    eventsUrl: process.env.EVENTS_SERVICE_URL ?? '',
    connectionsUrl: CONNECTIONS_URL,
    authUrl: process.env.AUTH_SERVICE_URL ?? '',
    payUrl: process.env.PAY_SERVICE_URL ?? '',
    profileUrl: process.env.NEXT_PUBLIC_PROFILE_URL ?? '',
    learnUrl: process.env.LEARN_SERVICE_URL ?? '',
    targetDid: resolvedTargetDid,
    requesterDid,
    trustDistance,
    internalApiKey: TRUST_INTERNAL_API_KEY,
  });

  // 9. Generate response
  let result;
  try {
    result = await generateText({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: body.message }],
      tools,
    });
  } catch (err) {
    console.error('generateText failed:', err);
    return NextResponse.json({ error: 'Inference failed' }, { status: 500 });
  }

  const promptTokens = result.usage?.promptTokens ?? 0;
  const completionTokens = result.usage?.completionTokens ?? 0;

  // 10. Calculate cost
  const cost = calculateCost(modelId, promptTokens, completionTokens);

  // 11. Settle cost via pay (non-fatal)
  const queryId = nanoid();
  let settled = false;
  if (cost > 0 && !isSelf) {
    const payUrl = process.env.PAY_SERVICE_URL;
    const payKey = process.env.PAY_SERVICE_API_KEY;
    const platformDid = process.env.PLATFORM_DID;
    const platformFee = parseFloat(process.env.PLATFORM_FEE_PERCENT ?? '0.2'); // 20% default

    if (payUrl && payKey && platformDid) {
      const platformAmount = +(cost * platformFee).toFixed(6);
      const targetAmount = +(cost - platformAmount).toFixed(6);

      try {
        const settleRes = await fetch(`${payUrl}/api/settle`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${payKey}`,
          },
          body: JSON.stringify({
            from_did: requesterDid,
            total_amount: cost,
            service: 'inference',
            type: 'query',
            fair_manifest: {
              chain: [
                { did: resolvedTargetDid, amount: targetAmount, role: 'presence-owner' },
                { did: platformDid, amount: platformAmount, role: 'infrastructure' },
              ],
            },
            metadata: { queryId, model: modelId, promptTokens, completionTokens },
          }),
        });
        settled = settleRes.ok;
        if (!settled) {
          console.error('[Query] Settlement failed:', await settleRes.text().catch(() => ''));
        }
      } catch (err) {
        console.error('[Query] Settlement error (non-fatal):', err);
      }
    }
  }

  // 12. Log to query_logs
  try {
    await db.insert(queryLogs).values({
      id: queryId,
      requesterDid,
      targetDid: resolvedTargetDid,
      model: modelId,
      promptTokens,
      completionTokens,
      costUsd: cost.toFixed(6),
      settled,
    });
  } catch (err) {
    console.error('Failed to log query:', err);
  }

  // 13. Return response
  return NextResponse.json({
    response: result.text,
    usage: {
      promptTokens,
      completionTokens,
      cost,
      settled,
    },
    model: modelId,
  });
}
