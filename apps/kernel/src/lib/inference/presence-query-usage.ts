/**
 * usage.incurred emitter for the Ask Me presence-inference routes (#1956).
 *
 * `POST /api/profile/:id/query` and `/stream` already run on the presence
 * OWNER's sealed connector (`resolvePresenceBrain`, #1621) and settle each
 * query through pay with a `.fair` manifest, but neither wrote to the
 * metering ledger the completions passthrough (#1923/#1925) already joined
 * — every Ask Me query was priced and settled, yet invisible to
 * reconciliation against `usage.billed` (#1076). This is emitter shape #N
 * for the shared #1147/#1148 `usage.incurred` stream:
 * `source = 'presence:query'` for both routes (`metadata.mode` tells them
 * apart), `resource = 'model:{provider}/{modelId}'`, same discriminator the
 * completions passthrough (`usage-ledger.ts`) already writes.
 *
 * Deliberately thin: it reuses `usage-ledger.ts`'s `publishUsageIncurred`
 * bus publisher. The signed receipt is the sole source of the row, which
 * the existing usage-projection reactor materializes (#3262). Both routes
 * call this helper rather than duplicating the emit block.
 *
 * Fire-and-forget / fail-open, same contract `recordInferenceUsage` uses for
 * the passthrough: every failure is caught and logged at `error` with the
 * stable `usage_publish_failed` event and source for counting. A ledger
 * hiccup cannot change the HTTP response or hold up the `/stream` SSE
 * connection. There is no unsigned DB fallback.
 */
import { createLogger } from '@imajin/logger';
import { generateId } from '@/src/lib/kernel/id';
import { publishUsageIncurred } from './usage-ledger';

const log = createLogger('kernel:inference:presence-query-usage');

/** `usage.incurred.source` for every Ask Me query, streamed or not (#1956). */
export const PRESENCE_QUERY_SOURCE = 'presence:query';

export interface RecordPresenceQueryUsageParams {
  /** The `query_logs.id` this call already logged under — reused as the dedupe (`external_id`) key. */
  queryId: string;
  mode: 'query' | 'stream';
  /** Presence owner DID — who the `.fair` settlement (and this usage) is attributed to. */
  actingForDid: string;
  requesterDid: string;
  /** The owner's sealed connector id (`resolvePresenceBrain`'s `connector`), e.g. `'anthropic'`. */
  provider: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  /** Estimated USD cost of this call (`calculateCost`), independent of whether it was actually settled. */
  costUsd: number;
  settled: boolean;
}

/**
 * Publish one signed `usage.incurred` receipt for one served Ask Me query.
 * The usage-projection reactor writes the row. Never throws.
 */
export function recordPresenceQueryUsage(params: RecordPresenceQueryUsageParams): Promise<void> {
  const {
    queryId,
    mode,
    actingForDid,
    requesterDid,
    provider,
    modelId,
    promptTokens,
    completionTokens,
    costUsd,
    settled,
  } = params;

  // #1147 typed discriminator, same 'model:{provider}/{model}' shape the
  // completions passthrough writes (usage-ledger.ts).
  const resource = `model:${provider}/${modelId}`;
  const quantity = promptTokens + completionTokens;
  // The amount actually moved through pay for this query; 0 when it wasn't
  // settled (self-query, zero cost, or the settle call itself failed).
  const settleAmount = settled ? costUsd : 0;
  const reportPublishFailure = (err: unknown): void => {
    log.error(
      { event: 'usage_publish_failed', source: PRESENCE_QUERY_SOURCE, err: String(err), queryId, actingForDid, provider, modelId, mode },
      'presence usage.incurred receipt publish failed — response already served',
    );
  };

  try {
    const usageId = generateId('usage');
    // Fire-and-forget keeps the served query independent of publisher
    // latency. All row fields travel through the signed receipt only.
    publishUsageIncurred({
      usageId,
      principalDid: actingForDid,
      resource,
      quantity,
      unit: 'tokens',
      costUsd,
      source: PRESENCE_QUERY_SOURCE,
      provider,
      model: modelId,
      tokensIn: promptTokens,
      tokensOut: completionTokens,
      agentDid: requesterDid,
      externalId: queryId,
      metadata: { queryId, requesterDid, settled, settleAmount, mode },
    }).catch(reportPublishFailure);
  } catch (err) {
    reportPublishFailure(err);
  }
  return Promise.resolve();
}
