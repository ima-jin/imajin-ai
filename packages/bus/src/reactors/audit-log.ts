import { randomUUID } from 'node:crypto';
import { createLogger } from '@imajin/logger';
import type { ReactorHandler } from '../types';

const log = createLogger('bus:audit-log');

/**
 * #1140 — generic, vertical-agnostic durable audit-log reactor.
 *
 * Listing `{ type: 'audit-log', await: false }` in any bus_chain_configs.reactors[]
 * leaves one queryable row in kernel.audit_log per matching event. No per-vertical
 * code and no replay logic (replay is a later bolt-on; capturing the record now is
 * what enables it).
 *
 * Config-driven projection keeps sensitive envelope contents out of the trail:
 *   - config.fields: string[]  → capture only these payload keys.
 *   - config.payload === false → store no payload (null).
 *   - otherwise                → store the whole payload.
 *
 * A `preview` payload flag (event.payload.preview === true) skips the write, mirroring
 * the broker audit reactor's preview-skip — the generic BusEvent has no dedicated
 * preview flag.
 *
 * Raw SQL via @imajin/db — packages/bus must not import apps/kernel (see AGENTS.md).
 * Never throws: a fire-and-forget write failure is logged, not propagated.
 */
export const auditLogReactor: ReactorHandler = async (event, config) => {
  const payload: Record<string, unknown> = event.payload ?? {};

  // Preview guard: dry-run events must not leave a durable record.
  if (payload.preview === true) {
    log.info({ event: event.type }, 'Audit-log skipped (preview)');
    return;
  }

  const projected = projectPayload(payload, config);

  try {
    const { getClient } = await import('@imajin/db');
    const sql = getClient();
    const id = randomUUID();

    await sql`
      INSERT INTO kernel.audit_log
        (id, event_type, scope, issuer, subject, correlation_id, payload, reactor_config)
      VALUES
        (${id}, ${event.type}, ${event.scope}, ${event.issuer}, ${event.subject},
         ${event.correlationId ?? null},
         ${projected === null ? null : JSON.stringify(projected)}::jsonb,
         ${JSON.stringify(config ?? {})}::jsonb)
    `;
  } catch (err: unknown) {
    log.error({ err: String(err), event: event.type }, 'audit_log DB write failed');
  }
};

/**
 * Resolve the payload projection from the reactor config.
 * Returns `null` to signal "store no payload".
 */
function projectPayload(
  payload: Record<string, unknown>,
  config: Record<string, unknown>,
): Record<string, unknown> | null {
  if (config?.payload === false) return null;

  const { fields } = config ?? {};
  if (Array.isArray(fields)) {
    const projected: Record<string, unknown> = {};
    for (const key of fields) {
      if (typeof key === 'string' && key in payload) {
        projected[key] = payload[key];
      }
    }
    return projected;
  }

  return payload;
}
