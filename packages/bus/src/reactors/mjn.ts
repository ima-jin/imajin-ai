import { createLogger } from '@imajin/logger';
import type { BusEvent, ReactorHandler } from '../types';

const log = createLogger('bus:mjn');

export const mjnReactor: ReactorHandler = async (event, config) => {
  // Phase 1: MJN emissions are currently handled inside the attestation internal endpoint.
  // The attestation reactor → POST /api/attestations/internal → emissions.ts
  // Phase 2: Move emission logic into this reactor for direct bus-driven emissions.

  const attestationType = (config.attestationType as string) || event.type;
  log.debug({ type: attestationType, issuer: event.issuer, subject: event.subject }, '[mjn] Emission would fire here (currently handled via attestation path)');
};
