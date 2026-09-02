/**
 * NanoClaw session JSONL -> `usage.incurred` row mapper (imajin-ai#1932,
 * #1151). `source: 'harness:nanoclaw'` is the external-emitter identity the
 * issue names explicitly ("source e.g. harness:nanoclaw") so attribution
 * lands even when cost is $0.
 *
 * NanoClaw's Claude provider (`container/agent-runner/src/providers/claude.ts`)
 * uses the same `@anthropic-ai/claude-agent-sdk`/Claude Code CLI as Claude
 * Code itself, so its session JSONL has the identical shape
 * `packages/usage-emitter-claude-code/src/mapper.ts` documents — this
 * module mirrors that mapper's logic (message.id dedupe key, cache-read
 * tokens folded into tokens_in, synthetic-model turns excluded), attributed
 * to `harness:nanoclaw` instead of `adapter:claude-code`.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function mapAssistantLine(raw: unknown): MappedUsageRow | undefined {
  if (!isRecord(raw) || raw.type !== 'assistant') return undefined;

  const message = raw.message;
  if (!isRecord(message)) return undefined;

  const usage = message.usage;
  if (!isRecord(usage)) return undefined;

  const model = typeof message.model === 'string' ? message.model : undefined;
  if (!model || model === SYNTHETIC_MODEL) return undefined;

  const externalId =
    typeof message.id === 'string' && message.id.length > 0
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

export function mapJsonlLines(rawLines: readonly unknown[]): MappedUsageRow[] {
  const byExternalId = new Map<string, MappedUsageRow>();
  for (const raw of rawLines) {
    const mapped = mapAssistantLine(raw);
    if (mapped) byExternalId.set(mapped.external_id, mapped);
  }
  return [...byExternalId.values()];
}
