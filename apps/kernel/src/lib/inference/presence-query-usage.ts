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
 * Deliberately thin: it reuses `usage-ledger.ts`'s row shape and its
 * `publishUsageIncurred` bus publisher rather than hand-rolling a second
 * writer or a second publisher (both routes call this one helper instead of
 * duplicating the emit block — the #1956 issue's own explicit ask).
 *
 * Fire-and-forget / fail-open, same contract `recordInferenceUsage` uses for
 * the passthrough: every failure is caught and logged at `warn` (not
 * `error` — unlike the passthrough, this is a secondary metering signal
 * alongside an already-durable `query_logs` row and `.fair` settlement, not
 * itself the sole record of the call) so a ledger hiccup can never change
 * the HTTP response already computed, or hold up the `/stream` SSE
 * connection.
 */
import { createLogger } from '@imajin/logger';
import { db, usageIncurred } from '@/src/db';
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
  /** The amount actually moved through pay for this query; `0` when `settled` is false. */
  settleAmount: number;
}

/**
 * Write one `usage.incurred` row + publish its bus event for one served Ask
 * Me query. Never throws.
 */
export async function recordPresenceQueryUsage(params: RecordPresenceQueryUsageParams): Promise<void> {
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
    settleAmount,
  } = params;

  // #1147 typed discriminator, same 'model:{provider}/{model}' shape the
  // completions passthrough writes (usage-ledger.ts).
  const resource = `model:${provider}/${modelId}`;
  const quantity = promptTokens + completionTokens;

  try {
    const usageId = generateId('usage');

    await db.insert(usageIncurred).values({
      id: usageId,
      principalDid: actingForDid,
      // The invoking identity, distinct from the principal the spend is
      // attributed to — same convention as the ingest route's own agentDid
      // (incurred-ingest.ts / app/usage/api/incurred/route.ts).
      agentDid: requesterDid,
      source: PRESENCE_QUERY_SOURCE,
      resource,
      provider,
      model: modelId,
      tokensIn: promptTokens,
      tokensOut: completionTokens,
      costUsd: costUsd.toFixed(8),
      quantity: quantity.toFixed(6),
      unit: 'tokens',
      // Each query is already exactly-once (one HTTP call, one queryId) —
      // reusing it as the dedupe key costs nothing and mirrors the
      // uniq_usage_incurred_source_external_id index's intent.
      externalId: queryId,
    });

    // #1148: publish the bus event — turns the row into a signed
    // system-class fact via the shared attestation + emit chain. NOT
    // awaited: the row is already durably written above, so a slow or
    // failed bus publish must never add latency to (or fail) an
    // already-served query — same fail-open contract the rest of this
    // function follows.
    publishUsageIncurred({
      usageId,
      principalDid: actingForDid,
      resource,
      quantity,
      unit: 'tokens',
      costUsd,
      source: PRESENCE_QUERY_SOURCE,
      metadata: { queryId, requesterDid, settled, settleAmount, mode },
    }).catch((err: unknown) => {
      log.warn(
        { err: String(err), queryId, usageId },
        'presence usage.incurred bus publish failed — row already written',
      );
    });
  } catch (err) {
    log.warn(
      { err: String(err), queryId, actingForDid, provider, modelId, mode },
      'presence usage.incurred ledger write failed — response already served',
    );
  }
}
