/**
 * TypeSafe.ai (Jev) usage-ledger writer (#2197).
 *
 * Writes one `usage.incurred` row per `POST /typesafe/api/decide` call, for
 * cost visibility only — deliberately NOT `recordInferenceUsage`
 * (`src/lib/inference/usage-ledger.ts`), which is brain/inference-specific:
 * it types `provider` as `BrainConnectorId`, and always writes a
 * `pay.transactions` row + the `pay.balance_rollups` daily aggregate. Per
 * the issue, TypeSafe usage carries no spend-cap and no brain coupling —
 * this module writes only the metering row, straight to `usage.incurred`,
 * and publishes the same `usage.incurred` bus event every other emitter
 * does (#1148) via the shared, emitter-agnostic `publishUsageIncurred`.
 *
 * Fails open, mirroring `recordInferenceUsage`: a metering failure must
 * never turn a successful `/decide` call into a 500 for the caller.
 */
import { createLogger } from '@imajin/logger';
import { db, usageIncurred } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { connectorRegistryId } from '@/src/lib/kernel/connector-registry-store';
import { publishUsageIncurred } from '@/src/lib/inference/usage-ledger';

const log = createLogger('kernel:typesafe:usage');

/** TypeSafe's published input-token rate; output tokens are free (docs.typesafe.ai/api). */
const INPUT_RATE_USD_PER_1M = 0.042;

/**
 * Compute the estimated USD cost of one `/decide` call, or `undefined` when
 * the input token count is unknown — never `0`, which would misreport an
 * unmeasured call as a free one.
 */
export function computeTypesafeCostUsd(tokensIn: number | undefined): number | undefined {
  if (tokensIn === undefined) return undefined;
  const cost = (tokensIn / 1_000_000) * INPUT_RATE_USD_PER_1M;
  // Round to 8 decimal places — matches usage.incurred.cost_usd's NUMERIC(20,8).
  return Math.round(cost * 1e8) / 1e8;
}

export interface RecordTypesafeUsageParams {
  ownerDid: string;
  /**
   * Invoking app DID, when the call was delegated (#2202) - resolved the
   * same way `recordInferenceUsage`'s `agentDid` is, via
   * `resolveConnectorOwnerDid`'s `agentDid`. `undefined` for a direct call.
   */
  agentDid?: string;
  /** The resolved, versioned model id TypeSafe returned (e.g. `jev-1.13.0`). */
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  sessionId?: string;
  turnId?: string;
  /** Warp run id (#2204), forwarded via the `X-Imajin-Run` header when this session was spawned from one. */
  warpRunId?: string;
  /** Upstream request id (#2204 auditor chain view) — `x-typesafe-request-id` for this call. */
  externalId?: string;
}

/**
 * Record one `/typesafe/api/decide` call. Never throws — every failure is
 * caught and logged so a metering hiccup cannot turn a successful decision
 * into a failed request.
 */
export async function recordTypesafeUsage(params: RecordTypesafeUsageParams): Promise<void> {
  const { ownerDid, agentDid, model, tokensIn, tokensOut, sessionId, turnId, warpRunId, externalId } = params;
  const costUsd = computeTypesafeCostUsd(tokensIn);
  const connectorId = connectorRegistryId(ownerDid, 'typesafe');
  const quantity = tokensIn !== undefined && tokensOut !== undefined ? tokensIn + tokensOut : undefined;
  const resource = `model:typesafe/${model}`;

  try {
    const usageId = generateId('usage');

    await db.insert(usageIncurred).values({
      id: usageId,
      sessionId: sessionId ?? null,
      turnId: turnId ?? null,
      principalDid: ownerDid,
      agentDid: agentDid ?? null,
      source: 'typesafe-decide',
      resource,
      provider: 'typesafe',
      connectorId,
      model,
      tokensIn: tokensIn ?? null,
      tokensOut: tokensOut ?? null,
      costUsd: costUsd === undefined ? null : costUsd.toFixed(8),
      quantity: quantity === undefined ? null : quantity.toFixed(6),
      unit: quantity === undefined ? null : 'tokens',
      // No pay.transactions row for this emitter — TypeSafe usage carries no
      // spend-cap/brain coupling, so there is nothing to link back to.
      transactionId: null,
      externalId: externalId ?? null,
    });

    // Deliberately NOT awaited — the row above is already durably written,
    // so a slow/failed bus publish must never add latency to (or fail) an
    // already-served decision, same fail-open contract as the write itself.
    publishUsageIncurred({
      usageId,
      principalDid: ownerDid,
      resource,
      quantity,
      costUsd,
      source: 'typesafe-decide',
      sessionId,
      turnId,
      externalId,
      agentDid,
      warpRunId,
    }).catch((err: unknown) => {
      log.error(
        { err: String(err), usageId, ownerDid, resource },
        'typesafe usage.incurred bus publish failed — row already written',
      );
    });
  } catch (err) {
    log.error(
      { err: String(err), ownerDid, model, sessionId: sessionId ?? null, turnId: turnId ?? null },
      'typesafe usage ledger write failed — decide call already served to the caller',
    );
  }
}
