/**
 * Facts whose authority comes from a dedicated kernel ceremony, not arbitrary
 * signatures or possession of the shared internal API key. Keep this gate
 * independent of vocabulary/registry membership: registering a type cannot
 * authorize minting it.
 */
export function ceremonyAttestationRejection(type: string): string | null {
  if (type === 'key.rotated') return `Attestation type "${type}" is node-issued only`;
  if (type === 'connection.relationship.label.changed') {
    return `Attestation type "${type}" requires the connection relationship ceremony`;
  }
  if (type === 'domain.verified' || type === 'domain.revoked') {
    return `Attestation type "${type}" requires the verified domain ceremony`;
  }
  return null;
}
