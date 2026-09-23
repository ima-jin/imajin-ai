/**
 * Kernel loop registry ingest (#2295, epic #2288/#2290).
 *
 * Verifies the publisher's DID signature, then publishes the verified
 * envelope onto the bus as the requested `loop.*` lifecycle type. The bus
 * chain config for every `loop.*` type (packages/bus/src/config.ts,
 * migrations/0157_loops_rail.sql) runs the `loop-projection` reactor
 * (awaited) + `emit` — by the time this function returns `ok: true`,
 * `kernel.loops`/`kernel.loop_events` are durable (read-after-write for a
 * caller that lists immediately after ingesting).
 *
 * A forged or unsigned event never reaches `bus.publish` at all — signature
 * verification happens first and fails closed, so nothing is written for a
 * rejected event.
 */
import { createLogger } from '@imajin/logger';
import * as bus from '@imajin/bus';
import { verifyLoopPublisherSignature } from './verify-publisher-signature';
import type { LoopIngestRequest } from './types';

const log = createLogger('kernel:loops');

export type IngestLoopEventResult = { ok: true } | { ok: false; error: string; status: number };

export async function ingestLoopEvent(request: LoopIngestRequest): Promise<IngestLoopEventResult> {
  const { type, payload, publisherDid, signature } = request;

  const verification = await verifyLoopPublisherSignature(publisherDid, { type, payload }, signature);
  if (!verification.ok) {
    log.warn({ type, loopId: payload.loopId, publisherDid, reason: verification.error }, 'loop event signature rejected');
    return { ok: false, error: verification.error, status: 400 };
  }

  try {
    await bus.publish(type, {
      issuer: publisherDid,
      subject: payload.principal,
      scope: 'loop',
      payload,
      correlationId: payload.loopId,
    });
  } catch (err) {
    log.error({ err: String(err), type, loopId: payload.loopId }, 'loop event publish failed');
    return { ok: false, error: 'Failed to publish loop event', status: 500 };
  }

  log.info({ type, loopId: payload.loopId, kind: payload.kind, principal: payload.principal }, 'loop event ingested');
  return { ok: true };
}
