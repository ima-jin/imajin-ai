/**
 * GET /infer/v1/models/usable (#2201, sub-issue of the #1926 passthrough
 * epic; depends on #2195/PR #2199).
 *
 * OpenAI-compatible model listing for the principal's USABLE brains: sealed
 * connectors with a resolved model (sealed model id, or the connector's own
 * default). OpenClaw provider plugins discover models live via
 * `GET {baseUrl}/models` (OpenAI list shape, 60s cache, advisory) — this
 * route lets the kernel answer that call so sealing a connector card on
 * `/jin` is the whole provisioning act for a future `imajin` OpenClaw
 * provider (plugin-side registration is tracked separately, out of scope
 * here).
 *
 * Nested under `models/` rather than mounted at `GET /infer/v1/models`
 * itself: that exact path (and HTTP method) is already `#1959`'s Anthropic
 * model-catalog passthrough (`../route.ts`) — a shipped, tested,
 * unrelated feature (forced to the `anthropic` connector, forwarding to
 * Anthropic's own live `/v1/models` for the Claude Code CLI's `/model`
 * picker). The two cannot share one Next.js route file: they answer
 * different questions ("what models does Anthropic currently offer" vs
 * "what has this principal actually sealed and can this kernel actually
 * serve") in different response shapes, and there is no reliable request
 * signal to multiplex on without risking a breaking change to the shipped
 * behavior. `usable` names the actual semantic this endpoint answers.
 *
 * `data` comes from `listUsableBrains` (#2201), the same candidate walk
 * `resolveBrain` (#2195) performs — factored out of `brain.ts` so this list
 * can never drift from what a `POST /infer/v1/chat/completions` call without
 * an explicit `model` would actually resolve to. Modelless sealed cards
 * (connected but no model chosen) are omitted: they cannot serve a request,
 * so they should not advertise as servable here either.
 *
 * Same auth/consent middleware as the completions route (#1925): an
 * app-token JWT via the `app.authorized` attestation, `infer:completions`
 * scope — a read-only listing of what completions could already resolve to
 * needs no new grant.
 *
 * Extra kernel-specific metadata (which connector, whose card, whether it is
 * servable) rides under a namespaced `imajin` key so the OpenAI-standard
 * fields (`id`, `object`, `owned_by`, `created`) stay exactly what an
 * OpenAI-compatible client expects. Never includes anything unsealed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@imajin/config';
import { createLogger } from '@imajin/logger';
import { resolveInferenceAuth } from '@/src/lib/inference/auth';
import { listUsableBrains, type ResolvedBrain } from '@/src/lib/inference/brain';

const log = createLogger('kernel:inference:usable-models-route');

/** Same scope as `POST /infer/v1/chat/completions` (#1925) — no new grant for a read-only listing of what completions could resolve to. */
const USABLE_MODELS_SCOPE = 'infer:completions';

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 30, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } },
    );
  }

  const auth = await resolveInferenceAuth(request, USABLE_MODELS_SCOPE);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const { ownerDid, appDid } = auth.context;

  try {
    const context = appDid ? { ownerDid, appDid } : ownerDid;
    const brains = await listUsableBrains(context);

    log.info({ ownerDid, appDid: appDid ?? null, count: brains.length }, 'usable models list: resolved usable brains');

    return NextResponse.json(toModelList(brains), { status: 200, headers: cors });
  } catch (err) {
    log.error({ err: String(err), ownerDid }, 'usable models list: failed');
    return NextResponse.json(
      { error: 'models_list_failed', message: 'Listing usable models failed', detail: String(err) },
      { status: 500, headers: cors },
    );
  }
}

/** OpenAI `GET /v1/models` list shape — `data` in resolution order, one row per usable (connector, model). */
function toModelList(brains: readonly ResolvedBrain[]) {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list' as const,
    data: brains.map((brain) => ({
      id: brain.modelId,
      object: 'model' as const,
      owned_by: brain.connector,
      created,
      imajin: {
        connector: brain.connector,
        credentialDid: brain.credentialDid,
        servable: true,
      },
    })),
  };
}
