/**
 * NanoClaw session JSONL -> `usage.incurred` row mapper (imajin-ai#1932,
 * #1151). `source: 'harness:nanoclaw'` is the external-emitter identity the
 * issue names explicitly ("source e.g. harness:nanoclaw") so attribution
 * lands even when cost is $0.
 *
 * NanoClaw's Claude provider (`container/agent-runner/src/providers/claude.ts`)
 * uses the same `@anthropic-ai/claude-agent-sdk`/Claude Code CLI as Claude
 * Code itself, so its session JSONL follows the same CONTRACT
 * `packages/usage-emitter-claude-code/src/mapper.ts` maps (message.id
 * dedupe key, cache-read tokens folded into tokens_in, synthetic-model
 * turns excluded) — implemented independently here (that package exports
 * only its top-level CLI, not this helper), attributed to
 * `harness:nanoclaw` instead of `adapter:claude-code`.
 */

const SOURCE = 'harness:nanoclaw' as const;
const PROVIDER = 'anthropic' as const;
const SYNTHETIC_MODEL = '<synthetic>';

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

/** The pieces of one JSONL line this mapper cares about, once extracted and validated. */
interface AssistantTurn {
  model: string;
  externalId: string;
  timestamp: string;
  tokensIn: number;
  tokensOut: number;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asPositiveString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Pull the fields a `usage.incurred` row needs out of one raw JSONL line, or
 * `undefined` when the line carries nothing billable — a non-assistant line,
 * one with no `usage` block, or Claude Code's own synthetic/local turns.
 */
function extractAssistantTurn(rawLine: unknown): AssistantTurn | undefined {
  const line = asObject(rawLine);
  if (!line || line.type !== 'assistant') return undefined;

  const message = asObject(line.message);
  const usage = message && asObject(message.usage);
  if (!message || !usage) return undefined;

  const model = asPositiveString(message.model);
  if (!model || model === SYNTHETIC_MODEL) return undefined;

  // message.id identifies the whole API call (see module header); the raw
  // line's own uuid is only a fallback for lines that lack it.
  const externalId = asPositiveString(message.id) ?? asPositiveString(line.uuid);
  const timestamp = asPositiveString(line.timestamp);
  if (!externalId || !timestamp) return undefined;

  return {
    model,
    externalId,
    timestamp,
    tokensIn: asFiniteNumber(usage.input_tokens, 0) + asFiniteNumber(usage.cache_read_input_tokens, 0),
    tokensOut: asFiniteNumber(usage.output_tokens, 0),
  };
}

function toUsageRow(turn: AssistantTurn): MappedUsageRow {
  return {
    source: SOURCE,
    resource: `model:${PROVIDER}/${turn.model}`,
    provider: PROVIDER,
    model: turn.model,
    tokens_in: turn.tokensIn,
    tokens_out: turn.tokensOut,
    external_id: turn.externalId,
    ts: turn.timestamp,
  };
}

export function mapAssistantLine(rawLine: unknown): MappedUsageRow | undefined {
  const turn = extractAssistantTurn(rawLine);
  return turn && toUsageRow(turn);
}

/**
 * Map a batch of raw JSONL lines, keeping only the LAST row seen for each
 * `external_id` (a call spanning several streamed lines repeats the id;
 * later lines carry the more complete token counts as the stream finishes).
 */
export function mapJsonlLines(rawLines: readonly unknown[]): MappedUsageRow[] {
  const dedupedByExternalId = new Map<string, MappedUsageRow>();
  rawLines.forEach((rawLine) => {
    const row = mapAssistantLine(rawLine);
    if (row) dedupedByExternalId.set(row.external_id, row);
  });
  return Array.from(dedupedByExternalId.values());
}
