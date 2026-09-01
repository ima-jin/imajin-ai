/**
 * Shared dynamic model-picker route factory (#1928).
 *
 * `GET`/`PUT` `/{connector}/api/models` back every token-paste brain
 * connector's model picker (#1769): the owner is asked to choose a live model
 * from their own sealed key instead of the kernel guessing a `defaultModelId`
 * that inevitably goes stale (`gemini-2.0-flash` shut down while still
 * hardcoded — #1764). Gemini (#1818) and xAI (#1924) hand-copied this route
 * byte-for-byte down to the error taxonomy, differing only in how each
 * provider's HTTP API is actually called — which is exactly the shape a
 * factory exists to declare once. The next token-paste provider with a model
 * picker (#1927, #1930, #1931) supplies `listModels` + `probeModel` and gets
 * everything else — auth, sealed-key resolution, body validation, error
 * mapping — for free.
 *
 * Behaviour contract (byte-identical to the routes this replaces):
 *   GET  — lists the models the owner's sealed key can see. Does NOT require
 *          an active `{id}:infer` grant (#1773) — the owner is asking what
 *          their own key can do, typically before reaching the "grant
 *          scopes" step, not spending the credential on inference.
 *   PUT  — validates the chosen model against the provider with the owner's
 *          own key, and only seals it (`setModelId`, #1769) once that
 *          validation succeeds. A 404-equivalent from the provider is
 *          reported as `model_deprecated` (422); any other probe failure is
 *          an upstream fault (502), not the caller's.
 *
 * Security invariant: the sealed key never leaves the kernel, in either
 * direction — not in the GET response, and not echoed back on PUT. Upstream
 * response bodies are never surfaced either, only their status code — an
 * error page can echo the request (and the key) straight back.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { resolveConnectorOwnerDid } from '@/src/lib/kernel/connector-owner-did';

const log = createLogger('kernel');

/** One selectable model, as returned to the browser. Never carries the key. */
export interface ModelOption {
  id: string;
  name: string;
}

/** The minimum shape a provider's sealed credentials must carry for this factory. */
export interface ModelPickerCredentials {
  apiKey: string;
  baseUrl?: string;
  modelId?: string;
}

/** Outcome of fetching a provider's model list. */
export type ModelListResult =
  | { ok: true; models: ModelOption[] }
  | { ok: false; status: number; statusText: string };

/** Outcome of validating one model id against the provider. */
export type ModelProbeResult =
  | { ok: true }
  | { ok: false; deprecated: true }
  | { ok: false; deprecated: false; status: number; statusText: string };

export interface ConnectorModelPickerRouteOpts<C extends ModelPickerCredentials> {
  /**
   * Lowercase connector id, e.g. `'gemini'`. Used for the `${id}_*`
   * machine-readable error prefixes, so it must match the id the connector's
   * token-paste factory was built with.
   */
  id: string;
  /** Display name used in owner-facing prose, e.g. `'Gemini'`. */
  displayName: string;
  /**
   * Name of the upstream service used specifically in "failed to reach …"
   * transport-failure messages. Defaults to `displayName` — set this when the
   * upstream brand differs from the connector's display name (e.g. the
   * Gemini connector calls Google's API).
   */
  upstreamName?: string;
  /** Resolve the sealed key (+ optional baseUrl/modelId) without requiring a grant (#1773). */
  loadSealedCredentials: (ownerDid: string) => Promise<C | undefined>;
  /** Whether a key is sealed but awaiting owner grant approval. */
  keyPending: (ownerDid: string) => Promise<boolean>;
  /** Seal just the chosen model id, leaving the API key untouched (#1769). */
  setModelId: (ownerDid: string, modelId: string) => Promise<void>;
  /**
   * Fetch + normalise the models available to the owner's sealed key.
   * Throw only for transport failures (network); an upstream HTTP failure is
   * reported via the `{ ok: false }` result instead, matching `probeModel`.
   */
  listModels: (creds: C) => Promise<ModelListResult>;
  /**
   * Validate one model id against the provider using the owner's key. Throw
   * only for transport failures; a non-2xx upstream response is reported via
   * the `{ ok: false }` result instead.
   */
  probeModel: (creds: C, modelId: string) => Promise<ModelProbeResult>;
}

type RouteHandler = (request: NextRequest) => Promise<NextResponse>;

export interface ConnectorModelPickerRouteHandlers {
  GET: RouteHandler;
  PUT: RouteHandler;
  OPTIONS: RouteHandler;
}

/**
 * Build the `GET` + `PUT` + `OPTIONS` handlers for a connector's dynamic
 * model-picker route. Designed to be re-exported straight from the route file:
 *
 * ```ts
 * export const { GET, PUT, OPTIONS } = createConnectorModelPickerRoute({ … });
 * ```
 */
export function createConnectorModelPickerRoute<C extends ModelPickerCredentials>(
  opts: ConnectorModelPickerRouteOpts<C>,
): ConnectorModelPickerRouteHandlers {
  const upstreamName = opts.upstreamName ?? opts.displayName;

  type SealedKeyLookup =
    | { ok: true; creds: C }
    | { ok: false; response: NextResponse };

  /**
   * Resolve the caller's sealed key, or the typed failure response for
   * `${id}_no_key` (400) / `${id}_credential_pending` (409) — shared by GET
   * and PUT so both report identically on "nothing sealed yet".
   */
  async function requireSealedKey(
    ownerDid: string,
    cors: Record<string, string>,
  ): Promise<SealedKeyLookup> {
    const creds = await opts.loadSealedCredentials(ownerDid);
    if (creds) {
      return { ok: true, creds };
    }
    if (await opts.keyPending(ownerDid)) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: `${opts.id}_credential_pending: ${opts.displayName} API key is sealed but awaiting owner grant approval`,
          },
          { status: 409, headers: cors },
        ),
      };
    }
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `${opts.id}_no_key: no ${opts.displayName} API key sealed for this identity — seal one on the ${opts.displayName} connector card first`,
        },
        { status: 400, headers: cors },
      ),
    };
  }

  async function OPTIONS(request: NextRequest): Promise<NextResponse> {
    return corsOptions(request) as NextResponse;
  }

  /**
   * List models available to the caller's sealed key. Does not require an
   * active `${id}:infer` grant (#1773).
   */
  async function GET(request: NextRequest): Promise<NextResponse> {
    const cors = corsHeaders(request);

    const auth = await resolveConnectorOwnerDid(request);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }
    const { ownerDid } = auth;

    const lookup = await requireSealedKey(ownerDid, cors);
    if (!lookup.ok) {
      return lookup.response;
    }
    const { creds } = lookup;

    let result: ModelListResult;
    try {
      result = await opts.listModels(creds);
    } catch (err) {
      log.error({ err: String(err), ownerDid }, `${opts.id} models: fetch failed`);
      return NextResponse.json(
        { error: `${opts.id}_models: failed to reach ${upstreamName}` },
        { status: 502, headers: cors },
      );
    }
    if (!result.ok) {
      // The response body is never surfaced: an upstream error page can echo
      // back the query string, which would leak the key into the response.
      log.warn({ ownerDid, status: result.status }, `${opts.id} models: upstream list failed`);
      return NextResponse.json(
        { error: `${opts.id}_models: upstream ${result.status} ${result.statusText}` },
        { status: 502, headers: cors },
      );
    }

    return NextResponse.json(
      { models: result.models, currentModelId: creds.modelId ?? null },
      { headers: cors },
    );
  }

  /**
   * Validate, then seal, the owner's chosen model id, without touching the
   * sealed API key. `model_deprecated` (422) when the probe reports the model
   * is gone upstream; any other probe failure maps to 502, matching GET's
   * treatment of upstream failures. `setModelId` is only called once the
   * probe succeeds.
   */
  async function PUT(request: NextRequest): Promise<NextResponse> {
    const cors = corsHeaders(request);

    const auth = await resolveConnectorOwnerDid(request);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
    }
    const { ownerDid } = auth;

    let body: { modelId?: unknown };
    try {
      body = (await request.json()) as { modelId?: unknown };
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
    }

    const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
    if (!modelId) {
      return NextResponse.json({ error: 'modelId must be a non-empty string' }, { status: 400, headers: cors });
    }

    const lookup = await requireSealedKey(ownerDid, cors);
    if (!lookup.ok) {
      return lookup.response;
    }
    const { creds } = lookup;

    let probe: ModelProbeResult;
    try {
      probe = await opts.probeModel(creds, modelId);
    } catch (err) {
      log.error({ err: String(err), ownerDid }, `${opts.id} models: liveness probe failed to reach ${upstreamName}`);
      return NextResponse.json(
        { error: `${opts.id}_models: failed to reach ${upstreamName}` },
        { status: 502, headers: cors },
      );
    }

    if (!probe.ok) {
      if (probe.deprecated) {
        log.warn({ ownerDid, modelId }, `${opts.id} models: rejected selection of a model retired upstream`);
        return NextResponse.json(
          {
            error: 'model_deprecated',
            message: `${opts.displayName} model '${modelId}' was not found — it has likely been retired. Choose a different model.`,
            modelId,
          },
          { status: 422, headers: cors },
        );
      }
      // The response body is never surfaced, matching GET.
      log.warn({ ownerDid, status: probe.status }, `${opts.id} models: liveness probe failed`);
      return NextResponse.json(
        { error: `${opts.id}_models: upstream ${probe.status} ${probe.statusText}` },
        { status: 502, headers: cors },
      );
    }

    try {
      await opts.setModelId(ownerDid, modelId);
    } catch (err) {
      log.error({ err: String(err), ownerDid }, `${opts.id} models: failed to seal modelId`);
      return NextResponse.json(
        { error: `Failed to store the selected ${opts.displayName} model` },
        { status: 500, headers: cors },
      );
    }

    return NextResponse.json({ modelId }, { headers: cors });
  }

  return { GET, PUT, OPTIONS };
}
