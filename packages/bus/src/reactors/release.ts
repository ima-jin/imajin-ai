import { randomUUID } from 'node:crypto';
import { createLogger } from '@imajin/logger';
import type { BrokerPipelineState, BrokerRelease, BrokerReactor } from '../types';

const log = createLogger('bus:broker:release');

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

  return {
    ...state,
    envelope,
  };
};
