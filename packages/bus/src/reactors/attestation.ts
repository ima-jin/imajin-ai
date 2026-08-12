import { emitAttestation } from '@imajin/auth';
import type { ReactorHandler } from '../types';

/**
 * `config.pending` (#1820): set on the `attestation` reactor's `bus_chain_configs`
 * row (or the `DEFAULTS` fallback in `config.ts`) for event types that create a
 * bilateral, counterparty-signable attestation — currently only `supply.received`.
 * Threaded through to `emitAttestation()`'s `pending` param, which the internal
 * route publishes as `attestation.created`'s `pendingSignature`. Defaults to
 * false so the many one-shot attestation types configured here (identity,
 * vouch, ticket receipts, etc.) never trigger a counterparty notification.
 */
export const attestationReactor: ReactorHandler = async (event, config) => {
  const attestationType = (config.attestationType as string) || event.type;
  const originUrl = typeof event.payload?.originUrl === 'string' ? event.payload.originUrl : undefined;

  await emitAttestation({
    issuer_did: event.issuer,
    subject_did: event.subject,
    type: attestationType,
    context_id: (event.payload?.context_id as string) || event.subject,
    context_type: (event.payload?.context_type as string) || 'general',
    payload: event.payload,
    pending: config.pending === true,
    originUrl,
  });
};
