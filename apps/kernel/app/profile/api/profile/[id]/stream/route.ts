/**
 * POST /api/profile/:did/stream
 *
 * Streaming inference endpoint for the presence query UI.
 * Same auth/trust/tool logic as /query, but returns SSE stream.
 */

import { NextRequest } from 'next/server';
import { db, queryLogs } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { streamText } from 'ai';
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
const MEDIA_URL = process.env.MEDIA_SERVICE_URL!;
const MEDIA_INTERNAL_API_KEY = process.env.MEDIA_INTERNAL_API_KEY!;

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Generate the Available Tools section of the system prompt from registered tools.
 * Replaces the old hardcoded list so the bootstrap stays in sync when tools are added or removed. */
function buildToolBootstrap(tools: Record<string, { description?: string }>): string {
  const toolLines = Object.entries(tools)
    .map(([name, t]) => `- **${name}**: ${t.description ?? ''}`.trimEnd())
    .join('\n');
  return (
    `\n\n## Available Tools\n` +
    `You have tools to interact with the Imajin platform. ` +
    `Do not say you lack access without trying the relevant tool first.\n\n${ 
    toolLines}`
  );
}

/** Convert useChat-format messages (which may carry tool invocations) to plain user/assistant text for streamText. */
function toPlainMessages(rawMessages: Array<{ role: string; content: unknown }>) {
  return rawMessages
    .filter((msg) => {
      // Drop tool result messages entirely
      if (msg.role === 'tool') return false;
      // Drop assistant messages that have no text content (tool-call-only)
      if (msg.role === 'assistant') {
        const text = typeof msg.content === 'string' ? msg.content.trim() : '';
        if (!text) return false;
      }
      return true;
    })
    .map((msg) => ({
      role: msg.role as 'user' | 'assistant' | 'system',
      content: typeof msg.content === 'string' ? msg.content : '',
      // Explicitly exclude toolInvocations — streamText will re-invoke tools as needed
    }));
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
  const profileResult = await resolveQueryProfile(targetDid);
  if (!profileResult.ok) {
    return new Response(JSON.stringify({ error: profileResult.error }), { status: profileResult.status });
  }
  const { profile } = profileResult;
  const resolvedTargetDid = profile.did;
  const isSelf = requesterDid === resolvedTargetDid;

  // 3. Trust gate (permissive: a down trust service allows the query through)
  const trustResult = await checkTrustDistance(requesterDid, resolvedTargetDid, isSelf, {
    strict: false,
    messages: { notConnected: 'Not connected', tooFar: 'Too far in trust graph' },
  });
  if (!trustResult.ok) {
    return new Response(JSON.stringify({ error: trustResult.error }), { status: trustResult.status });
  }
  const { trustDistance } = trustResult;

  // 4. Fetch presence
  const presenceData = await fetchPresenceData(resolvedTargetDid);

  // 5. Resolve the model from the PRESENCE OWNER's sealed connector card (#1621).
  //    Their presence, their brain, their credential. Supersedes any
  //    `model`/`provider` in the presence config — the per-DID sealed modelId is
  //    the owner's model choice and there is no env key to fall back on.
  const brain = await resolvePresenceBrain(resolvedTargetDid);
  if (!brain.ok) {
    log.warn({ targetDid: resolvedTargetDid, cause: brain.cause }, 'presence brain unavailable');
    return new Response(JSON.stringify({ error: brain.error }), {
      status: brain.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const { model, modelId, connector } = brain;

  // 6. Tools (resolved before system prompt so bootstrap can be generated from them)
  const tools = createPresenceTools({
    eventsUrl: process.env.EVENTS_SERVICE_URL ?? '',
    connectionsUrl: CONNECTIONS_URL,
    authUrl: '',
    payUrl: process.env.PAY_SERVICE_URL ?? '',
    profileUrl: buildPublicUrl('profile'),
    learnUrl: process.env.LEARN_SERVICE_URL ?? '',
    mediaUrl: MEDIA_URL,
    mediaApiKey: MEDIA_INTERNAL_API_KEY,
    targetDid: resolvedTargetDid,
    requesterDid,
    trustDistance,
    internalApiKey: TRUST_INTERNAL_API_KEY,
  });

  // 7. System prompt
  const soulMd = presenceData.soul ?? '';
  const contextMd = presenceData.context ?? '';
  const systemPrompt = ([soulMd, contextMd].filter(Boolean).join('\n\n') ||
    `You are the presence of ${profile.displayName}. Answer questions helpfully and authentically.`) +
    buildToolBootstrap(tools);

  // 8. Parse body — convert useChat format to plain messages for streamText
  const body = await request.json();
  const rawMessages = body.messages ?? [{ role: 'user', content: body.message ?? '' }];
  const messages = toPlainMessages(rawMessages);

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

      // Settle (non-fatal, silent on failure)
      const settled = await settleQueryCost({
        cost, isSelf, requesterDid, resolvedTargetDid, queryId, modelId, promptTokens, completionTokens,
      });

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

      // Emit usage.incurred (#1956) — joins the metering ledger the
      // completions passthrough already writes to. Fire-and-forget /
      // fail-open (recordPresenceQueryUsage never throws): a ledger hiccup
      // must never hold up (or reopen) the SSE stream already served.
      recordPresenceQueryUsage({
        queryId, mode: 'stream', actingForDid: resolvedTargetDid, requesterDid,
        provider: connector, modelId, promptTokens, completionTokens, costUsd: cost, settled,
      }).catch(() => {});
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
