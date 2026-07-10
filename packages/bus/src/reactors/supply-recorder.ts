import { createLogger } from '@imajin/logger';
import type { ReactorHandler } from '../types';

const log = createLogger('bus:supply-recorder');

const SUPPLY_PREFIX = 'supply.';

/**
 * #1136 — persists the otherwise-ephemeral correlationId into a queryable lot +
 * stage history. On each supply.* event it gets-or-creates the lot (keyed by
 * correlationId), appends a stage row, and advances lot status on supply.listed.
 *
 * Raw SQL via @imajin/db — packages/bus must not import apps/kernel. Wired as an
 * awaited reactor so the row is durable before publish() returns (read-after-write
 * for the #1135 GET /api/supply/lot/[correlationId] route).
 */
export const supplyRecorderReactor: ReactorHandler = async (event) => {
  const { correlationId } = event;
  if (!correlationId) {
    log.warn({ event: event.type }, 'supply.* event without correlationId; skipping lot/stage recording');
    return;
  }

  const stage = event.type.startsWith(SUPPLY_PREFIX)
    ? event.type.slice(SUPPLY_PREFIX.length)
    : event.type;

  const payload: Record<string, unknown> = event.payload ?? {};
  const commodity = typeof payload.commodity === 'string' ? payload.commodity : null;
  const priorCid = typeof payload.priorCid === 'string' ? payload.priorCid : null;

  const { getClient } = await import('@imajin/db');
  const sql = getClient();

  // Get-or-create the lot first: it is the FK target for the stage row, and the
  // declared stage's actor + commodity seed the lot (ON CONFLICT keeps them).
  await sql`
    INSERT INTO kernel.supply_lots (correlation_id, originating_did, commodity, status)
    VALUES (${correlationId}, ${event.issuer}, ${commodity}, 'open')
    ON CONFLICT (correlation_id) DO NOTHING
  `;

  await sql`
    INSERT INTO kernel.supply_stages (correlation_id, stage, actor_did, prior_cid, payload)
    VALUES (${correlationId}, ${stage}, ${event.issuer}, ${priorCid}, ${JSON.stringify(payload)}::jsonb)
  `;

  // supply.listed advances the lot out of the default 'open' status. The paid
  // stage (settled) rides in on order.completed and is wired in a follow-up.
  if (event.type === 'supply.listed') {
    await sql`
      UPDATE kernel.supply_lots
      SET status = 'listed', updated_at = now()
      WHERE correlation_id = ${correlationId}
    `;
  }
};
