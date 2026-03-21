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
import { createSigner } from './signer';

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

/**
 * Create a DFOS identity chain UPDATE operation.
 * Used for key rotation and role separation.
 *
 * Must be signed by a current controller key. The update replaces ALL key
 * roles with the provided configuration (not additive — full replacement).
 */
export async function updateIdentityChain(input: {
  /** Hex private key of a current controller key */
  controllerPrivateKeyHex: string;
  /** The DID of the chain being updated (did:dfos:...) */
  did: string;
  /** The key ID of the controller key signing this update */
  signingKeyId: string;
  /** Current chain log */
  existingLog: string[];
  /** Current head CID (previousOperationCID for the update) */
  headCid: string;
  /** New key configuration — full replacement */
  newKeys: {
    authKeys: Array<{ id: string; publicKeyHex: string }>;
    assertKeys: Array<{ id: string; publicKeyHex: string }>;
    controllerKeys: Array<{ id: string; publicKeyHex: string }>;
  };
}): Promise<{
  log: string[];
  operationCID: string;
}> {
  // Convert all hex keys to multibase Multikey format
  const toMultikey = (keys: Array<{ id: string; publicKeyHex: string }>) =>
    keys.map(k => ({
      id: k.id,
      type: 'Multikey' as const,
      publicKeyMultibase: encodeEd25519Multikey(hexToBytes(k.publicKeyHex)),
    }));

  const operation: IdentityOperation = {
    version: 1,
    type: 'update',
    previousOperationCID: input.headCid,
    authKeys: toMultikey(input.newKeys.authKeys),
    assertKeys: toMultikey(input.newKeys.assertKeys),
    controllerKeys: toMultikey(input.newKeys.controllerKeys),
    createdAt: new Date().toISOString(),
  };

  const signer = createSigner(input.controllerPrivateKeyHex);

  const { jwsToken, operationCID } = await signIdentityOperation({
    operation,
    signer,
    keyId: input.signingKeyId,
    identityDID: input.did,
  });

  const updatedLog = [...input.existingLog, jwsToken];

  // Verify the updated chain to ensure validity
  await verifyIdentityChain({
    didPrefix: DFOS_DID_PREFIX,
    log: updatedLog,
  });

  return {
    log: updatedLog,
    operationCID,
  };
}
