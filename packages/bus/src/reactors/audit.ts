import { randomUUID } from 'node:crypto';
import { createLogger } from '@imajin/logger';
import { publish } from '../publish';
import type { BrokerPipelineState, BrokerReactor, BrokerResult } from '../types';

const log = createLogger('bus:broker:audit');

/**
 * Write a row to kernel.broker_audit_log (fire-and-forget).
 * Uses the same dynamic @imajin/db import pattern as packages/bus/src/config.ts.
 */
async function writeAuditLogRow(row: {
  type: 'release' | 'rejection';
  requester: string;
  subject: string;
  purpose: string;
  scope: string;
  fieldsRequested: string[];
  fieldsReleased: string[] | null;
  status: 'RELEASED' | 'DENIED';
  mode: string | null;
  consentRef: string | null;
  reason: string | null;
  shadow: boolean;
}): Promise<void> {
  try {
    const { getClient } = await import('@imajin/db');
    const sql = getClient();
    const id = randomUUID();
    await sql`
      INSERT INTO kernel.broker_audit_log
        (id, type, requester, subject, purpose, scope,
         fields_requested, fields_released, status, mode, consent_ref, reason, shadow)
      VALUES
        (${id}, ${row.type}, ${row.requester}, ${row.subject}, ${row.purpose}, ${row.scope},
         ${row.fieldsRequested}, ${row.fieldsReleased ?? null}, ${row.status},
         ${row.mode ?? null}, ${row.consentRef ?? null}, ${row.reason ?? null}, ${row.shadow})
    `;
  } catch (err: unknown) {
    log.error({ err: String(err) }, 'broker_audit_log DB write failed');
  }
}

/**
 * Audit reactor — fires a broker.release or broker.rejection event.
 *
 * Uses publish() fire-and-forget semantics.
 * Skipped entirely when request.preview === true.
 */
export const auditReactor: BrokerReactor = async (state) => {
  const { request, envelope, filteredData } = state;
  const shadow = request.mode === 'shadow';

  if (request.preview) {
    log.info({ preview: true }, 'Audit skipped (preview mode)');
    return state;
  }

  if (!envelope) {
    log.error({}, 'Audit reactor called without envelope');
    throw new Error('Audit reactor: envelope missing');
  }

  log.info({ releaseId: envelope.releaseId }, 'Firing broker.release audit event');

  // Persist to queryable audit log (fire-and-forget).
  writeAuditLogRow({
    type: 'release',
    requester: request.requester,
    subject: request.subject,
    purpose: request.purpose,
    scope: request.scope,
    fieldsRequested: request.fields,
    fieldsReleased: Object.keys(filteredData || {}),
    status: 'RELEASED',
    mode: envelope.mode,
    consentRef: envelope.consentReference ?? null,
    reason: null,
    shadow,
  }).catch((err: unknown) => {
    log.error({ err: String(err) }, 'writeAuditLogRow (release) failed');
  });

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

  // Persist to queryable audit log (fire-and-forget).
  writeAuditLogRow({
    type: 'rejection',
    requester: request.requester,
    subject: request.subject,
    purpose: request.purpose,
    scope: request.scope,
    fieldsRequested: request.fields,
    fieldsReleased: null,
    status: 'DENIED',
    mode: null,
    consentRef: null,
    reason: result.reason,
    shadow: request.mode === 'shadow',
  }).catch((err: unknown) => {
    log.error({ err: String(err) }, 'writeAuditLogRow (rejection) failed');
  });

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
