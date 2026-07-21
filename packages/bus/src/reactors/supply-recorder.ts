import { createLogger } from '@imajin/logger';
import type { ReactorHandler } from '../types';

const log = createLogger('bus:supply-recorder');

const SUPPLY_PREFIX = 'supply.';
const ORDER_COMPLETED = 'order.completed';

/**
 * #1136 — persists the otherwise-ephemeral correlationId into a queryable lot +
 * stage history. On each supply.* event it gets-or-creates the lot (keyed by
 * correlationId), appends a stage row, and advances lot status on supply.listed.
 *
 * #1375 — also handles order.completed (scope=supply): appends the `settled`
 * stage row with prior_cid chaining (resolved from the most recent stage in the
 * lot's history) and flips lot status to `settled`. Idempotent: a replayed
 * order.completed on an already-settled lot is a no-op.
 *
 * Raw SQL via @imajin/db — packages/bus must not import apps/kernel. Wired as an
 * awaited reactor so the row is durable before publish() returns (read-after-write
 * for the #1135 GET /api/supply/lot/[correlationId] route).
 */
export const supplyRecorderReactor: ReactorHandler = async (event) => {
  const isSupplyEvent = event.type.startsWith(SUPPLY_PREFIX);
  const isSettlement = event.type === ORDER_COMPLETED && event.scope === 'supply';

  if (!isSupplyEvent && !isSettlement) {
    return;
  }

  const { correlationId } = event;
  if (!correlationId) {
    log.warn({ event: event.type }, 'supply event without correlationId; skipping lot/stage recording');
    return;
  }

  const payload: Record<string, unknown> = event.payload ?? {};
  const commodity = typeof payload.commodity === 'string' ? payload.commodity : null;

  const { getClient } = await import('@imajin/db');
  const sql = getClient();

  if (isSettlement) {
    // Idempotency: a replayed order.completed on an already-settled lot is a no-op.
    const settled = (await sql`
      SELECT 1 FROM kernel.supply_lots
      WHERE correlation_id = ${correlationId} AND status = 'settled'
      LIMIT 1
    `) as unknown[];
    if (settled.length > 0) {
      log.info({ correlationId }, 'lot already settled; skipping duplicate settle');
      return;
    }

    // Resolve prior_cid from the most recent stage so the settled row links the chain.
    const priorRows = (await sql`
      SELECT attestation_cid AS "attestationCid", id
      FROM kernel.supply_stages
      WHERE correlation_id = ${correlationId}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `) as unknown as Array<{ attestationCid: string | null; id: string }>;
    const lastStage = priorRows[0] ?? null;
    const resolvedPriorCid = lastStage?.attestationCid ?? lastStage?.id ?? null;

    // Get-or-create the lot (defensive — it should exist from supply.declared onward).
    await sql`
      INSERT INTO kernel.supply_lots (correlation_id, originating_did, commodity, status)
      VALUES (${correlationId}, ${event.issuer}, ${commodity}, 'open')
      ON CONFLICT (correlation_id) DO NOTHING
    `;

    const settledStage = 'settled' as const;
    await sql`
      INSERT INTO kernel.supply_stages (correlation_id, stage, actor_did, prior_cid, payload)
      VALUES (${correlationId}, ${settledStage}, ${event.issuer}, ${resolvedPriorCid}, ${JSON.stringify(payload)}::jsonb)
    `;

    await sql`
      UPDATE kernel.supply_lots
      SET status = 'settled', updated_at = now()
      WHERE correlation_id = ${correlationId}
    `;
    return;
  }

  // supply.* event: get-or-create the lot, append the stage row, advance status on listed.
  const priorCid = typeof payload.priorCid === 'string' ? payload.priorCid : null;

  // Get-or-create the lot first: it is the FK target for the stage row, and the
  // declared stage's actor + commodity seed the lot (ON CONFLICT keeps them).
  await sql`
    INSERT INTO kernel.supply_lots (correlation_id, originating_did, commodity, status)
    VALUES (${correlationId}, ${event.issuer}, ${commodity}, 'open')
    ON CONFLICT (correlation_id) DO NOTHING
  `;

  await sql`
    INSERT INTO kernel.supply_stages (correlation_id, stage, actor_did, prior_cid, payload)
    VALUES (${correlationId}, ${event.type.slice(SUPPLY_PREFIX.length)}, ${event.issuer}, ${priorCid}, ${JSON.stringify(payload)}::jsonb)
  `;

  if (event.type === 'supply.listed') {
    await sql`
      UPDATE kernel.supply_lots
      SET status = 'listed', updated_at = now()
      WHERE correlation_id = ${correlationId}
    `;
  }
};
