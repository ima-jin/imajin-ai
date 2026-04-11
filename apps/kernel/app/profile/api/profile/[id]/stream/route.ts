/**
 * POST /api/profile/:did/stream
 *
 * Streaming inference endpoint for the presence query UI.
 * Same auth/trust/tool logic as /query, but returns SSE stream.
 */

import { NextRequest } from 'next/server';
import { db, profiles, queryLogs } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { eq } from 'drizzle-orm';
import { streamText } from 'ai';
import { resolveModel, calculateCost, createPresenceTools } from '@imajin/llm';
import { nanoid } from 'nanoid';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

const CONNECTIONS_URL = process.env.CONNECTIONS_URL!;
const TRUST_INTERNAL_API_KEY = process.env.TRUST_INTERNAL_API_KEY!;
const MEDIA_URL = process.env.MEDIA_SERVICE_URL!;
const MEDIA_INTERNAL_API_KEY = process.env.MEDIA_INTERNAL_API_KEY!;

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: targetDid } = await params;

  // 1. Auth
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return new Response(JSON.stringify({ error: authResult.error }), {
      status: authResult.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const requesterDid = authResult.identity.id;

  // 2. Check target
  const profile = await db.query.profiles.findFirst({
    where: (profiles, { eq, or }) =>
      or(eq(profiles.did, targetDid), eq(profiles.handle, targetDid)),
  });

  if (!profile) {
    return new Response(JSON.stringify({ error: 'Profile not found' }), { status: 404 });
  }
  if (!profile.inferenceEnabled) {
    return new Response(JSON.stringify({ error: 'Inference not enabled' }), { status: 403 });
  }

  const resolvedTargetDid = profile.did;
  const isSelf = requesterDid === resolvedTargetDid;

  // 3. Trust gate
  let trustDistance = 0;
  if (!isSelf) {
    try {
      const trustRes = await fetch(
        `${CONNECTIONS_URL}/api/trust/distance?from=${encodeURIComponent(requesterDid)}&to=${encodeURIComponent(resolvedTargetDid)}`,
        { headers: { Authorization: `Bearer ${TRUST_INTERNAL_API_KEY}` } }
      );
      if (trustRes.ok) {
        const trustData = await trustRes.json();
        if (!trustData.connected) {
          return new Response(JSON.stringify({ error: 'Not connected' }), { status: 403 });
        }
        if (trustData.distance > 2) {
          return new Response(JSON.stringify({ error: 'Too far in trust graph' }), { status: 403 });
        }
        trustDistance = trustData.distance;
      }
    } catch {
      // Allow if trust service is down (permissive for now)
    }
  }

  // 4. Fetch presence
  let presenceData: { config?: Record<string, unknown>; soul?: string; context?: string } = {};
  try {
    const presenceRes = await fetch(
      `${MEDIA_URL}/api/presence/${encodeURIComponent(resolvedTargetDid)}`,
      { headers: { Authorization: `Bearer ${MEDIA_INTERNAL_API_KEY}` } }
    );
    if (presenceRes.ok) {
      presenceData = await presenceRes.json();
    }
  } catch { /* proceed with defaults */ }

  // 5. Resolve model
  const presenceConfig = (presenceData.config ?? {}) as {
    model?: string;
    provider?: string;
    temperature?: number;
  };
  const { model, modelId } = resolveModel(presenceConfig);

  // 6. System prompt
  const soulMd = presenceData.soul ?? '';
  const contextMd = presenceData.context ?? '';
  const bootstrap = '\n\n## Available Tools\nYou have tools to interact with the Imajin platform. When someone asks about essays, documents, or files — use searchAssets to find them, then readAsset to read their content. Do not say you lack access without searching first.\n\nAvailable: searchAssets (find files by name), readAsset (read text file content), getProfile, getEvents, getConnections, getAttestations.';
  const systemPrompt = ([soulMd, contextMd].filter(Boolean).join('\n\n') ||
    `You are the presence of ${profile.displayName}. Answer questions helpfully and authentically.`) + bootstrap;

  // 7. Parse body — convert useChat format to plain messages for streamText
  //    useChat sends messages with toolInvocations[] on assistant messages.
  //    We strip those and only keep user/assistant text for the model context.
  const body = await request.json();
  const rawMessages = body.messages ?? [{ role: 'user', content: body.message ?? '' }];
  const messages = rawMessages
    .filter((msg: any) => {
      // Drop tool result messages entirely
      if (msg.role === 'tool') return false;
      // Drop assistant messages that have no text content (tool-call-only)
      if (msg.role === 'assistant') {
        const text = typeof msg.content === 'string' ? msg.content.trim() : '';
        if (!text) return false;
      }
      return true;
    })
    .map((msg: any) => ({
      role: msg.role as 'user' | 'assistant' | 'system',
      content: typeof msg.content === 'string' ? msg.content : '',
      // Explicitly exclude toolInvocations — streamText will re-invoke tools as needed
    }));

  // 8. Tools
  const tools = createPresenceTools({
    eventsUrl: process.env.EVENTS_SERVICE_URL ?? '',
    connectionsUrl: CONNECTIONS_URL,
    authUrl: '',
    payUrl: process.env.PAY_SERVICE_URL ?? '',
    profileUrl: process.env.NEXT_PUBLIC_PROFILE_URL ?? '',
    learnUrl: process.env.LEARN_SERVICE_URL ?? '',
    mediaUrl: MEDIA_URL,
    mediaApiKey: MEDIA_INTERNAL_API_KEY,
    targetDid: resolvedTargetDid,
    requesterDid,
    trustDistance,
    internalApiKey: TRUST_INTERNAL_API_KEY,
  });

  // 9. Stream with custom SSE that includes tool call metadata
  const queryId = nanoid();
  const result = streamText({
    model,
    system: systemPrompt,
    messages,
    tools,
    maxSteps: 5,
    onStepFinish: ({ stepType, toolCalls, toolResults, text }) => {
      log.info({ stepType, toolCallCount: toolCalls?.length ?? 0, resultLen: JSON.stringify(toolResults ?? []).length, textLen: text?.length ?? 0 }, '[stream] step');
      if (toolCalls?.length) {
        log.info({ toolCalls: JSON.stringify(toolCalls).slice(0, 300) }, '[stream] toolCalls');
      }
      if (toolResults?.length) {
        log.info({ toolResults: JSON.stringify(toolResults).slice(0, 500) }, '[stream] toolResults');
      }
    },
    onFinish: async ({ usage, steps }) => {
      log.info({ stepCount: steps?.length ?? 0 }, '[stream] finished');

      const promptTokens = usage?.promptTokens ?? 0;
      const completionTokens = usage?.completionTokens ?? 0;
      const cost = calculateCost(modelId, promptTokens, completionTokens);

      // Settle (non-fatal)
      let settled = false;
      if (cost > 0 && !isSelf) {
        const payUrl = process.env.PAY_SERVICE_URL;
        const payKey = process.env.PAY_SERVICE_API_KEY;
        const platformDid = process.env.PLATFORM_DID;
        const platformFee = parseFloat(process.env.PLATFORM_FEE_PERCENT ?? '0.2');

        if (payUrl && payKey && platformDid) {
          const platformAmount = +(cost * platformFee).toFixed(6);
          const targetAmount = +(cost - platformAmount).toFixed(6);
          try {
            const settleRes = await fetch(`${payUrl}/api/settle`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${payKey}` },
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
          } catch { /* non-fatal */ }
        }
      }

      // Log
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
      } catch { /* non-fatal */ }
    },
  });

  // Custom stream: newline-delimited JSON events
  // { type: "text", text: "..." } — text chunk to render
  // { type: "tool_call", name: "...", args: {...} } — tool was called
  // { type: "tool_result", name: "...", result: {...} } — tool returned
  // { type: "done" } — stream complete
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta' && part.textDelta) {
            controller.enqueue(encoder.encode(
              JSON.stringify({ type: 'text', text: part.textDelta }) + '\n'
            ));
          } else if (part.type === 'tool-call') {
            controller.enqueue(encoder.encode(
              JSON.stringify({ type: 'tool_call', name: part.toolName, args: part.args }) + '\n'
            ));
          } else if (part.type === 'tool-result') {
            controller.enqueue(encoder.encode(
              JSON.stringify({ type: 'tool_result', name: part.toolName, result: part.result }) + '\n'
            ));
          }
        }
        controller.enqueue(encoder.encode(JSON.stringify({ type: 'done' }) + '\n'));
      } catch (err) {
        log.error({ err: String(err) }, '[stream] error');
        controller.enqueue(encoder.encode(
          JSON.stringify({ type: 'error', message: String(err) }) + '\n'
        ));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    },
  });
}
