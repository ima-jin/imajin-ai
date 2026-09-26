#!/usr/bin/env tsx
/**
 * scripts/relay-peer-admit.ts
 *
 * Operator script: admits a DFOS peer DID for `Authorization: DFOS <proof>`
 * relay writes (#2132 ruling, 2026-09-26). Mints a `relay.peer` attestation,
 * signed by this node's own identity, for the given `did:dfos:...` DID —
 * the dark-forest admission gate `verifyDfosWrite` checks before authorizing
 * a proof-carrying write. A cryptographically valid proof alone never
 * admits; this script is the only way a peer DID becomes admitted.
 *
 * Idempotent: admitting an already-admitted DID mints a second live
 * attestation (harmless — `isRelayPeerAttested` only needs one to exist)
 * rather than erroring.
 *
 * Run against the SAME database the target kernel process uses, with that
 * kernel's own signing identity available (mints the attestation the exact
 * same in-process way the kernel itself does, via `emitMechanicalAttestation`).
 *
 * Usage (from repo root):
 *   npx tsx scripts/relay-peer-admit.ts <peerDid>
 *
 * Example:
 *   npx tsx scripts/relay-peer-admit.ts did:dfos:cnnnft9f8a2rn938d6nkz38r847v2kr
 *
 * Required env vars (same as the target kernel process):
 *   DATABASE_URL      — postgres connection string
 *   AUTH_PRIVATE_KEY  — node signing key (signs the attestation)
 *
 * To revoke admission later, see scripts/relay-peer-revoke.ts.
 */
import { admitRelayPeer } from '../apps/kernel/src/lib/registry/relay/peer-attestations.js';

async function main(): Promise<void> {
  const [peerDid] = process.argv.slice(2);
  if (!peerDid?.startsWith('did:dfos:')) {
    console.error('Usage: npx tsx scripts/relay-peer-admit.ts <peerDid>');
    console.error('  <peerDid> must be a did:dfos:* identifier (the peer\'s DFOS DID).');
    process.exit(1);
    return;
  }

  console.log(`Admitting DFOS peer ${peerDid} for relay writes (minting relay.peer attestation)...`);

  const result = await admitRelayPeer(peerDid);
  if (!result.ok) {
    console.error(`Failed: ${result.error ?? 'unknown error'}`);
    process.exit(1);
    return;
  }

  console.log(`Done. Attestation id: ${result.attestationId}`);
  console.log(`${peerDid} may now write to this relay via Authorization: DFOS <proof>.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
