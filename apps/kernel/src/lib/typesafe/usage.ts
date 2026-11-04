/**
 * TypeSafe.ai (Jev) usage metering (#2197; receipt projection migration #3261).
 *
 * Publishes one signed `usage.incurred` receipt per `/decide` call.
 * The bus usage-projection reactor materializes the row from that payload
 * alone. TypeSafe is metering-only: no balance debit, spend-cap, or brain
 * coupling. The receipt carries that policy and all projection fields.
 *
 * Fails open, mirroring `recordInferenceUsage`: a metering failure must
 * never turn a successful `/decide` call into a 500 for the caller.
 */
import { createLogger } from '@imajin/logger';
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
export function recordTypesafeUsage(params: RecordTypesafeUsageParams): Promise<void> {
  const { ownerDid, agentDid, model, tokensIn, tokensOut, sessionId, turnId, warpRunId, externalId } = params;

  try {
    const costUsd = computeTypesafeCostUsd(tokensIn);
    const connectorId = connectorRegistryId(ownerDid, 'typesafe');
    const quantity = tokensIn !== undefined && tokensOut !== undefined ? tokensIn + tokensOut : undefined;
    const resource = `model:typesafe/${model}`;
    const usageId = generateId('usage');

    // Fire-and-forget preserves /decide latency and fail-open behavior.
    // The signed receipt is the only source; there is no direct DB fallback.
    publishUsageIncurred({
      usageId,
      principalDid: ownerDid,
      resource,
      quantity,
      costUsd,
      source: 'typesafe-decide',
      provider: 'typesafe',
      connectorId,
      model,
      tokensIn,
      tokensOut,
      metadata: { meteringOnly: true },
      sessionId,
      turnId,
      externalId,
      agentDid,
      warpRunId,
    }).catch((err: unknown) => {
      log.error(
        { err: String(err), usageId, ownerDid, resource },
        'typesafe usage.incurred receipt publish failed — decide call already served',
      );
    });
  } catch (err) {
    log.error(
      { err: String(err), ownerDid, model, sessionId: sessionId ?? null, turnId: turnId ?? null },
      'typesafe usage ledger write failed — decide call already served to the caller',
    );
  }
  return Promise.resolve();
}
