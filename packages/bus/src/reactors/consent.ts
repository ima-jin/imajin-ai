import { createLogger } from '@imajin/logger';
import type { BrokerPipelineState, BrokerRejection, BrokerReactor } from '../types';
import { resolveConsent, getDefaultRejectionReason } from '../broker-config';

const log = createLogger('bus:broker:consent');

/**
 * Consent reactor — resolves consent for the broker request.
 *
 * Looks up the hardcoded consent configuration for {subject, requester, purpose}.
 * Composes multiple overlapping grants permissively (union of fields).
 * Fail-closed: no matching config → rejection with 'no_consent'.
 */
export const consentReactor: BrokerReactor = async (state) => {
  const { request } = state;

  log.info(
    { subject: request.subject, requester: request.requester, purpose: request.purpose },
    'Resolving consent'
  );

  const resolved = resolveConsent(request.subject, request.requester, request.purpose);

  if (!resolved) {
    log.warn(
      { subject: request.subject, requester: request.requester, purpose: request.purpose },
      'No consent found — rejecting (fail-closed)'
    );

    const rejection: BrokerRejection = {
      status: 'rejected',
      reason: getDefaultRejectionReason(),
      fields: request.fields,
      details: `No consent found for subject=${request.subject}, requester=${request.requester}, purpose=${request.purpose}`,
    };

    return rejection;
  }

  log.info(
    { allowedFields: resolved.allowedFields, mode: resolved.mode, consentRef: resolved.consentRef },
    'Consent resolved'
  );

  return {
    ...state,
    allowedFields: resolved.allowedFields,
    mode: resolved.mode,
    consentReference: resolved.consentRef,
  };
};
