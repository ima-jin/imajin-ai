import { createLogger } from '@imajin/logger';
import type { BrokerFieldReleaseMode, BrokerPredicateClaim, BrokerRejection, BrokerReactor } from '../types';
import { resolveBrokerPredicateClaimsForField } from '../predicate-claims';

const log = createLogger('bus:broker:scope');

/**
 * Scope reactor — filters subject data to only consented fields.
 *
 * Intersects the requested fields with the consented fields.
 * Absent fields are omitted (not nulled).
 * If the intersection is empty → rejection with 'no_consent'.
 */
export const scopeReactor: BrokerReactor = async (state) => {
  const { request, allowedFields, fieldGrants } = state;

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
  const allowedFieldSet = new Set(allowedFields);
  const intersection = request.fields.filter((f) => allowedFieldSet.has(f));

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
  const predicateClaims: BrokerPredicateClaim[] = [...(state.predicateClaims ?? [])];
  const predicateCacheWrites: BrokerPredicateClaim[] = [...(state.predicateCacheWrites ?? [])];

  const modeForField = (field: string): BrokerFieldReleaseMode => {
    const grant = fieldGrants?.[field];
    if (grant) return grant.mode;
    return state.mode === 'raw' ? 'raw' : 'attestation';
  };

  for (const field of intersection) {
    if (field in rawData) {
      const fieldMode = modeForField(field);
      if (fieldMode === 'raw') {
        filteredData[field] = rawData[field];
        continue;
      }

      const predicates = request.predicates?.[field];
      if (!predicates) {
        filteredData[field] = { attested: true };
        continue;
      }

      try {
        const { claims, cacheWrites } = await resolveBrokerPredicateClaimsForField({
          subject: request.subject,
          field,
          value: rawData[field],
          predicates,
        });
        predicateClaims.push(...claims);
        predicateCacheWrites.push(...cacheWrites);
        filteredData[field] = claims.length === 1 ? claims[0] : claims;
      } catch (err) {
        log.warn({ field, err: String(err) }, 'Predicate evaluation failed — rejecting');
        const rejection: BrokerRejection = {
          status: 'rejected',
          reason: 'requester_unauthorized',
          fields: [field],
          details: `Predicate evaluation failed for ${field}: ${String(err)}`,
        };
        return rejection;
      }
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
    predicateClaims,
    predicateCacheWrites,
  };
};
