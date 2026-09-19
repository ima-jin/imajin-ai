/**
 * Request-body shaping for OpenAI-served models (imajin-ai#2201).
 *
 * OpenAI's current chat-completions surface rejects two parameter shapes
 * that are otherwise perfectly valid OpenAI-compatible requests — both
 * observed live on `gpt-6-astra` (the #1926 delegated seat):
 *
 *   1. `max_tokens` — OpenAI now requires `max_completion_tokens` instead
 *      (`Unsupported parameter: 'max_tokens' … Use 'max_completion_tokens'`).
 *   2. `reasoning_effort` alongside `tools` — OpenAI rejects the combination
 *      outright (`Function tools with reasoning_effort are not supported for
 *      gpt-6-astra in /v1/chat/completions`).
 *
 * Neither rewrite is safe to apply universally: xAI (and every other
 * OpenAI-compatible connector this proxy fronts) accepts both fields as-is,
 * so this only ever fires for a request whose `model` looks like one of
 * OpenAI's own ids — the same `gpt-`/`o1-`/`o3-` `modelPrefixes` shape the
 * worked-example runbook configures the `openai` route with (README.md).
 * This is checked against a fixed prefix list here, deliberately NOT the
 * resolved route's own `modelPrefixes`: a route is resolved either by an
 * explicit path segment (`providerIdFromPath`) or by a `modelPrefixes`
 * match, so "the request's model matches the resolved route's own
 * `modelPrefixes`" is true by construction for every route, not just
 * OpenAI's — checking that would apply this rewrite to every connector's
 * traffic. Keying off the model id's own OpenAI shape is what actually
 * scopes this to "OpenAI-served models", regardless of which route
 * (path-prefixed or prefix-matched) the request came in on.
 *
 * Applied once, in `handle-completions.ts`, before either the kernel or the
 * break-glass direct forward — a raw byte passthrough otherwise, so this is
 * the one deliberate exception to that contract (see `router.ts`/
 * `upstream.ts` for why byte-for-byte forwarding is the default).
 */

const MAX_TOKENS_KEY = 'max_tokens';
const MAX_COMPLETION_TOKENS_KEY = 'max_completion_tokens';
const REASONING_EFFORT_KEY = 'reasoning_effort';
const TOOLS_KEY = 'tools';

/** OpenAI's own model-id prefixes — matches the `openai` route's `modelPrefixes` in the worked-example runbook (README.md). */
const OPENAI_MODEL_PREFIXES = ['gpt-', 'o1-', 'o3-'];

/**
 * Rewrite `max_tokens` → `max_completion_tokens` (when the latter is absent)
 * and drop `reasoning_effort` (when `tools` is present) — but only when
 * `model` looks like an OpenAI model id. Returns `bodyText` completely
 * unchanged (same string reference) whenever no rewrite applies, or when
 * the body cannot be parsed as a JSON object — a raw byte passthrough is the
 * safe default when this module can't confidently reason about the body.
 */
export function translateOpenAiParams(model: string | undefined, bodyText: string): string {
  if (!model || !isOpenAiModel(model)) return bodyText;

  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(bodyText);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return bodyText;
    parsed = value as Record<string, unknown>;
  } catch {
    return bodyText;
  }

  const { changed, body } = applyRewrites(parsed);
  return changed ? JSON.stringify(body) : bodyText;
}

function isOpenAiModel(model: string): boolean {
  return OPENAI_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

/** Applies both rewrites to a parsed body, reporting whether either one actually changed anything. */
function applyRewrites(parsed: Record<string, unknown>): { changed: boolean; body: Record<string, unknown> } {
  let body = parsed;
  let changed = false;

  if (shouldRenameMaxTokens(body)) {
    const { [MAX_TOKENS_KEY]: maxTokens, ...rest } = body;
    body = { ...rest, [MAX_COMPLETION_TOKENS_KEY]: maxTokens };
    changed = true;
  }

  if (shouldDropReasoningEffort(body)) {
    body = { ...body };
    delete body[REASONING_EFFORT_KEY];
    changed = true;
  }

  return { changed, body };
}

function shouldRenameMaxTokens(body: Record<string, unknown>): boolean {
  return MAX_TOKENS_KEY in body && !(MAX_COMPLETION_TOKENS_KEY in body);
}

function shouldDropReasoningEffort(body: Record<string, unknown>): boolean {
  return REASONING_EFFORT_KEY in body && TOOLS_KEY in body;
}
