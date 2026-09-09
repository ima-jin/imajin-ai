import { createLogger } from '@imajin/logger';
import type {
  BrokerFieldReleaseMode,
  BrokerPredicateClaim,
  BrokerRejection,
  BrokerReactor,
  BrokerPipelineState,
} from '../types';
import { resolveBrokerPredicateClaimsForField } from '../predicate-claims';

const log = createLogger('bus:broker:scope');

type BrokerRequest = BrokerPipelineState['request'];

function buildNoConsentRejection(fields: string[], details: string): BrokerRejection {
  return {
    status: 'rejected',
    reason: 'no_consent',
    fields,
    details,
  };
}

function buildUnauthorizedRejection(field: string, err: unknown): BrokerRejection {
  return {
    status: 'rejected',
    reason: 'requester_unauthorized',
    fields: [field],
    details: `Predicate evaluation failed for ${field}: ${String(err)}`,
  };
}

function computeConsentedIntersection(request: BrokerRequest, allowedFields: string[]): string[] {
  const allowedFieldSet = new Set(allowedFields);
  return request.fields.filter((f) => allowedFieldSet.has(f));
}

function resolveFieldMode(
  field: string,
  fieldGrants: BrokerPipelineState['fieldGrants'],
  stateMode: BrokerPipelineState['mode']
): BrokerFieldReleaseMode {
  const grant = fieldGrants?.[field];
  if (grant) return grant.mode;
  return stateMode === 'raw' ? 'raw' : 'attestation';
}

type FieldResolution =
  | { kind: 'missing' }
  | { kind: 'rejected'; rejection: BrokerRejection }
  | { kind: 'resolved'; value: unknown; claims: BrokerPredicateClaim[]; cacheWrites: BrokerPredicateClaim[] };

async function resolveField(
  field: string,
  rawData: Record<string, unknown>,
  request: BrokerRequest,
  fieldGrants: BrokerPipelineState['fieldGrants'],
  stateMode: BrokerPipelineState['mode']
): Promise<FieldResolution> {
  if (!(field in rawData)) {
    return { kind: 'missing' };
  }

  const fieldMode = resolveFieldMode(field, fieldGrants, stateMode);
  if (fieldMode === 'raw') {
    return { kind: 'resolved', value: rawData[field], claims: [], cacheWrites: [] };
  }

  const predicates = request.predicates?.[field];
  if (!predicates) {
    return { kind: 'resolved', value: { attested: true }, claims: [], cacheWrites: [] };
  }

  try {
    const { claims, cacheWrites } = await resolveBrokerPredicateClaimsForField({
      subject: request.subject,
      field,
      value: rawData[field],
      predicates,
    });
    return {
      kind: 'resolved',
      value: claims.length === 1 ? claims[0] : claims,
      claims,
      cacheWrites,
    };
  } catch (err) {
    log.warn({ field, err: String(err) }, 'Predicate evaluation failed — rejecting');
    return { kind: 'rejected', rejection: buildUnauthorizedRejection(field, err) };
  }
}

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
    return buildNoConsentRejection(request.fields, 'Consent not resolved before scope reactor');
  }

  const intersection = computeConsentedIntersection(request, allowedFields);

  if (intersection.length === 0) {
    log.warn(
      { requested: request.fields, allowed: allowedFields },
      'No requested fields are consented — rejecting'
    );
    return buildNoConsentRejection(
      request.fields,
      `None of the requested fields are consented. Allowed: [${allowedFields.join(', ')}]`
    );
  }

  // Filter data — only include consented fields that exist in the data
  const rawData = request.data || {};
  const filteredData: Record<string, unknown> = {};
  const missingFields: string[] = [];
  const predicateClaims: BrokerPredicateClaim[] = [...(state.predicateClaims ?? [])];
  const predicateCacheWrites: BrokerPredicateClaim[] = [...(state.predicateCacheWrites ?? [])];

  for (const field of intersection) {
    const resolution = await resolveField(field, rawData, request, fieldGrants, state.mode);
    if (resolution.kind === 'missing') {
      missingFields.push(field);
      continue;
    }
    if (resolution.kind === 'rejected') {
      return resolution.rejection;
    }
    filteredData[field] = resolution.value;
    predicateClaims.push(...resolution.claims);
    predicateCacheWrites.push(...resolution.cacheWrites);
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
