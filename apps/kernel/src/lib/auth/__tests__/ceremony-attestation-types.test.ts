import { expect, it } from 'vitest';
import { ceremonyAttestationRejection } from '../ceremony-attestation-types';

it.each([
  'agreement', 'agreement.revoked',
  'cloudflare.mutation', 'domain.verified', 'domain.revoked', 'key.rotated', 'connection.relationship.label.changed',
  'delegation.grant.issued', 'delegation.grant.renewed', 'delegation.grant.revoked',
  'delegation.grant.capability_added', 'delegation.grant.capability_revoked',
])('requires the dedicated ceremony for %s', (type) => {
  expect(ceremonyAttestationRejection(type)).toContain(type);
});
it.each(['vouch', 'identity.created', 'acme/domain.verified', 'acme/domain.revoked'])('leaves ordinary/namespaced %s unchanged', (type) => {
  expect(ceremonyAttestationRejection(type)).toBeNull();
});
