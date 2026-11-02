/**
 * GET /infer/v1/models/usable (#2201, sub-issue of the #1926 passthrough
 * epic; depends on #2195/PR #2199).
 *
 * OpenAI-compatible model listing for the principal's USABLE brains: sealed
 * connectors expanded to their live picker lists (#3027), with the current
 * pick marked as `imajin.picked`. OpenClaw plugins discover models live via
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
 * `data` comes from `listUsableModels`, expanding the same candidate walk
 * `resolveBrain` performs with the connector cards' own picker loaders.
 * Duplicate ids use the same routing winner as resolution. Modelless sealed cards
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
import { corsHeaders } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@imajin/config';
import { createLogger } from '@imajin/logger';
import { resolveInferenceAuth, type InferenceAuthContext } from '@/src/lib/inference/auth';
import { listUsableModels } from '@/src/lib/inference/brain';
import { ExternalMcpError } from '@/src/lib/kernel/external-mcp-policy';
import type { UsableModel } from '@/src/lib/inference/model-catalog';

const log = createLogger('kernel:inference:usable-models-route');

/** Same scope as `POST /infer/v1/chat/completions` (#1925) — no new grant for a read-only listing of what completions could resolve to. */
const USABLE_MODELS_SCOPE = 'infer:completions';

export const dynamic = 'force-dynamic';

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
  const { ownerDid, appDid, orgContext, caller } = auth.context;

  try {
    // Opt-in diagnostics leave the existing OpenAI model catalog byte-shape unchanged.
    if (new URL(request.url ?? 'http://localhost').searchParams.get('explain') === '1') {
      return explainRoutes(auth.context, cors);
    }
    const context = appDid || orgContext || caller ? auth.context : ownerDid;
    const brains = await listUsableModels(context);

    log.info({ ownerDid, appDid: appDid ?? null, count: brains.length }, 'usable models list: resolved usable brains');

    return NextResponse.json(toModelList(brains), { status: 200, headers: cors });
  } catch (err) {
    if (err instanceof ExternalMcpError) return NextResponse.json({ error: err.message }, { status: err.status, headers: cors });
    log.error({ err: String(err), ownerDid }, 'usable models list: failed');
    return NextResponse.json(
      { error: 'models_list_failed', message: 'Listing usable models failed', detail: String(err) },
      { status: 500, headers: cors },
    );
  }
}

async function explainRoutes(context: InferenceAuthContext, cors: Record<string, string>) {
  const headers = { ...cors, 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization, x-acting-as' };
  try {
    const { listInferenceRoutes } = await import('@/src/lib/inference/route-discovery');
    return NextResponse.json({ routes: await listInferenceRoutes(context) }, { status: 200, headers });
  } catch {
    return NextResponse.json({ error: 'inference_routes_unavailable' }, { status: 503, headers });
  }
}

/** OpenAI list shape, one row per id with metadata for the same winner resolveBrain selects. */
function toModelList(brains: readonly UsableModel[]) {
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
        picked: brain.picked,
      },
    })),
  };
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
