import { createLogger } from '@imajin/logger';
import type { BrokerRejection, BrokerReactor } from '../types';

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
  const data = (request.data ?? {}) as Record<string, unknown>;

  const overlapTags = Array.isArray(data.overlapTags) ? (data.overlapTags as string[]) : [];

  log.info(
    { requester: request.requester, subject: request.subject, overlapTags },
    'Applying intersection scope'
  );

  if (overlapTags.length === 0) {
    log.warn(
      { requester: request.requester, subject: request.subject },
      'No overlap tags in intersection-scope — rejecting'
    );
    const rejection: BrokerRejection = {
      status: 'rejected',
      reason: 'no_consent',
      fields: request.fields,
      details: 'No overlapping tags between intent pair',
    };
    return rejection;
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
      delivery_policy: String(data.deliveryPolicy ?? 'staged'),
      arriver_intent_id: String(data.arriverIntentId ?? ''),
      candidate_intent_id: String(data.candidateIntentId ?? ''),
    },
  };
};
