/** Shared picker handlers for the connector card and usable inference catalog (#3027). */
import type { ModelListResult, ModelProbeResult } from '@/src/lib/kernel/connector-model-picker-route';
import { ANTHROPIC_BASE_URL, type AnthropicCredentials } from './connector';

/** Pinned the same way `lib/usage/billed/anthropic.ts` pins it for the Admin API. */
const ANTHROPIC_VERSION = '2023-06-01';

/** Defends against a runaway `has_more` loop from a misbehaving upstream. */
const MAX_LIST_PAGES = 20;

/** Shape of one entry in Anthropic's `/v1/models` response, narrowed to what this route reads. */
interface RawAnthropicModel {
  id?: string;
  display_name?: string;
}

/** Shape of one page of Anthropic's `/v1/models` response. */
interface RawAnthropicModelsPage {
  data?: RawAnthropicModel[];
  has_more?: boolean;
  last_id?: string | null;
}

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/** Anthropic's error envelope: `{ type: 'error', error: { type, message } }`. */
interface AnthropicErrorBody {
  error?: { type?: string; message?: string };
}

/**
 * Best-effort read of Anthropic's own `error.type`/`error.message` off a
 * non-2xx response (#2196), so the connector card can show e.g.
 * `invalid_request_error: <reason>` instead of a bare `400 Bad Request`.
 * Only those two known-safe string fields are read — never the raw body —
 * so nothing else an error page might carry (and the sealed key, which
 * never rides an Anthropic error response in the first place) can leak.
 * Never throws: a body that is not JSON, or not this shape, falls back to
 * the plain HTTP status text.
 */
async function describeAnthropicError(res: { json: () => Promise<unknown> }, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as AnthropicErrorBody;
    const type = typeof body.error?.type === 'string' ? body.error.type : undefined;
    const message = typeof body.error?.message === 'string' ? body.error.message : undefined;
    if (type && message) return `${type}: ${message}`;
    if (message) return message;
  } catch {
    // Not JSON, or not Anthropic's error shape — fall back to the plain HTTP status text.
  }
  return fallback;
}

/**
 * List every model the owner's sealed key can see, walking Anthropic's
 * `has_more`/`last_id` pagination to completion (capped at
 * `MAX_LIST_PAGES` pages) rather than reporting just the first page.
 */
export async function listModels(creds: AnthropicCredentials): Promise<ModelListResult> {
  const baseUrl = creds.baseUrl ?? ANTHROPIC_BASE_URL;
  const models: { id: string; name: string }[] = [];
  let afterId: string | undefined;

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const url = afterId ? `${baseUrl}/models?after_id=${encodeURIComponent(afterId)}` : `${baseUrl}/models`;
    const res = await fetch(url, { headers: anthropicHeaders(creds.apiKey) });
    if (!res.ok) {
      return { ok: false, status: res.status, statusText: await describeAnthropicError(res, res.statusText) };
    }
    const raw = (await res.json()) as RawAnthropicModelsPage;
    for (const model of raw.data ?? []) {
      if (typeof model.id === 'string' && model.id.length > 0) {
        models.push({ id: model.id, name: model.display_name ?? model.id });
      }
    }
    if (!raw.has_more || !raw.last_id) break;
    afterId = raw.last_id;
  }

  return { ok: true, models };
}

/**
 * Validate one model id against Anthropic with the owner's own key. A 404
 * means the id is not servable for this key (retired, or never existed); any
 * other non-2xx is an unrelated upstream fault, matching `listModels`'s
 * treatment of upstream failures.
 */
export async function probeModel(creds: AnthropicCredentials, modelId: string): Promise<ModelProbeResult> {
  const baseUrl = creds.baseUrl ?? ANTHROPIC_BASE_URL;
  const res = await fetch(`${baseUrl}/models/${encodeURIComponent(modelId)}`, {
    headers: anthropicHeaders(creds.apiKey),
  });
  if (res.ok) {
    return { ok: true };
  }
  if (res.status === 404) {
    return { ok: false, deprecated: true };
  }
  return {
    ok: false,
    deprecated: false,
    status: res.status,
    statusText: await describeAnthropicError(res, res.statusText),
  };
}

