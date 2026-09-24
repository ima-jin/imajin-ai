/**
 * Kernel loop registry ingest (#2295, epic #2288/#2290).
 *
 * Verifies the publisher's DID signature, then confirms the publisher is
 * actually authorized to write history for the claimed `payload.principal`
 * (#2358 — `authorizeLoopPublisher`: self-attestation, the kernel's own
 * node-witness DID (#2338), or an active `loops:publish` delegation grant
 * from that principal), then publishes the verified envelope onto the bus
 * as the requested `loop.*` lifecycle type. The bus chain config for every
 * `loop.*` type (packages/bus/src/config.ts, migrations/0157_loops_rail.sql)
 * runs the `loop-projection` reactor (awaited) + `emit` — by the time this
 * function returns `ok: true`, `kernel.loops`/`kernel.loop_events` are
 * durable (read-after-write for a caller that lists immediately after
 * ingesting).
 *
 * A forged/unsigned event, or one whose signature is valid but whose
 * publisher has no authority over the claimed principal, never reaches
 * `bus.publish` at all — both checks fail closed ahead of it, so nothing is
 * written for a rejected event.
 */
import { createLogger } from '@imajin/logger';
import * as bus from '@imajin/bus';
import { verifyLoopPublisherSignature } from './verify-publisher-signature';
import { authorizeLoopPublisher } from './authorize-publisher';
import type { LoopIngestRequest } from './types';

const log = createLogger('kernel:loops');

export type IngestLoopEventResult = { ok: true } | { ok: false; error: string; status: number; code?: string };

export async function ingestLoopEvent(request: LoopIngestRequest): Promise<IngestLoopEventResult> {
  const { type, payload, publisherDid, signature } = request;

  const verification = await verifyLoopPublisherSignature(publisherDid, { type, payload }, signature);
  if (!verification.ok) {
    log.warn({ type, loopId: payload.loopId, publisherDid, reason: verification.error }, 'loop event signature rejected');
    return { ok: false, error: verification.error, status: 400 };
  }

  // #2358: a valid signature only proves publisherDid controls its own key —
  // it says nothing about whether publisherDid may write history for
  // payload.principal. Logged with DIDs only, never the envelope payload
  // (summary/refs/etc. may carry operator-authored free text).
  const authorization = await authorizeLoopPublisher(publisherDid, payload.principal);
  if (!authorization.authorized) {
    log.warn({ publisherDid, principal: payload.principal }, 'loop event publisher not authorized for principal');
    return {
      ok: false,
      error: 'publisherDid is not authorized to publish loop history for principal',
      status: 403,
      code: 'loop_publisher_unauthorized',
    };
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
