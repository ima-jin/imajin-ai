import { createLogger } from '@imajin/logger';
import { publish } from '../publish';
import type { BrokerPipelineState, BrokerReactor, BrokerResult } from '../types';

const log = createLogger('bus:broker:audit');

/**
 * Audit reactor — fires a broker.release or broker.rejection event.
 *
 * Uses publish() fire-and-forget semantics.
 * Skipped entirely when request.preview === true.
 */
export const auditReactor: BrokerReactor = async (state) => {
  const { request, envelope, filteredData } = state;

  if (request.preview) {
    log.info({ preview: true }, 'Audit skipped (preview mode)');
    return state;
  }

  if (!envelope) {
    log.error({}, 'Audit reactor called without envelope');
    throw new Error('Audit reactor: envelope missing');
  }

  log.info({ releaseId: envelope.releaseId }, 'Firing broker.release audit event');

  publish('broker.release', {
    issuer: request.requester,
    subject: request.subject,
    scope: request.scope,
    payload: {
      releaseId: envelope.releaseId,
      requester: request.requester,
      subject: request.subject,
      fields: Object.keys(filteredData || {}),
      purpose: request.purpose,
      scope: request.scope,
      mode: envelope.mode,
      issuedAt: envelope.issuedAt,
    },
  }).catch((err: unknown) => {
    log.error({ err: String(err), releaseId: envelope.releaseId }, 'Audit publish failed');
  });

  return state;
};

/**
 * Fire a rejection audit event.
 *
 * This is called by the broker orchestrator when a reactor returns a rejection.
 * Skipped in preview mode.
 */
export async function auditRejection(
  request: BrokerPipelineState['request'],
  result: Extract<BrokerResult, { status: 'rejected' }>
): Promise<void> {
  if (request.preview) {
    log.info({ preview: true }, 'Audit rejection skipped (preview mode)');
    return;
  }

  log.info({ reason: result.reason }, 'Firing broker.rejection audit event');

  publish('broker.rejection', {
    issuer: request.requester,
    subject: request.subject,
    scope: request.scope,
    payload: {
      requester: request.requester,
      subject: request.subject,
      fields: result.fields || request.fields,
      purpose: request.purpose,
      scope: request.scope,
      reason: result.reason,
      details: result.details,
    },
  }).catch((err: unknown) => {
    log.error({ err: String(err), reason: result.reason }, 'Audit rejection publish failed');
  });
}
