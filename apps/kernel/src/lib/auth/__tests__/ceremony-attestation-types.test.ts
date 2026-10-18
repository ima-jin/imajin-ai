import { expect, it } from 'vitest';
import { ceremonyAttestationRejection } from '../ceremony-attestation-types';

it.each(['domain.verified', 'domain.revoked', 'key.rotated', 'connection.relationship.label.changed'])('requires the dedicated ceremony for %s', (type) => {
  expect(ceremonyAttestationRejection(type)).toContain(type);
});
it.each(['vouch', 'identity.created', 'acme/domain.verified', 'acme/domain.revoked'])('leaves ordinary/namespaced %s unchanged', (type) => {
  expect(ceremonyAttestationRejection(type)).toBeNull();
});
