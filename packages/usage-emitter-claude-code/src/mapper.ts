/**
 * Claude Code session JSONL → `usage.incurred` row mapper (#1151).
 *
 * Pure and DB/network-free, so it is unit-testable against real fixture
 * lines without a filesystem or a kernel to talk to.
 *
 * Claude Code writes one JSONL line per event under
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Only `type:
 * "assistant"` lines carry token accounting, under `message.usage`:
 * `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
 * `cache_read_input_tokens`.
 *
 * Two format quirks this mapper accounts for (observed, not documented by
 * Anthropic — see the reference emitter's README for sources):
 *
 * 1. One API call can be split across several JSONL lines (one per streamed
 *    content block), each repeating the same `message.usage`. All of a
 *    call's lines share one `message.id`, so `message.id` — not the
 *    per-line `uuid` — is this mapper's dedupe/idempotency key
 *    (`external_id`). `mapJsonlLines` collapses same-`message.id` lines,
 *    keeping the last one seen (later lines carry the more complete
 *    `output_tokens` count as the stream finishes).
 * 2. `usage.incurred` has no separate cache-token columns yet (`quantity`/
 *    `unit` land in #1148's own migration). `cache_read_input_tokens` is
 *    folded into `tokensIn` here rather than dropped — a coarser number
 *    beats a missing one — noted in the package README's "Decisions for
 *    review".
 */

const SOURCE = 'adapter:claude-code' as const;
const PROVIDER = 'anthropic' as const;

/**
 * Claude Code's own sentinel `message.model` value for locally-generated
 * turns (compaction summaries, hook-injected turns, etc.) that never called
 * the API and carry no billable usage — excluded rather than emitted as a
 * zero-token row.
 */
const SYNTHETIC_MODEL = '<synthetic>';

/** One row shaped for `POST /usage/api/incurred`'s body schema. */
export interface MappedUsageRow {
  source: typeof SOURCE;
  resource: string;
  provider: typeof PROVIDER;
  model: string;
  tokens_in: number;
  tokens_out: number;
  external_id: string;
  ts: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Map one raw parsed JSONL line to a usage row, or `undefined` when the line
 * carries no billable usage (non-assistant lines, assistant lines with no
 * `usage` object, or Claude Code's own synthetic/local turns).
 */
export function mapAssistantLine(raw: unknown): MappedUsageRow | undefined {
  if (!isRecord(raw) || raw.type !== 'assistant') return undefined;

  const message = raw.message;
  if (!isRecord(message)) return undefined;

  const usage = message.usage;
  if (!isRecord(usage)) return undefined;

  const model = typeof message.model === 'string' ? message.model : undefined;
  if (!model || model === SYNTHETIC_MODEL) return undefined;

  const externalId = typeof message.id === 'string' && message.id.length > 0
    ? message.id
    : typeof raw.uuid === 'string' && raw.uuid.length > 0
      ? raw.uuid
      : undefined;
  if (!externalId) return undefined;

  const ts = typeof raw.timestamp === 'string' && raw.timestamp.length > 0 ? raw.timestamp : undefined;
  if (!ts) return undefined;

  const inputTokens = numberOr(usage.input_tokens, 0);
  const cacheReadTokens = numberOr(usage.cache_read_input_tokens, 0);
  const outputTokens = numberOr(usage.output_tokens, 0);

  return {
    source: SOURCE,
    resource: `model:${PROVIDER}/${model}`,
    provider: PROVIDER,
    model,
    tokens_in: inputTokens + cacheReadTokens,
    tokens_out: outputTokens,
    external_id: externalId,
    ts,
  };
}

/**
 * Map a batch of raw parsed JSONL lines, collapsing lines that share one
 * `message.id` (see the module header) down to the last-seen row for that
 * id. Order-preserving otherwise.
 */
export function mapJsonlLines(rawLines: readonly unknown[]): MappedUsageRow[] {
  const byExternalId = new Map<string, MappedUsageRow>();
  for (const raw of rawLines) {
    const mapped = mapAssistantLine(raw);
    if (mapped) byExternalId.set(mapped.external_id, mapped);
  }
  return [...byExternalId.values()];
}
