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
  'identity.verified.hard': [
    { type: 'attestation', config: { attestationType: 'identity.verified.hard' }, enabled: true },
  ],
  'identity.verified.steward': [
    { type: 'attestation', config: { attestationType: 'identity.verified.steward' }, enabled: true },
  ],
  'identity.verified.operator': [
    { type: 'attestation', config: { attestationType: 'identity.verified.operator' }, enabled: true },
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
    { type: 'notify', config: { scope: 'coffee:tip' }, enabled: true },
  ],
  'tip.sent': [
    { type: 'notify', config: { scope: 'coffee:tip-sent' }, enabled: true },
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
  'payment.refund': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'payment.charge': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'fee.record': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'fee.rebate': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'fee.surcharge': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'customer': [
    { type: 'attestation', config: { attestationType: 'customer' }, enabled: true },
  ],
  'transaction.settled': [
    { type: 'attestation', config: { attestationType: 'transaction.settled' }, enabled: true },
  ],
  'handle.claimed': [
    { type: 'attestation', config: { attestationType: 'handle.claimed' }, enabled: true },
  ],
  'profile.update': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'stub.created': [
    { type: 'attestation', config: { attestationType: 'stub.created' }, enabled: true },
  ],
  'bump.confirm': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'connection.create': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'bump.match': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'app.register': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'market.sale': [
    { type: 'notify', config: { scope: 'market:sale' }, enabled: true },
  ],
  'market.purchase': [
    { type: 'notify', config: { scope: 'market:purchase' }, enabled: true },
  ],
  'event.create': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'event.update': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'checkin.create': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'event.created': [
    { type: 'attestation', config: { attestationType: 'event.created' }, enabled: true },
  ],
  'event.attendance': [
    { type: 'attestation', config: { attestationType: 'event.attendance' }, enabled: true },
  ],
  'event.registration': [
    { type: 'notify', config: { scope: 'event:registration' }, enabled: true },
  ],
  'event.rsvp': [
    { type: 'notify', config: {}, enabled: true },
  ],
  'ticket.purchase': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'learn.enrolled': [
    { type: 'attestation', config: { attestationType: 'learn.enrolled' }, enabled: true },
  ],
  'learn.completed': [
    { type: 'attestation', config: { attestationType: 'learn.completed' }, enabled: true },
  ],
  'listing.purchase': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'listing.update': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'listing.create': [
    { type: 'emit', config: {}, enabled: true },
  ],
  'listing.created': [
    { type: 'attestation', config: { attestationType: 'listing.created' }, enabled: true },
    { type: 'notify', config: {}, enabled: true },
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
