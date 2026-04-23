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
  'attestation.created': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'group.created': [
    { type: 'attestation', config: { attestationType: 'group.created' }, enabled: true },
  ],
  'group.controller.added': [
    { type: 'attestation', config: { attestationType: 'group.member.added' }, enabled: true },
  ],
  'group.controller.removed': [
    { type: 'attestation', config: { attestationType: 'group.member.removed' }, enabled: true },
  ],
  'session.created': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'session.destroyed': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'scope.onboard': [
    { type: 'attestation', config: { attestationType: 'scope.onboard' }, enabled: true },
  ],
  'message.send': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'conversation.create': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'group.member.left': [
    { type: 'attestation', config: { attestationType: 'group.member.left' }, enabled: true },
  ],
  'group.member.removed': [
    { type: 'attestation', config: { attestationType: 'group.member.removed' }, enabled: true },
  ],
  'group.member.added': [
    { type: 'attestation', config: { attestationType: 'group.member.added' }, enabled: true },
  ],
  'chat.mention': [
    { type: 'notify', config: { scope: 'chat:mention' }, enabled: true },
  ],
  'connection.disconnect': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'pod.member.added': [
    { type: 'attestation', config: { attestationType: 'pod.member.added' }, enabled: true },
  ],
  'pod.role.changed': [
    { type: 'attestation', config: { attestationType: 'pod.role.changed' }, enabled: true },
  ],
  'pod.member.removed': [
    { type: 'attestation', config: { attestationType: 'pod.member.removed' }, enabled: true },
  ],
  'pod.created': [
    { type: 'attestation', config: { attestationType: 'pod.created' }, enabled: true },
  ],
  'connection.invited': [
    { type: 'attestation', config: { attestationType: 'connection.invited' }, enabled: true },
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
