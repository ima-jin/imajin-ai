#!/usr/bin/env node
/**
 * Generate a persistent relay identity for DFOS 0.5.0
 * Outputs RELAY_DID and RELAY_PROFILE_JWS for .env.local
 */
import {
  createNewEd25519Keypair,
  signPayloadEd25519,
  generateId,
} from '@metalabel/dfos-protocol';
import {
  signIdentityOperation,
  signArtifact,
  deriveChainIdentifier,
  encodeEd25519Multikey,
} from '@metalabel/dfos-protocol/chain';

async function main() {
  // Generate keypair
  const keypair = await createNewEd25519Keypair();
  const multikey = encodeEd25519Multikey(keypair.publicKey);
  const keyId = `key_${generateId()}`;

  // Create signer
  const signer = (data) => signPayloadEd25519(data, keypair.privateKey);

  // Create genesis identity operation
  const genesisOp = {
    version: 1,
    type: 'create',
    publicKeys: [{ id: keyId, type: 'Multikey', publicKeyMultibase: multikey }],
    createdAt: new Date().toISOString(),
  };

  const { jwsToken: genesisJws, operationCID } = await signIdentityOperation({
    operation: genesisOp,
    signer,
    keyId,
  });

  // Derive DID from genesis
  const did = deriveChainIdentifier(operationCID);

  // Sign profile artifact
  const { jwsToken: profileJws } = await signArtifact({
    payload: {
      version: 1,
      type: 'artifact',
      did,
      content: {
        '$schema': 'https://schemas.dfos.com/profile/v1',
        name: 'Imajin Registry Relay',
      },
      createdAt: new Date().toISOString(),
    },
    signer,
    kid: `${did}#${keyId}`,
  });

  console.log('\n=== Relay Identity Generated ===\n');
  console.log(`RELAY_DID=${did}`);
  console.log(`RELAY_PROFILE_JWS=${profileJws}`);
  console.log(`\n# Genesis JWS (submit to relay on first boot):`);
  console.log(`# ${genesisJws}`);
  console.log(`\n# Private key (base64, KEEP SECRET):`);
  console.log(`# ${Buffer.from(keypair.privateKey).toString('base64')}`);
  console.log(`\n# Public key multibase: ${multikey}`);
  console.log(`# Key ID: ${keyId}`);
}

main().catch(console.error);
