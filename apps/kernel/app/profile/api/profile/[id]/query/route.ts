/**
 * POST /api/profile/:did/query
 *
 * Trust-scoped inference endpoint. Queries a presence profile using
 * the Vercel AI SDK with trust-distance-filtered tools.
 *
 * Body: { message: string, conversationId?: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, queryLogs } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { generateText } from 'ai';
import { calculateCost, createPresenceTools } from '@imajin/llm';
import { resolvePresenceBrain } from '@/src/lib/inference/presence-brain';
import { recordPresenceQueryUsage } from '@/src/lib/inference/presence-query-usage';
import { nanoid } from 'nanoid';
import { createLogger } from '@imajin/logger';
import { buildPublicUrl } from '@imajin/config';
import { checkTrustDistance, fetchPresenceData, resolveQueryProfile, settleQueryCost } from '@/src/lib/profile/presence-query';

const log = createLogger('kernel');

const CONNECTIONS_URL = process.env.CONNECTIONS_URL!;
const TRUST_INTERNAL_API_KEY = process.env.TRUST_INTERNAL_API_KEY!;

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
  const profileResult = await resolveQueryProfile(targetDid);
  if (!profileResult.ok) {
    return NextResponse.json({ error: profileResult.error }, { status: profileResult.status });
  }
  const { profile } = profileResult;
  const resolvedTargetDid = profile.did;
  const isSelf = requesterDid === resolvedTargetDid;

  // 3. Check trust distance (skip for self-query)
  const trustResult = await checkTrustDistance(requesterDid, resolvedTargetDid, isSelf, {
    strict: true,
    messages: { notConnected: 'Not connected to this profile', tooFar: 'Too far in trust graph to query this profile' },
  });
  if (!trustResult.ok) {
    return NextResponse.json({ error: trustResult.error }, { status: trustResult.status });
  }
  const { trustDistance } = trustResult;

  // 4. Fetch presence data from media service
  const presenceData = await fetchPresenceData(resolvedTargetDid);

  // 5. Resolve the model from the PRESENCE OWNER's sealed connector card (#1621).
  //    The presence speaks on their behalf, so it runs on their brain and their
  //    credential. This supersedes any `model`/`provider` in the presence config:
  //    the per-DID sealed modelId is the owner's model choice, and the kernel
  //    holds no env key to fall back on.
  const brain = await resolvePresenceBrain(resolvedTargetDid);
  if (!brain.ok) {
    log.warn({ targetDid: resolvedTargetDid, cause: brain.cause }, 'presence brain unavailable');
    return NextResponse.json({ error: brain.error }, { status: brain.status });
  }
  const { model, modelId, connector } = brain;

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
    authUrl: '',
    payUrl: process.env.PAY_SERVICE_URL ?? '',
    profileUrl: buildPublicUrl('profile'),
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
    log.error({ err: String(err) }, 'generateText failed');
    return NextResponse.json({ error: 'Inference failed' }, { status: 500 });
  }

  const promptTokens = result.usage?.promptTokens ?? 0;
  const completionTokens = result.usage?.completionTokens ?? 0;

  // 10. Calculate cost
  const cost = calculateCost(modelId, promptTokens, completionTokens);

  // 11. Settle cost via pay (non-fatal)
  const queryId = nanoid();
  const settled = await settleQueryCost({
    cost, isSelf, requesterDid, resolvedTargetDid, queryId, modelId, promptTokens, completionTokens,
    log, logFailureMessage: '[Query] Settlement failed', logErrorMessage: '[Query] Settlement error (non-fatal)',
  });

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
    log.error({ err: String(err) }, 'Failed to log query');
  }

  // 12b. Emit usage.incurred (#1956) — joins the metering ledger the
  // completions passthrough already writes to. Fire-and-forget / fail-open
  // (recordPresenceQueryUsage never throws): a ledger hiccup must never
  // change the response already computed above.
  recordPresenceQueryUsage({
    queryId, mode: 'query', actingForDid: resolvedTargetDid, requesterDid,
    provider: connector, modelId, promptTokens, completionTokens, costUsd: cost, settled,
  }).catch(() => {});

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
