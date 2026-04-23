import { createLogger } from '@imajin/logger';
import type { BusEvent, ReactorHandler } from '../types';

const log = createLogger('bus:dfos');

export const dfosReactor: ReactorHandler = async (event, config) => {
  // Phase 1: log intent. Chain writes happen through the attestation reactor → attestation internal endpoint → chain append.
  // Phase 2: direct chain append via @imajin/dfos bridge
  const enabled = config.directChainWrite as boolean ?? false;

  if (!enabled) {
    log.debug({ type: event.type, issuer: event.issuer }, '[dfos] Chain write configured but deferred to attestation path');
    return;
  }

  // Future: direct DFOS chain append
  // const { createIdentityChain, updateIdentityChain } = await import('@imajin/dfos');
  log.info({ type: event.type, issuer: event.issuer, subject: event.subject }, '[dfos] Chain entry would be written here');
};
