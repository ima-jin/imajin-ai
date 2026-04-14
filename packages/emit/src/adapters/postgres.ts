import { getClient } from '@imajin/db';
import { createLogger } from '@imajin/logger';
import type { SystemEvent, EventAdapter } from '../index';

const log = createLogger('events');

const BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 100;

const buffer: SystemEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushBuffer().catch(() => {});
  }, FLUSH_INTERVAL_MS);
}

async function flushBuffer(): Promise<void> {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);
  try {
    const sql = getClient();
    const rows = batch.map((e) => ({
      service: e.service,
      action: e.action,
      did: e.did ?? null,
      correlation_id: e.correlationId ?? null,
      parent_event_id: e.parentEventId ?? null,
      payload: e.payload ? JSON.stringify(e.payload) : null,
      status: e.status ?? 'success',
      duration_ms: e.durationMs ?? null,
    }));

    await sql`
      INSERT INTO registry.system_events
        (service, action, did, correlation_id, parent_event_id, payload, status, duration_ms)
      SELECT
        r.service, r.action, r.did, r.correlation_id, r.parent_event_id,
        r.payload::jsonb, r.status, r.duration_ms
      FROM json_to_recordset(${JSON.stringify(rows)}::json) AS r(
        service text,
        action text,
        did text,
        correlation_id text,
        parent_event_id text,
        payload text,
        status text,
        duration_ms integer
      )
    `;
  } catch (err) {
    log.warn({ service: 'events', error: String(err) }, 'Failed to flush system_events batch');
  }
}

export const postgresAdapter: EventAdapter = {
  emit(event: SystemEvent): void {
    buffer.push(event);
    if (buffer.length >= BATCH_SIZE) {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushBuffer().catch(() => {});
    } else {
      scheduleFlush();
    }
  },
};
