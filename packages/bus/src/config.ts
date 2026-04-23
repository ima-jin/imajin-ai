import type { ReactorConfig, ChainConfig } from './types';

// Hardcoded defaults for Phase 1
// DB-backed config is Phase 2 (future work order)
const DEFAULTS: Record<string, ReactorConfig[]> = {
  'identity.created': [
    { type: 'attestation', config: { attestationType: 'identity.created' }, enabled: true },
    { type: 'emit', config: {}, enabled: true },
  ],
  'identity.verified.preliminary': [
    { type: 'attestation', config: { attestationType: 'identity.verified.preliminary' }, enabled: true },
  ],
  'connection.accepted': [
    { type: 'attestation', config: { attestationType: 'connection.accepted' }, enabled: true },
    { type: 'notify', config: { template: 'invite_accepted' }, enabled: true },
  ],
  'vouch': [
    { type: 'attestation', config: { attestationType: 'vouch' }, enabled: true },
  ],
  'tip.granted': [
    { type: 'attestation', config: { attestationType: 'tip.granted' }, enabled: true },
  ],
  'ticket.purchased': [
    { type: 'attestation', config: { attestationType: 'ticket.purchased' }, enabled: true },
    { type: 'notify', config: { scope: 'event:ticket' }, enabled: true },
  ],
  'order.completed': [
    { type: 'settle', config: {}, await: true, enabled: true },
  ],
  'listing.purchased': [
    { type: 'attestation', config: { attestationType: 'listing.purchased' }, enabled: true },
    { type: 'settle', config: {}, await: true, enabled: true },
    { type: 'notify', config: { scope: 'market:purchase' }, enabled: true },
  ],
};

export function getChainConfig(eventType: string, _scope: string): ChainConfig {
  const reactors = DEFAULTS[eventType] || [];
  return {
    eventType,
    scope: null,
    reactors,
  };
}
