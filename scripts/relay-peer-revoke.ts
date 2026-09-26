#!/usr/bin/env tsx
/**
 * scripts/relay-peer-revoke.ts
 *
 * Operator script: revokes a DFOS peer DID's admission for
 * `Authorization: DFOS <proof>` relay writes (#2132). Marks every live
 * `relay.peer` attestation this node has issued for the DID as revoked.
 * The next `isRelayPeerAttested` check re-queries the DB within
 * `RELAY_PEER_ATTESTATION_CACHE_TTL_MS` (30s) of the revoke landing, so the
 * peer's next write attempt is denied with 403 `peer_not_attested` well
 * within that window — see apps/kernel/src/lib/registry/relay/peer-attestations.ts.
 *
 * Run against the SAME database the target kernel process uses.
 *
 * Usage (from repo root):
 *   npx tsx scripts/relay-peer-revoke.ts <peerDid>
 *
 * Example:
 *   npx tsx scripts/relay-peer-revoke.ts did:dfos:cnnnft9f8a2rn938d6nkz38r847v2kr
 *
 * Required env vars (same as the target kernel process):
 *   DATABASE_URL — postgres connection string
 *
 * To re-admit later, see scripts/relay-peer-admit.ts.
 */
import { revokeRelayPeer } from '../apps/kernel/src/lib/registry/relay/peer-attestations.js';

async function main(): Promise<void> {
  const [peerDid] = process.argv.slice(2);
  if (!peerDid?.startsWith('did:dfos:')) {
    console.error('Usage: npx tsx scripts/relay-peer-revoke.ts <peerDid>');
    console.error('  <peerDid> must be a did:dfos:* identifier (the peer\'s DFOS DID).');
    process.exit(1);
    return;
  }

  console.log(`Revoking relay-write admission for DFOS peer ${peerDid}...`);

  const result = await revokeRelayPeer(peerDid);
  if (!result.ok) {
    console.error(`Failed: ${result.error ?? 'unknown error'}`);
    process.exit(1);
    return;
  }

  console.log(`Done. Revoked ${result.revokedCount} live relay.peer attestation(s) for ${peerDid}.`);
  if (result.revokedCount === 0) {
    console.log('(This DID had no live admission — nothing to do.)');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
