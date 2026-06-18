import { createLogger } from '@imajin/logger';
import type { BrokerReactor } from '../types';
import { makeRejection } from './rejection';

const log = createLogger('bus:broker:intersection-scope');

/**
 * Intersection-scope reactor — replaces flat-field scope in the
 * `availability.match` broker chain.
 *
 * Reads the pre-computed overlap from request.data (injected by the engine)
 * and packages it as filteredData for the release reactor to envelope.
 *
 * If there is somehow no overlap (should have been caught before calling broker,
 * but fail-closed here too), rejects.
 *
 * Data contract (injected by engine into request.data):
 *   overlapTags        string[]   — pre-computed tag set-AND
 *   isSensitive        boolean    — OR-sensitivity rule applied by engine
 *   deliveryPolicy     string     — 'named_nudge' | 'staged' | 'sensitive_staged'
 *   arriverIntentId    string
 *   candidateIntentId  string
 */
export const intersectionScopeReactor: BrokerReactor = async (state) => {
  const { request } = state;
  const data: Record<string, unknown> = request.data ?? {};

  const overlapTags: string[] = Array.isArray(data.overlapTags)
    ? data.overlapTags.filter((t): t is string => typeof t === 'string')
    : [];

  log.info(
    { requester: request.requester, subject: request.subject, overlapTags },
    'Applying intersection scope'
  );

  if (overlapTags.length === 0) {
    log.warn(
      { requester: request.requester, subject: request.subject },
      'No overlap tags in intersection-scope — rejecting'
    );
    return makeRejection(request.fields, 'no_consent', 'No overlapping tags between intent pair');
  }

  log.info(
    { overlapTags, isSensitive: data.isSensitive },
    'Intersection scope resolved'
  );

  return {
    ...state,
    filteredData: {
      overlap_tags: overlapTags,
      is_sensitive: data.isSensitive === true,
      delivery_policy: typeof data.deliveryPolicy === 'string' ? data.deliveryPolicy : 'staged',
      arriver_intent_id: typeof data.arriverIntentId === 'string' ? data.arriverIntentId : '',
      candidate_intent_id: typeof data.candidateIntentId === 'string' ? data.candidateIntentId : '',
    },
  };
};
