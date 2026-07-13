import { describe, it, expect } from 'vitest';
import { ATTESTATION_TYPES } from '../src/types/attestation';

const ATTESTATION_TYPES_SET = new Set<string>(ATTESTATION_TYPES);

describe('ATTESTATION_TYPES', () => {
  it('contains github_account', () => {
    expect(ATTESTATION_TYPES_SET.has('github_account')).toBe(true);
  });

  it('contains contributor.issue.closed', () => {
    expect(ATTESTATION_TYPES_SET.has('contributor.issue.closed')).toBe(true);
  });

  it('contains contributor.pr.merged', () => {
    expect(ATTESTATION_TYPES_SET.has('contributor.pr.merged')).toBe(true);
  });

  it('contains contributor.rfc.authored', () => {
    expect(ATTESTATION_TYPES_SET.has('contributor.rfc.authored')).toBe(true);
  });

  it('contains contributor.review', () => {
    expect(ATTESTATION_TYPES_SET.has('contributor.review')).toBe(true);
  });

  it('contains contributor.design', () => {
    expect(ATTESTATION_TYPES_SET.has('contributor.design')).toBe(true);
  });

  it('preserves all pre-existing types', () => {
    const preExisting = [
      'event.attendance',
      'institution.verified',
      'vouch.given',
      'vouch.received',
      'flag.yellow',
      'flag.cleared',
      'transaction.settled',
      'customer',
      'connection.invited',
      'connection.accepted',
      'vouch',
      'session.created',
      'learn.enrolled',
      'learn.completed',
      'pod.member.added',
      'pod.member.removed',
      'pod.role.changed',
      'group.created',
      'group.member.added',
      'group.member.removed',
      'group.member.left',
      'scope.onboard',
      'identity.created',
      'identity.verified.preliminary',
      'identity.verified.hard',
      'identity.verified.steward',
      'identity.verified.operator',
      'event.created',
      'handle.claimed',
      'ticket.purchased',
      'listing.created',
      'listing.purchased',
      'tip.granted',
      'app.authorized',
      'app.revoked',
      'document.created',
      'document.signed',
      'document.executed',
      'document.declined',
      'document.amended',
    ];
    for (const type of preExisting) {
      expect(ATTESTATION_TYPES_SET.has(type), `missing pre-existing type: ${type}`).toBe(true);
    }
  });

  it('has no duplicate entries', () => {
    expect(ATTESTATION_TYPES.length).toBe(ATTESTATION_TYPES_SET.size);
  });
});
