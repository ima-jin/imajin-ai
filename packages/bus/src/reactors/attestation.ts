import { emitAttestation } from '@imajin/auth';
import type { BusEvent, ReactorHandler } from '../types';

export const attestationReactor: ReactorHandler = async (event, config) => {
  const attestationType = (config.attestationType as string) || event.type;

  await emitAttestation({
    issuer_did: event.issuer,
    subject_did: event.subject,
    type: attestationType,
    context_id: (event.payload?.context_id as string) || event.subject,
    context_type: (event.payload?.context_type as string) || 'general',
    payload: event.payload,
  });
};
