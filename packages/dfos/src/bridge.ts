/**
 * DFOS identity chain bridge.
 *
 * Creates and verifies DFOS identity chains using Imajin Ed25519 keypairs.
 */

import {
  signIdentityOperation,
  verifyIdentityChain,
  encodeEd25519Multikey,
  type IdentityOperation,
  type VerifiedIdentity,
} from '@metalabel/dfos-protocol';
import { hexToBytes } from '@imajin/auth';
import { createSigner } from './signer.js';

export { type VerifiedIdentity };

/** Standard DFOS DID prefix */
export const DFOS_DID_PREFIX = 'did:dfos';

/** Custom base32 alphabet used by DFOS for identifiers */
const DFOS_ALPHABET = '2346789acdefhknrtvz';

/** Generate a unique key ID using DFOS's 22-char custom alphabet */
function generateKeyId(): string {
  const bytes = new Uint8Array(22);
  globalThis.crypto.getRandomValues(bytes);
  let id = '';
  for (let i = 0; i < 22; i++) {
    id += DFOS_ALPHABET.charAt(bytes[i] % DFOS_ALPHABET.length);
  }
  return `key_${id}`;
}

/**
 * Create a DFOS identity chain from an Imajin Ed25519 keypair.
 *
 * Signs a genesis operation with the provided private key, verifies it
 * to derive the canonical DID, and returns the chain log.
 */
export async function createIdentityChain(input: {
  privateKeyHex: string;
  publicKeyHex: string;
}): Promise<{
  did: string;
  log: string[];
  operationCID: string;
}> {
  const keyId = generateKeyId();
  const publicKeyBytes = hexToBytes(input.publicKeyHex);
  const publicKeyMultibase = encodeEd25519Multikey(publicKeyBytes);

  const authKey = {
    id: keyId,
    type: 'Multikey' as const,
    publicKeyMultibase,
  };

  const operation: IdentityOperation = {
    version: 1,
    type: 'create',
    authKeys: [authKey],
    assertKeys: [authKey],
    controllerKeys: [authKey],
    createdAt: new Date().toISOString(),
  };

  const signer = createSigner(input.privateKeyHex);

  const { jwsToken, operationCID } = await signIdentityOperation({
    operation,
    signer,
    keyId,
  });

  // Verify our own chain to derive the canonical DID
  const verified = await verifyIdentityChain({
    didPrefix: DFOS_DID_PREFIX,
    log: [jwsToken],
  });

  return {
    did: verified.did,
    log: [jwsToken],
    operationCID,
  };
}

/**
 * Verify a DFOS identity chain log and return the resolved identity state.
 */
export async function verifyChain(log: string[]): Promise<VerifiedIdentity> {
  return verifyIdentityChain({
    didPrefix: DFOS_DID_PREFIX,
    log,
  });
}
