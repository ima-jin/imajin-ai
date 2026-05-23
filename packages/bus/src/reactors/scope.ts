import { createLogger } from '@imajin/logger';
import type { BrokerRejection, BrokerReactor } from '../types';

const log = createLogger('bus:broker:scope');

/**
 * Scope reactor — filters subject data to only consented fields.
 *
 * Intersects the requested fields with the consented fields.
 * Absent fields are omitted (not nulled).
 * If the intersection is empty → rejection with 'no_consent'.
 */
export const scopeReactor: BrokerReactor = async (state) => {
  const { request, allowedFields } = state;

  if (!allowedFields) {
    log.error({}, 'Scope reactor called without resolved consent');
    const rejection: BrokerRejection = {
      status: 'rejected',
      reason: 'no_consent',
      fields: request.fields,
      details: 'Consent not resolved before scope reactor',
    };
    return rejection;
  }

  // Intersect requested fields with consented fields
  const intersection = request.fields.filter((f) => allowedFields.includes(f));

  if (intersection.length === 0) {
    log.warn(
      { requested: request.fields, allowed: allowedFields },
      'No requested fields are consented — rejecting'
    );

    const rejection: BrokerRejection = {
      status: 'rejected',
      reason: 'no_consent',
      fields: request.fields,
      details: `None of the requested fields are consented. Allowed: [${allowedFields.join(', ')}]`,
    };

    return rejection;
  }

  // Filter data — only include consented fields that exist in the data
  const rawData = request.data || {};
  const filteredData: Record<string, unknown> = {};
  const missingFields: string[] = [];

  for (const field of intersection) {
    if (field in rawData) {
      filteredData[field] = rawData[field];
    } else {
      missingFields.push(field);
    }
  }

  if (missingFields.length > 0) {
    log.warn({ missingFields }, 'Some consented fields are absent from data');
  }

  log.info(
    { requested: request.fields, allowed: allowedFields, released: Object.keys(filteredData) },
    'Fields scoped'
  );

  return {
    ...state,
    filteredData,
  };
};
