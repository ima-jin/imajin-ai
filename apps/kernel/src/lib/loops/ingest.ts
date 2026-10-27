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
import { rateLimit } from '@imajin/config';
import * as bus from '@imajin/bus';
import { verifyLoopPublisherSignature } from './verify-publisher-signature';
import { authorizeLoopPublisher } from './authorize-publisher';
import { isLoopLifecycleType, type LoopIngestRequest } from './types';
import { prepareLoopOutput, redactLoopEnvelope, reserveLoopOwnership } from './prepare-output';
import { isBoundedLoopJson, isLoopOutput, isWithinLoopMetadataBudget } from './output-validation';
import { redactLoopText } from './output-redaction';
import { canonicalize } from '@imajin/auth';
import { projectSurfaceLease, loopObservationId, type SurfaceConflict } from './surface-lease';
import { signSurfaceConflict } from './surface-conflict';
import { isStepEventType, validateStepPayload } from './step-types';

const log = createLogger('kernel:loops');

export type IngestLoopEventResult = { ok: true } | { ok: false; error: string; status: number; code?: string };

export async function ingestLoopEvent(request: LoopIngestRequest): Promise<IngestLoopEventResult> {
  const { type, payload, publisherDid, signature } = request;

  const verification = await verifyLoopPublisherSignature(publisherDid, { type, payload }, signature);
  if (!verification.ok) {
    log.warn({ type, loopId: redactLoopText(payload.loopId), publisherDid: redactLoopText(publisherDid) }, 'loop event signature rejected');
    return { ok: false, error: verification.error, status: 400 };
  }
  const validation = validateLoopFacts(request);
  if (!validation.ok) return validation;
  const sanitized = validation.payload;

  // #2358: a valid signature only proves publisherDid controls its own key —
  // it says nothing about whether publisherDid may write history for
  // payload.principal. Logged with DIDs only, never the envelope payload
  // (summary/refs/etc. may carry operator-authored free text).
  const authorization = await authorizeLoopPublisher(publisherDid, payload.principal);
  if (!authorization.authorized) {
    warnUnauthorizedPublisher(publisherDid, payload.principal);
    return {
      ok: false,
      error: 'publisherDid is not authorized to publish loop history for principal',
      status: 403,
      code: 'loop_publisher_unauthorized',
    };
  }

  try {
    if (isLoopLifecycleType(type) && !await reserveLoopOwnership(type, sanitized)) {
      return { ok: false, error: 'Loop belongs to a different principal', status: 409, code: 'loop_owner_conflict' };
    }
    const persistedPayload = await prepareLoopOutput(sanitized);
    const historyPayload = { ...persistedPayload };
    delete historyPayload.publisherProof;
    const canKeepProof = persistedPayload === sanitized && canonicalize(payload) === canonicalize(sanitized);
    // Step facts and manual attestations must retain exact signed evidence.
    if (isStepEventType(type) && !canKeepProof) {
      return { ok: false, error: 'Step observations must contain only inline, credential-free facts', status: 400 };
    }
    const publishedPayload = {
      ...historyPayload,
      ...(canKeepProof ? { publisherProof: { type, payload, publisherDid, signature } } : {}),
    };
    const conflictingLoopId = isStepEventType(type) ? null : await projectSurfaceLease(request, publishedPayload, canKeepProof);
    await bus.publish(type, {
      id: loopObservationId(request),
      issuer: publisherDid,
      subject: sanitized.principal,
      scope: 'loop',
      // Never reintroduce credentials or spilled output through lease evidence.
      payload: publishedPayload,
      correlationId: sanitized.loopId,
    });
    if (conflictingLoopId) {
      await observeSurfaceConflict(request, conflictingLoopId);
    }
  } catch (err) {
    if (isOwnershipConflict(err)) {
      return { ok: false, error: 'Loop belongs to a different principal', status: 409, code: 'loop_owner_conflict' };
    }
    // Driver and reactor errors can embed query parameters or entire payloads.
    log.error({ type }, 'loop event publish failed');
    return { ok: false, error: 'Failed to publish loop event', status: 500 };
  }

  log.info({ type, loopId: sanitized.loopId, kind: sanitized.kind, principal: sanitized.principal }, 'loop event ingested');
  return { ok: true };
}

function warnUnauthorizedPublisher(publisherDid: string, principal: string): void {
  const warningKey = `loops:publisher-unauthorized:${JSON.stringify([publisherDid, principal])}`;
  if (!rateLimit(warningKey, 1, 60 * 60 * 1000).limited) {
    log.warn({ publisherDid: redactLoopText(publisherDid), principal: redactLoopText(principal) }, 'loop event publisher not authorized for principal');
  }
}

function validateLoopFacts(request: LoopIngestRequest):
  { ok: true; payload: LoopIngestRequest['payload'] } | { ok: false; error: string; status: number } {
  const { type, payload, publisherDid } = request;
  if (isStepEventType(type) && !validateStepPayload(type, payload, publisherDid)) {
    return { ok: false, error: 'Invalid step observation', status: 400 };
  }
  if (!isBoundedLoopJson(payload) || !isWithinLoopMetadataBudget(payload) || (payload.output !== undefined && !isLoopOutput(payload.output))) {
    return { ok: false, error: 'Invalid loop output', status: 400 };
  }
  const sanitized = redactLoopEnvelope(payload);
  if (!isWithinLoopMetadataBudget(sanitized)) {
    return { ok: false, error: 'Redacted loop metadata exceeds 16 KiB', status: 400 };
  }
  if (!hasStableLoopIdentity(request, sanitized)) {
    return { ok: false, error: 'Loop identity fields must not contain credentials', status: 400 };
  }
  return { ok: true, payload: sanitized };
}

/** A collision is data, never a dispatch denial or harness call. */
async function observeSurfaceConflict(request: LoopIngestRequest, conflictingLoopId: SurfaceConflict): Promise<void> {
  try {
    const conflict = await ingestLoopEvent(signSurfaceConflict(request, conflictingLoopId));
    if (!conflict.ok) log.warn({ loopId: request.payload.loopId }, 'surface conflict observation rejected');
  } catch {
    log.warn({ loopId: request.payload.loopId }, 'surface conflict observation failed (warning only)');
  }
}
function isOwnershipConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'loop_owner_conflict';
}

function hasStableLoopIdentity(request: LoopIngestRequest, sanitized: LoopIngestRequest['payload']): boolean {
  const bindings = ['loopId', 'principal', 'parentLoopId', 'surface'] as const;
  return bindings.every(field => sanitized[field] === request.payload[field])
    && redactLoopText(request.publisherDid) === request.publisherDid;
}
