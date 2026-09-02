/**
 * Per-turn metering ledger writer (#1923, Phase 3 of #1922).
 *
 * Called once per completions-passthrough call (`POST /infer/v1/chat/completions`,
 * #1925), regardless of adapter (Anthropic via the AI SDK, or the
 * OpenAI-compatible raw passthrough). Writes to three places, each owning a
 * distinct slice of the same event — see migrations/0119_usage_incurred.sql
 * for the full division-of-responsibility note:
 *
 *   usage.incurred      — the granular, token-level record. This module is
 *                         emitter #1 (#1147/#1148/#1151): every row carries
 *                         `source = 'inference-passthrough'` and
 *                         `resource = 'model:{provider}/{model}'`. Always
 *                         written, even when tokens/cost are unknown (a
 *                         degraded row beats a missing one — some providers
 *                         omit `usage` from their response despite it being
 *                         requested).
 *   pay.transactions    — the money, `service = 'inference'`. Only written
 *                         when a cost could be computed; there is no
 *                         meaningful amount to ledger otherwise.
 *   pay.balance_rollups — the daily aggregate burn-down, `service = 'inference'`,
 *                         updated the same way `webhook-handlers.ts`'s
 *                         `updateDailyRollup` does for earned amounts — this
 *                         is the `spent` column's counterpart.
 *
 * Fails open at the DB-write boundary (mirrors `connector-registry-store.ts`):
 * a metering failure must never turn a successful completion into a 500 for
 * the caller. It logs at `error` (not `warn`) because, unlike the shadow
 * registry, this write IS the deliverable — channel_links has no equivalent
 * authoritative fallback to fall back on.
 */
import { createLogger } from '@imajin/logger';
import { sql } from 'drizzle-orm';
import { publish } from '@imajin/bus';
import { db, usageIncurred, transactions, balanceRollups } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { getConnector } from '@/src/lib/kernel/connector-registry';
import { connectorRegistryId } from '@/src/lib/kernel/connector-registry-store';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { computeCostUsd } from './pricing';
import type { BrainConnectorId } from './brain';

const log = createLogger('kernel:inference:usage-ledger');

export interface RecordInferenceUsageParams {
  sessionId?: string;
  turnId?: string;
  /** Owner DID whose sealed connector card supplied the credential. */
  principalDid: string;
  /** Invoking app DID, when the call was made `onBehalfOf` a principal. */
  agentDid?: string;
  provider: BrainConnectorId;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
}

/**
 * Record one passthrough call. Never throws — every failure is caught and
 * logged so a metering hiccup cannot turn a successful completion into a
 * failed request.
 */
export async function recordInferenceUsage(params: RecordInferenceUsageParams): Promise<void> {
  const { sessionId, turnId, principalDid, agentDid, provider, model, tokensIn, tokensOut } = params;
  const connectorId = connectorRegistryId(principalDid, provider);
  const costUsd = computeCostUsd(provider, model, tokensIn, tokensOut);
  // #1148 emitter-agnostic quantity/unit: this emitter's resource is tokens,
  // so quantity is the total of both directions whenever both are known —
  // null (not 0) when either is unknown, same "don't fabricate a number"
  // rule tokensIn/tokensOut/costUsd already follow.
  const quantity = tokensIn !== undefined && tokensOut !== undefined ? tokensIn + tokensOut : undefined;
  const resource = `model:${provider}/${model}`;

  try {
    const usageId = generateId('usage');
    let transactionId: string | undefined;

    if (costUsd !== undefined && costUsd > 0) {
      transactionId = await recordSpend({ principalDid, provider, model, sessionId, turnId, connectorId, costUsd });
    }

    await db.insert(usageIncurred).values({
      id: usageId,
      sessionId: sessionId ?? null,
      turnId: turnId ?? null,
      principalDid,
      agentDid: agentDid ?? null,
      // #1147 emitter/resource discriminators. This module is always the same
      // emitter, writing the same resource shape — no per-call branching.
      source: 'inference-passthrough',
      resource,
      provider,
      connectorId,
      model,
      tokensIn: tokensIn ?? null,
      tokensOut: tokensOut ?? null,
      costUsd: costUsd === undefined ? null : costUsd.toFixed(8),
      quantity: quantity === undefined ? null : quantity.toFixed(6),
      unit: quantity === undefined ? null : 'tokens',
      transactionId: transactionId ?? null,
    });

    // #1148: publish the usage.incurred bus event — turns the row into a
    // signed system-class fact via the `attestation` + `emit` chain
    // (migrations/0120_usage_incurred_quantity.sql). Deliberately NOT
    // awaited: this is inside the hot completions-passthrough path and the
    // row is already durably written above, so a slow or failed bus publish
    // must never add latency to (or fail) an already-served completion —
    // same fail-open contract as the rest of this function.
    publishUsageIncurred({ usageId, principalDid, resource, quantity, costUsd, source: 'inference-passthrough' }).catch((err: unknown) => {
      log.error(
        { err: String(err), usageId, principalDid, resource },
        'usage.incurred bus publish failed — row already written',
      );
    });
  } catch (err) {
    log.error(
      { err: String(err), principalDid, provider, model, sessionId: sessionId ?? null, turnId: turnId ?? null },
      'inference usage ledger write failed — completion already served to the caller',
    );
  }
}

export interface PublishUsageIncurredParams {
  usageId: string;
  principalDid: string;
  resource: string;
  quantity: number | undefined;
  /** `null` when `quantity` is a raw count with no natural unit (e.g. inferred token sums default to `'tokens'` at the call site); explicit for every other emitter. */
  unit?: string;
  costUsd: number | undefined;
  /** Which emitter produced this row, e.g. `'inference-passthrough'` or an external `usage.emitters` `source` (#1151). */
  source: string;
}

/**
 * Publish the `usage.incurred` bus event for one written row (#1148).
 * `issuer` is this node's own DID (the meter/agent signing the fact);
 * `subject` is the principal the usage is attributed to — same
 * issuer/actingFor shape #1147 specifies for every emitter.
 *
 * Exported (#1151) so every emitter that writes a `usage.incurred` row — not
 * just this module's own completions passthrough — publishes through the
 * same chain/attestation contract rather than each hand-rolling its own
 * `publish('usage.incurred', ...)` call.
 */
export async function publishUsageIncurred(params: PublishUsageIncurredParams): Promise<void> {
  const { usageId, principalDid, resource, quantity, unit, costUsd, source } = params;
  const nodeDid = await getNodeDid();

  await publish('usage.incurred', {
    issuer: nodeDid,
    subject: principalDid,
    scope: 'usage',
    payload: {
      attestationClass: 'system',
      issuerDid: nodeDid,
      actingFor: principalDid,
      resource,
      quantity: quantity ?? null,
      unit: unit ?? (quantity === undefined ? null : 'tokens'),
      costEstimateUsd: costUsd ?? null,
      source,
      usageId,
      ts: new Date().toISOString(),
      context_id: usageId,
      context_type: 'usage',
    },
  });
}

interface RecordSpendParams {
  principalDid: string;
  provider: BrainConnectorId;
  model: string;
  sessionId?: string;
  turnId?: string;
  connectorId: string;
  costUsd: number;
}

/**
 * Write the money side of one call: a `pay.transactions` row plus the daily
 * `pay.balance_rollups` increment. Returns the transaction id so the caller
 * can link `usage.incurred.transaction_id` back to it.
 *
 * `toDid` is the connector's own DID (e.g. `did:imajin:xai-connector`) —
 * every brain connector is BYOK, so there is no real platform-side payee;
 * this only exists to satisfy `pay.transactions.to_did NOT NULL` with a
 * value that is at least meaningful (which provider the spend went to)
 * rather than an arbitrary placeholder.
 */
async function recordSpend(params: RecordSpendParams): Promise<string> {
  const { principalDid, provider, model, sessionId, turnId, connectorId, costUsd } = params;
  const toDid = getConnector(provider)?.connectorDid ?? `did:imajin:${provider}-connector`;
  const txId = generateId('tx');
  const amountStr = costUsd.toFixed(8);

  await db.insert(transactions).values({
    id: txId,
    service: 'inference',
    type: 'query',
    fromDid: principalDid,
    toDid,
    amount: amountStr,
    currency: 'USD',
    status: 'completed',
    source: 'credit',
    metadata: {
      provider,
      model,
      connectorId,
      ...(sessionId ? { sessionId } : {}),
      ...(turnId ? { turnId } : {}),
    },
  });

  await updateDailySpendRollup(principalDid, amountStr);

  return txId;
}

/** Daily `pay.balance_rollups` increment for `service = 'inference'` spend. */
async function updateDailySpendRollup(did: string, amountStr: string): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  await db
    .insert(balanceRollups)
    .values({
      did,
      date: today,
      service: 'inference',
      earned: '0',
      spent: amountStr,
      txCount: 1,
    })
    .onConflictDoUpdate({
      target: [balanceRollups.did, balanceRollups.date, balanceRollups.service],
      set: {
        spent: sql`${balanceRollups.spent} + ${amountStr}`,
        txCount: sql`${balanceRollups.txCount} + 1`,
      },
    });
}
