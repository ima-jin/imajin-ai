import { createLogger } from '@imajin/logger';
import type { BrokerRejection, BrokerReactor } from '../types';

const log = createLogger('bus:broker:mutual-reach-consent');

/**
 * Mutual-reach consent reactor — replaces named-grantee consent in the
 * `availability.match` broker chain.
 *
 * The engine resolves reach rings before calling broker() and injects the
 * results into `request.data`. This reactor reads those pre-computed flags
 * and either grants consent (both admit each other) or rejects (fail-closed).
 *
 * Why pre-compute in the engine rather than here?
 * - The engine already has both intents' reach values and the resolved ring sets.
 * - Reach resolution requires a DB query; running it per-reactor would repeat it
 *   once per candidate. The engine computes the arriver's rings once and reuses them.
 * - This reactor stays stateless and testable with plain data.
 *
 * Data contract (injected by the engine into request.data):
 *   arriverAdmitsCandidate  boolean  — arriver's reach ring contains candidate's DID
 *   candidateAdmitsArriver  boolean  — candidate's reach ring contains arriver's DID
 *   arriverIntentId         string
 *   candidateIntentId       string
 */
export const mutualReachConsentReactor: BrokerReactor = async (state) => {
  const { request } = state;
  const data = (request.data ?? {}) as Record<string, unknown>;

  const arriverAdmitsCandidate = data.arriverAdmitsCandidate === true;
  const candidateAdmitsArriver = data.candidateAdmitsArriver === true;

  log.info(
    {
      requester: request.requester,
      subject: request.subject,
      arriverAdmitsCandidate,
      candidateAdmitsArriver,
    },
    'Resolving mutual reach consent'
  );

  if (!arriverAdmitsCandidate || !candidateAdmitsArriver) {
    const reason = !arriverAdmitsCandidate
      ? 'arriver reach does not admit candidate'
      : 'candidate reach does not admit arriver';

    log.warn(
      { requester: request.requester, subject: request.subject, reason },
      'Mutual reach check failed — rejecting (fail-closed)'
    );

    const rejection: BrokerRejection = {
      status: 'rejected',
      reason: 'no_consent',
      fields: request.fields,
      details: `Mutual reach not satisfied: ${reason}`,
    };
    return rejection;
  }

  const intentA = String(data.arriverIntentId ?? '');
  const intentB = String(data.candidateIntentId ?? '');

  log.info(
    { requester: request.requester, subject: request.subject },
    'Mutual reach consent granted'
  );

  return {
    ...state,
    allowedFields: ['overlap_tags'],
    mode: 'attestation' as const,
    consentReference: `mutual-reach:${intentA}:${intentB}`,
  };
};
