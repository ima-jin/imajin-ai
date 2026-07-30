import { randomUUID } from 'node:crypto';
import { createLogger } from '@imajin/logger';
import { emitAttestation } from '@imajin/auth';
import type { BrokerRelease, BrokerReactor } from '../types';

const log = createLogger('bus:broker:release');

/**
 * Mint the signed claim for an attestation-mode release (#1508).
 *
 * Bridges the broker's release step to the platform's existing attestation
 * reactor (`emitAttestation` / `@imajin/auth`): the partner already had the
 * raw value withheld (unchanged); this hands them a verifiable signed claim
 * instead, tied to the consent grant and this specific releaseId.
 *
 * The payload intentionally carries field NAMES only, never the underlying
 * values — attestation mode must never leak the raw data through a side
 * channel. Never throws: emitAttestation() already swallows its own errors,
 * and a failure here must not fail the release itself.
 */
async function emitReleaseAttestation(
  envelope: BrokerRelease['envelope'],
  filteredData: Record<string, unknown>,
  request: { requester: string; subject: string; purpose: string; scope: string }
): Promise<void> {
  try {
    await emitAttestation({
      issuer_did: request.subject,
      subject_did: request.subject,
      type: 'broker.release',
      context_id: envelope.releaseId,
      context_type: 'broker',
      payload: {
        requester: request.requester,
        purpose: request.purpose,
        scope: request.scope,
        fields: Object.keys(filteredData),
        consentReference: envelope.consentReference,
      },
    });
  } catch (err) {
    log.error(
      { err: String(err), releaseId: envelope.releaseId },
      'emitAttestation (broker.release) failed'
    );
  }
}

/**
 * Release reactor — constructs the release envelope.
 *
 * Wraps the filtered data in a release envelope containing:
 * - releaseId: unique ID for this release
 * - scopeId: scope reference from the request
 * - purpose: declared purpose
 * - issuedAt: ISO 8601 timestamp
 * - consentReference: reference to the consent grant
 * - mode: 'attestation' or 'raw'
 *
 * When mode === 'attestation', also mints a signed claim via emitAttestation()
 * referencing the consent grant + releaseId (#1508) — the raw-mode path is
 * unchanged.
 */
export const releaseReactor: BrokerReactor = async (state) => {
  const { request, filteredData, mode, consentReference } = state;

  if (!filteredData) {
    log.error({}, 'Release reactor called without filtered data');
    throw new Error('Release reactor: filteredData missing');
  }

  if (!mode || !consentReference) {
    log.error({}, 'Release reactor called without resolved consent metadata');
    throw new Error('Release reactor: consent metadata missing');
  }

  const envelope: BrokerRelease['envelope'] = {
    releaseId: randomUUID(),
    scopeId: request.scope,
    purpose: request.purpose,
    issuedAt: new Date().toISOString(),
    consentReference,
    mode,
  };

  log.info(
    { releaseId: envelope.releaseId, mode, fields: Object.keys(filteredData) },
    'Release envelope constructed'
  );

  if (mode === 'attestation') {
    await emitReleaseAttestation(envelope, filteredData, request);
  }

  return {
    ...state,
    envelope,
  };
};
