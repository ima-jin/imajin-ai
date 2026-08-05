import { randomUUID } from 'node:crypto';
import { createLogger } from '@imajin/logger';
import { emitAttestation } from '@imajin/auth';
import type {
  BrokerFieldReleaseMode,
  BrokerPredicateClaim,
  BrokerRelease,
  BrokerReactor,
} from '../types';

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
  fieldModes: Record<string, BrokerFieldReleaseMode>,
  predicateClaims: BrokerPredicateClaim[],
  request: { requester: string; subject: string; purpose: string; scope: string }
): Promise<void> {
  try {
    const fields = Object.keys(filteredData);
    const rawFields = fields.filter((field) => fieldModes[field] === 'raw');
    const attestationFields = fields.filter((field) => fieldModes[field] === 'attestation');
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
        fields,
        fieldModes,
        rawFields,
        attestationFields,
        predicateClaims,
        consentReference: envelope.consentReference,
        consentReferences: envelope.consentReferences,
      },
    });
  } catch (err) {
    log.error(
      { err: String(err), releaseId: envelope.releaseId },
      'emitAttestation (broker.release) failed'
    );
  }
}

async function emitPredicateClaimAttestations(
  claims: BrokerPredicateClaim[],
  request: { subject: string }
): Promise<void> {
  for (const claim of claims) {
    if (claim.cached) continue;
    try {
      await emitAttestation({
        issuer_did: request.subject,
        subject_did: request.subject,
        type: 'broker.release',
        context_id: claim.cacheKey,
        context_type: 'broker.predicate',
        payload: { ...claim },
        expires_at: claim.expiresAt,
      });
    } catch (err) {
      log.error(
        { err: String(err), cacheKey: claim.cacheKey },
        'emitAttestation (broker.predicate) failed'
      );
    }
  }
}

function fieldModesForState(
  fields: string[],
  state: Parameters<BrokerReactor>[0]
): Record<string, BrokerFieldReleaseMode> {
  const fieldModes: Record<string, BrokerFieldReleaseMode> = {};
  for (const field of fields) {
    fieldModes[field] = state.fieldGrants?.[field]?.mode ?? (state.mode === 'raw' ? 'raw' : 'attestation');
  }
  return fieldModes;
}

function consentReferencesForState(
  fields: string[],
  state: Parameters<BrokerReactor>[0]
): Record<string, string> {
  const consentReferences: Record<string, string> = {};
  for (const field of fields) {
    consentReferences[field] = state.fieldGrants?.[field]?.consentReference ?? state.consentReference ?? '';
  }
  return consentReferences;
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

  const fields = Object.keys(filteredData);
  const fieldModes = fieldModesForState(fields, state);
  const consentReferences = consentReferencesForState(fields, state);
  const predicateClaims = state.predicateClaims ?? [];
  const envelope: BrokerRelease['envelope'] = {
    releaseId: randomUUID(),
    scopeId: request.scope,
    purpose: request.purpose,
    issuedAt: new Date().toISOString(),
    consentReference,
    mode,
    fieldModes,
    consentReferences,
  };

  log.info(
    { releaseId: envelope.releaseId, mode, fields },
    'Release envelope constructed'
  );
  if (Object.values(fieldModes).includes('attestation')) {
    // Persist only the freshly evaluated primitives (#1514/#1515): a composed
    // `overlaps` claim is returned to the requester but never cached, while the
    // `contains` primitives it decomposed into become the shared warm set.
    await emitPredicateClaimAttestations(state.predicateCacheWrites ?? [], request);
    await emitReleaseAttestation(envelope, filteredData, fieldModes, predicateClaims, request);
  }

  return {
    ...state,
    envelope,
  };
};
